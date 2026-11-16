import {randomBytes,timingSafeEqual} from 'node:crypto';

export function installAccounts({database,state,openSession,cookie,passwordHash,passwordMatches,hash,rate}){
  const get=(sql,...args)=>database.prepare(sql).get(...args),all=(sql,...args)=>database.prepare(sql).all(...args),run=(sql,...args)=>database.prepare(sql).run(...args);
  const fail=(status,message)=>{throw Object.assign(new Error(message),{status})};
  const json=(data,status=200,headers={})=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store',...headers}});
  const atomic=fn=>{database.exec('BEGIN IMMEDIATE');try{const r=fn();database.exec('COMMIT');return r}catch(e){database.exec('ROLLBACK');throw e}};
  database.exec(`CREATE TABLE IF NOT EXISTS student_profiles(user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,country TEXT NOT NULL DEFAULT '',specialty TEXT NOT NULL DEFAULT '',degree TEXT NOT NULL DEFAULT '');
    CREATE INDEX IF NOT EXISTS student_country_idx ON student_profiles(country);
    CREATE INDEX IF NOT EXISTS student_specialty_idx ON student_profiles(specialty);
    CREATE INDEX IF NOT EXISTS student_degree_idx ON student_profiles(degree);
    CREATE TABLE IF NOT EXISTS account_recovery(user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,requested INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'pending',code_hash TEXT,code_salt TEXT,expires INTEGER,attempts INTEGER NOT NULL DEFAULT 0,issued_by TEXT,phone TEXT NOT NULL DEFAULT '');
    CREATE INDEX IF NOT EXISTS recovery_status_idx ON account_recovery(status,requested);
    CREATE TABLE IF NOT EXISTS student_name_changes(user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,last_changed INTEGER NOT NULL);`);
  if(!all('PRAGMA table_info(account_recovery)').some(c=>c.name==='phone'))database.exec("ALTER TABLE account_recovery ADD COLUMN phone TEXT NOT NULL DEFAULT ''");
  const recoveryPhone=value=>{if(typeof value!=='string'||value.length>60)fail(400,'أدخل رقم الهاتف مع الرمز الدولي، مثل +962790000000.');const phone=value.normalize('NFKC').replace(/[٠-٩]/g,c=>String(c.charCodeAt(0)-0x660)).replace(/[۰-۹]/g,c=>String(c.charCodeAt(0)-0x6f0)).trim().replace(/[\s()-]/g,'').replace(/^00/,'+');if(!/^\+[1-9][0-9]{6,14}$/.test(phone))fail(400,'أدخل رقم الهاتف مع الرمز الدولي، مثل +962790000000، دون حروف.');return phone};
  const clean=(value,max=100)=>{if(typeof value!=='string'||value.length>max)fail(400,'بيانات الملف الشخصي غير صالحة أو طويلة.');return value.normalize('NFKC').trim().replace(/\s+/g,' ')};
  const emailValue=value=>{const email=clean(value,254).toLowerCase();if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))fail(400,'أدخل بريداً إلكترونياً صحيحاً.');return email};
  const validPassword=value=>typeof value==='string'&&value.length>=8&&value.length<=256;
  const admin=session=>{if(session?.user.role!=='admin')fail(403,'هذه العملية متاحة للإدارة فقط.')};
  const student=session=>{if(session?.user.role!=='student')fail(401,'سجّل الدخول بحساب طالب.');return session.user};
  const nameChangeDelay=60*86400000;
  const profileFor=id=>{const profile=get('SELECT country,specialty,degree FROM student_profiles WHERE user_id=?',id)||{country:'',specialty:'',degree:''},changed=get('SELECT last_changed FROM student_name_changes WHERE user_id=?',id);return {...profile,nameChangedAt:changed?.last_changed??null,nameChangeAvailableAt:changed?changed.last_changed+nameChangeDelay:null}};
  const stats=()=>Object.fromEntries(['country','specialty','degree'].map(key=>[key,all(`SELECT COALESCE(NULLIF(p.${key},''),'غير محدد') value,COUNT(*) count FROM users u LEFT JOIN student_profiles p ON p.user_id=u.id WHERE u.role='student' GROUP BY COALESCE(NULLIF(p.${key},''),'غير محدد') ORDER BY count DESC,value`)]));
  const extras=session=>session?.user.role==='admin'?{studentStats:stats(),recoveryRequests:all("SELECT r.user_id studentId,u.name,u.email,r.requested,r.status,r.expires,r.attempts,r.phone FROM account_recovery r JOIN users u ON u.id=r.user_id WHERE u.role='student' AND r.status IN ('pending','issued','locked') ORDER BY r.requested DESC").map(r=>({...r,status:r.status==='issued'&&r.expires<Date.now()?'expired':r.status}))}:{};
  const genericRecovery={ok:true,message:'إذا كان البريد مسجلاً فسيظهر طلبك للإدارة، وسترسل لك رمز الاستعادة على رقم الهاتف المرفق خلال 24 ساعة من تقديم الطلب بعد التحقق من هويتك. الرمز صالح لمدة 30 دقيقة من وقت إصداره ولمرة واحدة.'};
  function handle({path,method,body,session,ip,request}){
    if(method==='GET'&&path==='/api/admin/student-index'){
      admin(session);const params=new URL(request.url).searchParams,where=["u.role='student'"],args=[];
      for(const key of ['country','specialty','degree']){const value=params.get(key);if(value!==null){where.push(`COALESCE(NULLIF(p.${key},''),'غير محدد')=?`);args.push(clean(value))}}
      const q=params.get('q')?.trim();if(q){where.push('(u.name LIKE ? OR u.email LIKE ?)');args.push('%'+q.slice(0,200)+'%','%'+q.slice(0,200)+'%')}
      const students=all(`SELECT u.id,u.name,u.email,u.joined,COALESCE(p.country,'') country,COALESCE(p.specialty,'') specialty,COALESCE(p.degree,'') degree FROM users u LEFT JOIN student_profiles p ON p.user_id=u.id WHERE ${where.join(' AND ')} ORDER BY u.name,u.id`,...args);
      return json({students,stats:stats(),total:get("SELECT COUNT(*) total FROM users WHERE role='student'").total,matched:students.length});
    }
    if(method==='GET'&&path==='/api/admin/comments'){
      admin(session);const params=new URL(request.url).searchParams,status=params.get('status')||'all',page=Number(params.get('page')||1);if(!['all','pending','approved'].includes(status)||!Number.isSafeInteger(page)||page<1)fail(400,'مرشح التعليقات غير صالح.');const where=status==='all'?'':' WHERE c.status=?',args=status==='all'?[]:[status];const total=get('SELECT COUNT(*) total FROM comments c'+where,...args).total;
      const comments=all('SELECT c.id,c.article_id articleId,c.name,c.text,c.image,c.status,c.created,a.data article FROM comments c JOIN articles a ON a.id=c.article_id'+where+' ORDER BY c.created DESC,c.id LIMIT 50 OFFSET ?',...args,(page-1)*50).map(c=>{const a=JSON.parse(c.article);delete c.article;return {...c,articleTitle:a.title}});
      return json({comments,total,page,pages:Math.ceil(total/50)});
    }
    const paths=['/api/profile','/api/recovery/request','/api/recovery/reset','/api/admin/recovery/issue','/api/admin/recovery/revoke'];if(!paths.includes(path))return null;if(method!=='POST')fail(405,'طريقة غير مدعومة.');
    if(path==='/api/profile'){
      const u=student(session),name=clean(body.name,200),email=emailValue(body.email);if(name.split(/\s+/).length<4)fail(400,'أدخل الاسم الرباعي.');const profile=Object.fromEntries(['country','specialty','degree'].map(k=>[k,clean(body[k]??'')]));const password=body.password||'',emailChanged=email!==u.email,securityChange=emailChanged||!!password;
      if(password&&!validPassword(password))fail(400,'كلمة المرور الجديدة من 8 إلى 256 حرفاً.');if(password&&body.confirmPassword!==password)fail(400,'تأكيد كلمة المرور غير مطابق.');
      const row=get('SELECT * FROM users WHERE id=?',u.id);if(securityChange&&!passwordMatches(String(body.currentPassword||''),row.password_hash))fail(403,'أدخل كلمة المرور الحالية لتغيير البريد أو كلمة المرور.');const duplicate=get('SELECT id FROM users WHERE email=?',email);if(duplicate&&duplicate.id!==u.id)fail(409,'البريد مستخدم في حساب آخر.');
      return atomic(()=>{if(name!==clean(row.name,200)){const changed=get('SELECT last_changed FROM student_name_changes WHERE user_id=?',u.id);if(changed&&Date.now()<changed.last_changed+nameChangeDelay)fail(409,'يمكن تغيير الاسم مرة كل 60 يوماً. الموعد التالي: '+new Date(changed.last_changed+nameChangeDelay).toLocaleDateString('ar-JO',{timeZone:'Asia/Amman'}));run('INSERT INTO student_name_changes VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET last_changed=excluded.last_changed',u.id,Date.now())}run('UPDATE users SET name=?,email=?,password_hash=? WHERE id=?',name,email,password?passwordHash(password):row.password_hash,u.id);run('INSERT INTO student_profiles VALUES (?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET country=excluded.country,specialty=excluded.specialty,degree=excluded.degree',u.id,profile.country,profile.specialty,profile.degree);
        if(emailChanged)for(const article of all('SELECT id,data FROM articles WHERE user_id=?',u.id)){const a=JSON.parse(article.data);a.email=email;run('UPDATE articles SET data=? WHERE id=?',JSON.stringify(a),a.id)}
        const updated=get('SELECT id,email,name,role,joined FROM users WHERE id=?',u.id);if(securityChange){run('DELETE FROM sessions WHERE user_id=?',u.id);run('DELETE FROM account_recovery WHERE user_id=?',u.id);const next=openSession(updated);return json(state(next),200,{'set-cookie':cookie(next.token)})}return json(state({...session,user:updated}));});
    }
    if(path==='/api/recovery/request'){
      rate('recovery-request:'+ip,5,900000);const email=emailValue(body.email),phone=recoveryPhone(body.phone),u=get("SELECT id FROM users WHERE email=? AND role='student'",email);if(u){const old=get('SELECT * FROM account_recovery WHERE user_id=?',u.id);if(old?.status==='issued'&&old.expires>Date.now()&&old.attempts<5)run('UPDATE account_recovery SET requested=?,phone=? WHERE user_id=?',Date.now(),phone,u.id);else run("INSERT INTO account_recovery(user_id,requested,status,phone) VALUES (?,?,'pending',?) ON CONFLICT(user_id) DO UPDATE SET requested=excluded.requested,status='pending',code_hash=NULL,code_salt=NULL,expires=NULL,attempts=0,issued_by=NULL,phone=excluded.phone",u.id,Date.now(),phone)}return json(genericRecovery);
    }
    if(path==='/api/admin/recovery/issue'){
      admin(session);const u=get("SELECT id,name,email FROM users WHERE id=? AND role='student'",String(body.studentId||''));if(!u)fail(404,'الطالب غير موجود.');const code=String(body.code||'').trim().toUpperCase();if(!/^[A-Z0-9-]{8,64}$/.test(code))fail(400,'الرمز من 8 إلى 64 حرفاً إنجليزياً أو رقماً أو شرطة.');const salt=randomBytes(24).toString('hex'),expires=Date.now()+30*60000;
      run("INSERT INTO account_recovery(user_id,requested,status,code_hash,code_salt,expires,attempts,issued_by) VALUES (?,?,'issued',?,?,?,0,?) ON CONFLICT(user_id) DO UPDATE SET status='issued',code_hash=excluded.code_hash,code_salt=excluded.code_salt,expires=excluded.expires,attempts=0,issued_by=excluded.issued_by",u.id,Date.now(),hash(salt+':'+code),salt,expires,session.user.id);return json({ok:true,expires,...state(session)});
    }
    if(path==='/api/admin/recovery/revoke'){admin(session);run("UPDATE account_recovery SET status='revoked',code_hash=NULL,code_salt=NULL WHERE user_id=?",String(body.studentId||''));return json(state(session))}
    if(path==='/api/recovery/reset'){
      rate('recovery-reset:'+ip,10,900000);const email=emailValue(body.email),code=String(body.code||'').trim().toUpperCase();if(!validPassword(body.password)||body.password!==body.confirmPassword)fail(400,'أدخل كلمة مرور من 8 إلى 256 حرفاً وتأكيداً مطابقاً.');
      return atomic(()=>{const u=get("SELECT * FROM users WHERE email=? AND role='student'",email),r=u?get('SELECT * FROM account_recovery WHERE user_id=?',u.id):null;const invalid=()=>json({error:'الرمز غير صالح أو انتهت صلاحيته. تواصل مع الإدارة.'},400);if(!r||r.status!=='issued'||r.expires<Date.now()||r.attempts>=5||!r.code_hash)return invalid();const actual=hash(r.code_salt+':'+code);if(!timingSafeEqual(Buffer.from(actual),Buffer.from(r.code_hash))){run("UPDATE account_recovery SET attempts=attempts+1,status=CASE WHEN attempts+1>=5 THEN 'locked' ELSE status END WHERE user_id=?",u.id);return invalid()}
        run('UPDATE users SET password_hash=? WHERE id=?',passwordHash(body.password),u.id);run('DELETE FROM sessions WHERE user_id=?',u.id);run("UPDATE account_recovery SET status='used',code_hash=NULL,code_salt=NULL WHERE user_id=?",u.id);const next=openSession(u);return json(state(next),200,{'set-cookie':cookie(next.token)});
      });
    }
    return null;
  }
  return {profileFor,extras,handle};
}
