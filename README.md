
FROM node:24-bookworm-slim
WORKDIR /app
COPY --chown=node:node package.json backend.mjs accounts.mjs notifications.mjs permissions.mjs reports.mjs display-demo.mjs server.mjs seed.json backup.mjs ./
COPY --chown=node:node public ./public
RUN mkdir -p /data && chown node:node /data
USER node
ENV NODE_ENV=production DATABASE_PATH=/data/academy.sqlite PORT=3000
EXPOSE 3000
CMD ["node", "server.mjs"]

export function installNotifications({database}){
  database.exec(`CREATE TABLE IF NOT EXISTS notifications(id INTEGER PRIMARY KEY AUTOINCREMENT,recipient_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,event_key TEXT NOT NULL,kind TEXT NOT NULL,entity_id TEXT NOT NULL,article_id TEXT,title TEXT NOT NULL,message TEXT NOT NULL,created INTEGER NOT NULL,read_at INTEGER,UNIQUE(recipient_id,event_key));CREATE INDEX IF NOT EXISTS notification_recipient_idx ON notifications(recipient_id,read_at,id);`);
  const get=(sql,...args)=>database.prepare(sql).get(...args),all=(sql,...args)=>database.prepare(sql).all(...args),run=(sql,...args)=>database.prepare(sql).run(...args);
  const fail=(status,message)=>{throw Object.assign(new Error(message),{status})};
  const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store'}});
  const requireUser=session=>{if(!session?.user)fail(401,'سجّل الدخول لعرض إشعاراتك.');return session.user.id};
  const unread=id=>get('SELECT COUNT(*) count FROM notifications WHERE recipient_id=? AND read_at IS NULL',id).count;
  function emit({eventKey,kind,entityId,articleId=null,title,message,studentId,recipientId}){const recipients=new Set(all("SELECT id FROM users WHERE role='admin'").map(x=>x.id));if(recipientId&&get('SELECT id FROM users WHERE id=?',recipientId))recipients.add(recipientId);if(studentId&&get("SELECT id FROM users WHERE id=? AND role='student'",studentId))recipients.add(studentId);for(const id of recipients)run('INSERT OR IGNORE INTO notifications(recipient_id,event_key,kind,entity_id,article_id,title,message,created) VALUES (?,?,?,?,?,?,?,?)',id,eventKey,kind,entityId,articleId,title,message,Date.now())}
  const snapshot=session=>session?.user?{notifications:{unread:unread(session.user.id),latest:all('SELECT id,kind,entity_id entityId,article_id articleId,title,message,created,read_at readAt FROM notifications WHERE recipient_id=? ORDER BY id DESC LIMIT 20',session.user.id)}}:{};
  function handle({path,method,session,request,body={}}){
    if(path==='/api/notifications'&&method==='GET'){const id=requireUser(session),params=new URL(request.url).searchParams,page=Number(params.get('page')||1),filter=params.get('filter')||'all';if(!Number.isSafeInteger(page)||page<1||page>1000000||!['all','unread'].includes(filter))fail(400,'مرشح الإشعارات غير صالح.');const where="recipient_id=?"+(filter==='unread'?' AND read_at IS NULL':''),total=get('SELECT COUNT(*) count FROM notifications WHERE '+where,id).count;return json({items:all('SELECT id,kind,entity_id entityId,article_id articleId,title,message,created,read_at readAt FROM notifications WHERE '+where+' ORDER BY id DESC LIMIT 30 OFFSET ?',id,(page-1)*30),total,page,pages:Math.ceil(total/30),unread:unread(id)})}
    if(path==='/api/notifications/read'){const id=requireUser(session);if(method!=='POST')fail(405,'طريقة غير مدعومة.');if(body.id==='all'){if(!Number.isSafeInteger(body.beforeId)||body.beforeId<1)fail(400,'حد الإشعارات غير صالح.');run('UPDATE notifications SET read_at=? WHERE recipient_id=? AND read_at IS NULL AND id<=?',Date.now(),id,body.beforeId)}else{if(!Number.isSafeInteger(body.id)||!get('SELECT id FROM notifications WHERE id=? AND recipient_id=?',body.id,id))fail(404,'الإشعار غير موجود.');run('UPDATE notifications SET read_at=COALESCE(read_at,?) WHERE id=? AND recipient_id=?',Date.now(),body.id,id)}return json({ok:true,...snapshot(session)})}
    return null;
  }
  return {emit,snapshot,handle};
}

{"name":"maliki-college","version":"2.0.0","private":true,"type":"module","description":"Arabic academy with one shared SQLite database for web and Android","engines":{"node":">=22.16.0"},"scripts":{"start":"node --env-file-if-exists=.env server.mjs","test":"node --test test/*.test.mjs","backup":"node --env-file-if-exists=.env backup.mjs"}}

import {randomUUID,createHash} from 'node:crypto';
export function installPermissions({database,content,state,openSession,cookie,passwordHash,passwordMatches,rate}){
 const get=(sql,...a)=>database.prepare(sql).get(...a),all=(sql,...a)=>database.prepare(sql).all(...a),run=(sql,...a)=>database.prepare(sql).run(...a),fail=(s,m)=>{throw Object.assign(new Error(m),{status:s})},json=(d,s=200,h={})=>new Response(JSON.stringify(d),{status:s,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store',...h}}),hash=s=>createHash('sha256').update(s).digest('hex');
 database.exec(`CREATE TABLE IF NOT EXISTS staff_accounts(user_id TEXT PRIMARY KEY REFERENCES users(id),login_name TEXT UNIQUE NOT NULL,permissions TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 1);CREATE TABLE IF NOT EXISTS course_owners(course_id INTEGER PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id));CREATE TABLE IF NOT EXISTS course_certificates(course_id INTEGER PRIMARY KEY,data TEXT NOT NULL,version TEXT NOT NULL);CREATE TABLE IF NOT EXISTS certificate_versions(version TEXT PRIMARY KEY,data TEXT NOT NULL);CREATE TABLE IF NOT EXISTS staff_messages(id TEXT PRIMARY KEY,sender_id TEXT NOT NULL REFERENCES users(id),payload TEXT NOT NULL,created INTEGER NOT NULL);CREATE TABLE IF NOT EXISTS course_messages(id TEXT PRIMARY KEY,course_id INTEGER NOT NULL,sender_id TEXT NOT NULL REFERENCES users(id),payload TEXT NOT NULL,created INTEGER NOT NULL);CREATE TABLE IF NOT EXISTS student_admin_messages(id TEXT PRIMARY KEY,student_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,title TEXT NOT NULL,message TEXT NOT NULL,created INTEGER NOT NULL,read_at INTEGER);`);
 const superAdmin=s=>s?.user.role==='admin',manager=s=>['admin','staff'].includes(s?.user.role),requireSuper=s=>{if(!superAdmin(s))fail(403,'هذه العملية للإدارة الرئيسية فقط.')},staff=id=>get('SELECT * FROM staff_accounts WHERE user_id=?',id),rights=s=>s?.user.role==='staff'?JSON.parse(staff(s.user.id)?.permissions||'{}'):{};
 const allowed=s=>superAdmin(s)?content().courses.map(c=>c.id):s?.user.role==='staff'&&staff(s.user.id)?.enabled?[...new Set([...(rights(s).courseIds||[]),...all('SELECT course_id FROM course_owners WHERE user_id=?',s.user.id).map(r=>r.course_id)])].filter(id=>content().courses.some(c=>c.id===id)):[];
 function requireManager(s){if(!manager(s)||s.user.role==='staff'&&!staff(s.user.id)?.enabled)fail(403,'سجّل الدخول بحساب إدارة مفعل.')}
 function requireCourse(s,id){requireManager(s);if(!allowed(s).includes(Number(id)))fail(403,'ليس لديك صلاحية لهذه الدورة.')}
 const canDelete=(s,id)=>superAdmin(s)||!!rights(s).deleteOwnCourses&&get('SELECT user_id FROM course_owners WHERE course_id=?',id)?.user_id===s?.user.id;
 const certificateRecord=id=>get('SELECT version FROM course_certificates WHERE course_id=?',id),ready=id=>!!certificateRecord(id),published=c=>!c.hidden&&ready(c.id),auth=s=>s?.user.role==='staff'?{permissions:{...rights(s),courseIds:allowed(s),deleteCourseIds:allowed(s).filter(id=>canDelete(s,id))}}:{};
 function canReview(s){return superAdmin(s)||s?.user.role==='staff'&&!!rights(s).reviewArticles&&!!staff(s.user.id)?.enabled}
 function requireReviewer(s,body){requireManager(s);if(!canReview(s)||!superAdmin(s)&&(body.action||!['approved','rejected'].includes(body.status)))fail(403,'صلاحية مراجعة المقالات غير متاحة لهذا الإجراء.')}
 function mergeStaff(incoming,old,s){requireManager(s);if(superAdmin(s))return incoming;if(!incoming||!Array.isArray(incoming.courses))fail(400,'بيانات الدورات غير صالحة.');for(const key of Object.keys(incoming))if(!['courses','seq','prefixHistory'].includes(key)&&JSON.stringify(incoming[key])!==JSON.stringify(old[key]))fail(403,'لا يمكنك تعديل إعدادات المنصة أو محتوى غير الدورات المسموحة.');const ids=allowed(s),seen=new Set(),newIds=[],updated=[];for(const c of incoming.courses){if(seen.has(c.id))fail(400,'دورة مكررة.');seen.add(c.id);const before=old.courses.find(x=>x.id===c.id);if(before){requireCourse(s,c.id);const previousPrefix=String(before.prefix||before.code?.split('-')[0]||'').toUpperCase(),nextPrefix=String(c.prefix||c.code?.split('-')[0]||'').toUpperCase();if(previousPrefix!==nextPrefix)fail(403,'لا يمكن تغيير رمز الدورة بعد حفظه؛ يقتصر ذلك على الإدارة الرئيسية.')}else{if(!rights(s).createCourses)fail(403,'لا تملك صلاحية إضافة دورة.');newIds.push(c.id)}updated.push(c)}let sequence=old.seq||0;for(const id of newIds.sort((a,b)=>a-b))if(id!==++sequence)fail(409,'تغير تسلسل الدورات. أعد التحميل.');for(const c of old.courses)if(ids.includes(c.id)&&!seen.has(c.id)&&!canDelete(s,c.id))fail(403,'يمكنك حذف الدورات التي أضفتها فقط وبصلاحية الحذف.');return {...old,courses:[...old.courses.filter(c=>!ids.includes(c.id)||seen.has(c.id)).map(c=>updated.find(n=>n.id===c.id)||c),...updated.filter(c=>!old.courses.some(n=>n.id===c.id))],seq:sequence,prefixHistory:old.prefixHistory}}
 function afterContent(old,data,s){for(const c of data.courses)if(!old.courses.some(x=>x.id===c.id)&&s.user.role==='staff')run('INSERT INTO course_owners VALUES (?,?)',c.id,s.user.id);for(const c of old.courses)if(!data.courses.some(x=>x.id===c.id)){run('DELETE FROM course_owners WHERE course_id=?',c.id);run('DELETE FROM course_certificates WHERE course_id=?',c.id)}}
 const layoutKeys=['template','nameX','nameY','gradeX','gradeY','dateX','dateY','verificationX','verificationY','nameFontSize','gradeFontSize','dateFontSize','verificationFontSize'];
 function validateLayout(input){if(!input||typeof input!=='object'||Array.isArray(input))fail(400,'قالب الشهادة مطلوب.');const match=/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(input.template||'');if(!match)fail(400,'ارفع صورة شهادة PNG أو JPG أو WebP خاصة بالدورة.');const bytes=Buffer.from(match[2],'base64');if(bytes.length>5*1048576)fail(413,'قالب الشهادة حتى 5 ميغابايت.');const valid=match[1]==='png'?bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])):match[1]==='jpeg'?bytes[0]===255&&bytes[1]===216&&bytes[2]===255:bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP';if(!valid)fail(400,'بيانات صورة الشهادة غير صالحة.');const out={template:input.template};for(const key of layoutKeys.slice(1))if(input[key]!==undefined){const n=input[key],font=key.endsWith('FontSize');if(typeof n!=='number'||!Number.isFinite(n)||n<(font?8:0)||n>(font?72:100))fail(400,'موضع أو حجم خط غير صالح.');out[key]=n}return out}
 function capture(id){const row=get('SELECT data FROM course_certificates WHERE course_id=?',id);if(!row)fail(409,'الدورة بانتظار قالب شهادة خاص بها.');const settings=content().settings,layout={};for(const key of ['platformName','logo','green','gold',...layoutKeys])if(settings[key]!==undefined)layout[key]=settings[key];Object.assign(layout,JSON.parse(row.data));const data=JSON.stringify(layout),version=hash(data);run('INSERT OR IGNORE INTO certificate_versions VALUES (?,?)',version,data);return version}
 function accountList(){const existing=new Set(content().courses.map(c=>c.id));return all("SELECT u.id,u.name,s.permissions,s.enabled FROM users u JOIN staff_accounts s ON s.user_id=u.id WHERE u.role='staff' ORDER BY u.name").map(row=>({id:row.id,name:row.name,enabled:!!row.enabled,permissions:{...JSON.parse(row.permissions),courseIds:(JSON.parse(row.permissions).courseIds||[]).filter(id=>existing.has(id))},ownedCourseIds:all('SELECT course_id FROM course_owners WHERE user_id=?',row.id).map(r=>r.course_id).filter(id=>existing.has(id))}))}
 const normalizeName=value=>String(value||'').normalize('NFKC').trim().replace(/\s+/g,' '),validPassword=p=>typeof p==='string'&&p.length>=12&&p.length<=256;
 function handle({path,method,body={},session,request,ip}){
  if(path==='/api/staff/login'){if(method!=='POST')fail(405,'طريقة غير مدعومة.');rate('staff-login:'+ip,20,900000);const name=normalizeName(body.name).toLocaleLowerCase('ar'),row=get("SELECT u.* FROM users u JOIN staff_accounts s ON s.user_id=u.id WHERE s.login_name=? AND s.enabled=1 AND u.role='staff'",name);if(!row||!passwordMatches(String(body.password||''),row.password_hash))fail(401,'الاسم أو كلمة المرور غير صحيحة.');const next=openSession(row);return json(state(next),200,{'set-cookie':cookie(next.token)})}
  if(path==='/api/admin/staff'){
   requireSuper(session);if(method==='GET')return json({accounts:accountList()});
   if(method==='DELETE'){
    if(typeof body.id!=='string'||!body.id)fail(400,'حدد الحساب المراد حذفه.');
    const account=get("SELECT u.id,u.name FROM users u JOIN staff_accounts s ON s.user_id=u.id WHERE u.id=? AND u.role='staff'",body.id);
    if(!account)fail(404,'حساب المستوى الثاني غير موجود.');
    if(body.confirmName!==account.name)fail(409,'تغير اسم الحساب. أعد فتح تأكيد الحذف.');
    run('DELETE FROM sessions WHERE user_id=?',account.id);
    run('UPDATE course_owners SET user_id=? WHERE user_id=?',session.user.id,account.id);
    run('DELETE FROM staff_accounts WHERE user_id=?',account.id);
    run("DELETE FROM users WHERE id=? AND role='staff'",account.id);
    return json({ok:true,accounts:accountList()});
   }
   if(!['POST','PUT'].includes(method))fail(405,'طريقة غير مدعومة.');const name=normalizeName(body.name);if(name.length>120||!/^[\p{L}\p{M}]+ [\p{L}\p{M}]+$/u.test(name))fail(400,'أدخل اسماً من مقطعين، مثل أحمد محمد.');const old=body.id?get("SELECT u.id FROM users u JOIN staff_accounts s ON s.user_id=u.id WHERE u.id=? AND u.role='staff'",String(body.id)):null;if(body.id&&!old)fail(404,'حساب الإدارة غير موجود.');if(!old&&!validPassword(body.password)||body.password&&!validPassword(body.password))fail(400,'كلمة المرور من 12 إلى 256 حرفاً.');const source=body.permissions;if(!source||typeof source!=='object'||Array.isArray(source)||Object.keys(source).some(k=>!['createCourses','deleteOwnCourses','reviewArticles','courseIds'].includes(k)))fail(400,'صلاحيات غير صالحة.');for(const k of ['createCourses','deleteOwnCourses','reviewArticles'])if(typeof source[k]!=='boolean')fail(400,'أكمل خيارات الصلاحيات.');if(!Array.isArray(source.courseIds)||source.courseIds.length>650||source.courseIds.some(id=>!Number.isSafeInteger(id)||!content().courses.some(c=>c.id===id)))fail(400,'اختر دورات موجودة.');if(body.enabled!==undefined&&typeof body.enabled!=='boolean')fail(400,'حالة الحساب غير صالحة.');const permissions={...source,courseIds:[...new Set(source.courseIds)]},login=name.toLocaleLowerCase('ar'),duplicate=get('SELECT user_id FROM staff_accounts WHERE login_name=?',login);if(duplicate&&duplicate.user_id!==old?.id)fail(409,'الاسم مستخدم لحساب آخر.');const id=old?.id||randomUUID();if(old){run('UPDATE users SET name=? WHERE id=?',name,id);if(body.password)run('UPDATE users SET password_hash=? WHERE id=?',passwordHash(body.password),id);run('UPDATE staff_accounts SET login_name=?,permissions=?,enabled=? WHERE user_id=?',login,JSON.stringify(permissions),body.enabled===false?0:1,id);run('DELETE FROM sessions WHERE user_id=?',id)}else{run('INSERT INTO users VALUES (?,?,?,?,?,?)',id,'staff+'+id+'@academy.internal',name,passwordHash(body.password),'staff',new Date().toISOString());run('INSERT INTO staff_accounts VALUES (?,?,?,?)',id,login,JSON.stringify(permissions),body.enabled===false?0:1)}return json({ok:true,accounts:accountList()});
  }
  if(path==='/api/student/admin-message'){
   if(method!=='POST')fail(405,'طريقة غير مدعومة.');
   if(session?.user.role!=='student')fail(401,'سجّل الدخول بحساب طالب لإرسال رسالة إلى الإدارة.');
   rate('student-admin-message:'+session.user.id,10,3600000);
   if(typeof body.requestId!=='string'||!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(body.requestId))fail(400,'معرف الرسالة غير صالح. افتح نموذج الإرسال من جديد.');
   if(typeof body.title!=='string'||!body.title.trim()||body.title.trim().length>160||typeof body.message!=='string'||!body.message.trim()||body.message.trim().length>4000)fail(400,'العنوان مطلوب حتى 160 حرفاً، والرسالة حتى 4000 حرف.');
   const title=body.title.trim(),message=body.message.trim(),existing=get('SELECT student_id,title,message FROM student_admin_messages WHERE id=?',body.requestId);
   if(existing){if(existing.student_id!==session.user.id||existing.title!==title||existing.message!==message)fail(409,'معرف الرسالة مستخدم لمحتوى آخر. افتح رسالة جديدة.');return json({ok:true,requestId:body.requestId})}
   run('INSERT INTO student_admin_messages(id,student_id,title,message,created) VALUES (?,?,?,?,?)',body.requestId,session.user.id,title,message,Date.now());
   return json({ok:true,requestId:body.requestId});
  }
  if(path==='/api/admin/student-messages'){
   requireSuper(session);
   if(method!=='GET')fail(405,'طريقة غير مدعومة.');
   const page=Number(new URL(request.url).searchParams.get('page')||1);
   if(!Number.isSafeInteger(page)||page<1||page>100000)fail(400,'رقم الصفحة غير صالح.');
   const total=get('SELECT COUNT(*) count FROM student_admin_messages').count;
   return json({messages:all('SELECT m.id,m.student_id studentId,u.name studentName,u.email studentEmail,m.title,m.message,m.created,m.read_at readAt FROM student_admin_messages m JOIN users u ON u.id=m.student_id ORDER BY m.created DESC,m.id DESC LIMIT 30 OFFSET ?', (page-1)*30),total,page,pages:Math.ceil(total/30),unread:get('SELECT COUNT(*) count FROM student_admin_messages WHERE read_at IS NULL').count});
  }
  if(path==='/api/admin/student-message-read'){
   requireSuper(session);
   if(method!=='POST')fail(405,'طريقة غير مدعومة.');
   if(typeof body.id!=='string'||!body.id)fail(400,'حدد الرسالة.');
   const result=run('UPDATE student_admin_messages SET read_at=COALESCE(read_at,?) WHERE id=?',Date.now(),body.id);
   if(!result.changes)fail(404,'الرسالة غير موجودة.');
   return json({ok:true});
  }
  if(path==='/api/admin/course-message'){
   if(method==='GET'){
    const courseId=Number(new URL(request.url).searchParams.get('courseId'));
    if(!Number.isSafeInteger(courseId)||!content().courses.some(c=>c.id===courseId))fail(400,'اختر دورة صحيحة.');
    requireCourse(session,courseId);
    const course=content().courses.find(c=>c.id===courseId);
    const students=all("SELECT u.id,u.name FROM progress p JOIN users u ON u.id=p.user_id WHERE p.course_id=? AND u.role='student' ORDER BY u.name,u.id",courseId);
    return json({courseId,courseTitle:course.title,students});
   }
   requireManager(session);
   if(method!=='POST')fail(405,'طريقة غير مدعومة.');
   const courseId=Number(body.courseId);
   if(!Number.isSafeInteger(courseId)||!content().courses.some(c=>c.id===courseId))fail(400,'اختر دورة صحيحة.');
   requireCourse(session,courseId);
   if(typeof body.requestId!=='string'||!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(body.requestId))fail(400,'معرف الرسالة غير صالح. افتح نموذج الإرسال من جديد.');
   if(typeof body.title!=='string'||!body.title.trim()||body.title.trim().length>160||typeof body.message!=='string'||!body.message.trim()||body.message.trim().length>4000)fail(400,'العنوان مطلوب حتى 160 حرفاً، والرسالة حتى 4000 حرف.');
   if(!Array.isArray(body.recipientIds)||!body.recipientIds.length||body.recipientIds.length>650||body.recipientIds.some(id=>typeof id!=='string'||!id||id.length>100))fail(400,'اختر طالباً واحداً على الأقل، وحتى 650 طالباً.');
   const recipients=[...new Set(body.recipientIds)].sort(),title=body.title.trim(),message=body.message.trim(),payload=JSON.stringify({courseId,recipients,title,message}),existing=get('SELECT sender_id,payload,course_id FROM course_messages WHERE id=?',body.requestId);
   if(existing){if(existing.sender_id!==session.user.id||existing.payload!==payload||existing.course_id!==courseId)fail(409,'معرف الرسالة مستخدم لمحتوى آخر. افتح رسالة جديدة.');return json({ok:true,delivered:recipients.length,requestId:body.requestId})}
   for(const id of recipients)if(!get("SELECT u.id FROM progress p JOIN users u ON u.id=p.user_id WHERE p.course_id=? AND u.id=? AND u.role='student'",courseId,id))fail(409,'تغيرت قائمة الطلاب أو يوجد طالب غير ملتحق بهذه الدورة. حدّث القائمة قبل الإرسال.');
   const created=Date.now();
   run('INSERT INTO course_messages VALUES (?,?,?,?,?)',body.requestId,courseId,session.user.id,payload,created);
   for(const id of recipients)run('INSERT INTO notifications(recipient_id,event_key,kind,entity_id,title,message,created) VALUES (?,?,?,?,?,?,?)',id,'course-message:'+body.requestId,'course-message',body.requestId,title,message,created);
   return json({ok:true,delivered:recipients.length,requestId:body.requestId});
  }
  if(path==='/api/admin/staff-message'){
   requireSuper(session);if(method!=='POST')fail(405,'طريقة غير مدعومة.');
   if(typeof body.requestId!=='string'||!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(body.requestId))fail(400,'معرف الرسالة غير صالح. أعد فتح نموذج الإرسال.');
   if(typeof body.title!=='string'||!body.title.trim()||body.title.trim().length>160||typeof body.message!=='string'||!body.message.trim()||body.message.trim().length>4000)fail(400,'العنوان مطلوب حتى 160 حرفاً، والرسالة حتى 4000 حرف.');
   if(!Array.isArray(body.recipientIds)||!body.recipientIds.length||body.recipientIds.length>650||body.recipientIds.some(id=>typeof id!=='string'||id.length>100))fail(400,'اختر حساباً واحداً على الأقل، وحتى 650 حساباً في الرسالة.');
   const recipients=[...new Set(body.recipientIds)].sort(),title=body.title.trim(),message=body.message.trim(),payload=JSON.stringify({recipients,title,message}),existing=get('SELECT sender_id,payload FROM staff_messages WHERE id=?',body.requestId);
   if(existing){if(existing.sender_id!==session.user.id||existing.payload!==payload)fail(409,'معرف الرسالة مستخدم لمحتوى آخر. افتح رسالة جديدة.');return json({ok:true,delivered:recipients.length,requestId:body.requestId})}
   for(const id of recipients)if(!get("SELECT u.id FROM users u JOIN staff_accounts s ON s.user_id=u.id WHERE u.id=? AND u.role='staff' AND s.enabled=1",id))fail(409,'تغيرت قائمة المستلمين أو يوجد حساب غير مفعل. حدّث القائمة قبل الإرسال.');
   const created=Date.now();run('INSERT INTO staff_messages VALUES (?,?,?,?)',body.requestId,session.user.id,payload,created);
   for(const id of recipients)run('INSERT INTO notifications(recipient_id,event_key,kind,entity_id,title,message,created) VALUES (?,?,?,?,?,?,?)',id,'staff-message:'+body.requestId,'staff-message',body.requestId,title,message,created);
   return json({ok:true,delivered:recipients.length,requestId:body.requestId});
  }
  if(path==='/api/admin/course-certificate'){
   requireSuper(session);const id=Number(method==='GET'?new URL(request.url).searchParams.get('courseId'):body.courseId);if(!Number.isSafeInteger(id)||!content().courses.some(c=>c.id===id))fail(400,'اختيار الدورة المرتبطة بالشهادة إجباري.');requireCourse(session,id);const row=get('SELECT data,version FROM course_certificates WHERE course_id=?',id);if(method==='GET')return json({courseId:id,config:row?JSON.parse(row.data):null,version:row?.version||null});if(!['POST','DELETE'].includes(method))fail(405,'طريقة غير مدعومة.');if((body.version??null)!==(row?.version||null))fail(409,'تغير قالب هذه الدورة من جلسة أخرى. أعد تحميله.');if(method==='DELETE')run('DELETE FROM course_certificates WHERE course_id=?',id);else{const layout=validateLayout(body.config),data=JSON.stringify(layout);run('INSERT INTO course_certificates VALUES (?,?,?) ON CONFLICT(course_id) DO UPDATE SET data=excluded.data,version=excluded.version',id,data,hash(data))}run('UPDATE content SET revision=revision+1 WHERE id=1');const saved=get('SELECT data,version FROM course_certificates WHERE course_id=?',id);return json({ok:true,config:saved?JSON.parse(saved.data):null,version:saved?.version||null,...state(session)});
  }
  if(path==='/api/certificates/layout'&&method==='GET'){
   const row=get('SELECT user_id,course_id,data FROM certificates WHERE id=?',new URL(request.url).searchParams.get('id')||'');if(!row)fail(404,'الشهادة غير موجودة.');if(!superAdmin(session)&&!(session?.user.role==='student'&&row.user_id===session.user.id))fail(403,'عرض الشهادات متاح للإدارة الرئيسية وصاحب الشهادة فقط.');const cert=JSON.parse(row.data);if(cert.templateVersion){const layout=get('SELECT data FROM certificate_versions WHERE version=?',cert.templateVersion);if(!layout)fail(404,'قالب الشهادة غير موجود.');return json({layout:JSON.parse(layout.data)})}return json({layout:content().settings});
  }
  return null;
 }
 return {handle,manager,superAdmin,requireManager,requireCourse,requireReviewer,canReview,allowed,canDelete,staff,ready,published,auth,mergeStaff,afterContent,capture,certificateRecord};
}

# أكاديمية الفقه المالكي — موقع وتطبيق بقاعدة بيانات واحدة

حزمة `malikicollege` معدّة لرفع المصدر إلى حساب GitHub الذي زوّدنا به المستخدم: https://github.com/malikicollege-cell . المستودع المعتمد لرفع التحديثات هو https://github.com/malikicollege-cell/maliki-academy-learning . راجع docs/GITHUB-CONNECTION-AR.md لمعرفة ملفات الخادم المشترك ونسخة الواجهة التجريبية.

## الحالة الحالية

- مصدر واجهة عربية للموقع وخادم Node.js وقاعدة SQLite مشتركة.
- حساب طالب بكلمة مرور واحدة للموقع والتطبيق، وجلسات محفوظة على الخادم.
- الإدارة والمحتوى والأخبار والمقالات والدروس والصور والمراجع في قاعدة الخادم، وتُسترجع من الجهازين.
- التصحيح وفرض التدرج وإصدار الشهادات على الخادم. لا تُرسل الإجابات الصحيحة إلى الطالب.
- تحقق عام دون تسجيل: سجل شهادة الطالب يبقى، وسجل ZZ يُحذف عند أول تحقق ناجح.
- تحديث بيانات العرض كل 5 ثوانٍ عندما لا تكون هناك استمارة أو نافذة تعديل أو اختبار مفتوح؛ تتحدث بعد انتهاء العمل أو إعادة التحميل.
- تضم الحزمة 12 دورة نموذجية متكاملة إضافة إلى الدورات الأولية.
- كود مصدر Android متصل بالخادم، وليس قاعدة بيانات منفصلة في الهاتف.

رابط التشغيل الحالي: https://maliki-academy-learning-production.up.railway.app/ . يجب توجيه التطبيق إلى خادم HTTPS نفسه ليتشارك حسابات الطلاب والبيانات. دوام التخزين على الاستضافة وبناء ملف AAB الحالي يحتاجان تحققاً مستقلاً.

يتضمن التحديث صلاحيات إدارة المستوى الثاني، وقالب شهادة إلزامياً لكل دورة حالية أو جديدة، وتنبيهات نقص بنوك الأسئلة، ومنع تكرار رمز الحرفين حتى بين الدورات المخفية، وإشعار صاحب المقال عند النشر. راجع [دليل الصلاحيات والشهادات](docs/PERMISSIONS-CERTIFICATES-AR.md).

## التشغيل على الحاسوب

المتطلبات: Node.js 22.16 أو أحدث؛ يفضّل Node.js 24. لا توجد حزم npm خارجية لتثبيتها.

1. فك الضغط وافتح مجلد `malikicollege`.
2. انسخ `.env.example` إلى `.env`.
3. ضع كلمة مرور إدارة خاصة بك في `ADMIN_PASSWORD`، بطول 12 حرفاً على الأقل. لا تستخدم الرمز القديم 00000.
4. اترك `PUBLIC_URL=http://localhost:3000` للتجربة المحلية.
5. شغّل:

```sh
npm test
npm start
```

6. افتح http://localhost:3000 . دخول الإدارة من أسفل الصفحة أو من `#admin` بكلمة المرور التي اخترتها.
7. الطالب ينشئ حساباً من بوابة الطالب، ثم يستخدم البريد وكلمة المرور نفسيهما في كل جهاز.

أنشئ `.env` بنفسك؛ لا توجد كلمة مرور إدارة حقيقية مضمّنة في المستودع. كلمة المرور البيئة تُستخدم عند إنشاء حساب الإدارة للمرة الأولى فقط، وتبقى الكلمة المعدّلة في قاعدة البيانات بعد إعادة التشغيل.

## الرفع إلى GitHub

ارفع محتويات مجلد `malikicollege` إلى مستودع تختاره في حسابك. احرص على رفع ملفات النقطة مثل `.gitignore` و`.env.example` و`.github`.

لا ترفع `.env`، ولا مجلد `data` أو نسخ قاعدة البيانات أو مفاتيح توقيع Android وكلمات مرورها. الحزمة المسلّمة لا تحتوي هذه الأسرار.

المشروع يتضمن فحوص GitHub Actions على Node.js 22 و24. GitHub يخزن الكود ويشغّل الفحوص، لكنه ليس بحد ذاته قاعدة البيانات العاملة للمستخدمين.

## الاستضافة

يمكن نشر الحزمة على خدمة تدعم Node.js طويل التشغيل مع قرص دائم، أو على VPS/Docker. **لا تعمل هذه النسخة كاملة على GitHub Pages أو استضافة HTML ثابتة فقط أو استضافة PHP دون Node.js.**

إعدادات الإنتاج:

```text
NODE_ENV=production
PUBLIC_URL=https://your-academy-domain
DATABASE_PATH=/data/academy.sqlite
ADMIN_PASSWORD=ضع-كلمة-مرور-الإدارة-الخاصة-بك
PORT=3000
TRUST_PROXY=0
```

ضع القيم الفعلية في إعدادات خدمة الاستضافة، ولا تكتبها داخل الكود. استخدم HTTPS وشغّل نسخة خادم واحدة لقاعدة SQLite. إذا كان أمام الخادم وكيل موثوق يضبط عنوان العميل، اضبط `TRUST_PROXY=1` فقط بعد ضبط الوكيل؛ لا تفعّله إذا كان بإمكان الزائر تزوير `X-Forwarded-For`.

### Docker

تتضمن الحزمة `Dockerfile` و`compose.yaml`. عدّل `.env` لرابط الإنتاج، وشغّل:

```sh
docker compose up -d --build
```

النشر بالمثال يربط الخادم بـ127.0.0.1:3000 ويحتفظ بالقاعدة في volume دائم اسمه `academy_data`. ضع أمامه وكيل HTTPS مثل Caddy أو Nginx. لا تنشر منفذ Node.js المكشوف بديلاً عن HTTPS.

### مثال خدمة تدعم Docker وقرصاً دائماً

اربط مستودع GitHub بخدمة Web Service تدعم Docker، واضبط متغيرات البيئة أعلاه، واربط قرصاً دائماً على `/data`. لا تعتمد على نظام ملفات مؤقت؛ فقد تضيع السجلات عند إعادة النشر. خدمات الأقراص الدائمة قد تكون مدفوعة. راجع سياسة الخدمة وتكلفتها قبل إنشائها.

مرجع رسمي للأقراص: https://render.com/docs/disks . لم يتم إنشاء خدمة أو اشتراك مدفوع لك.

## ربط Android

نسخة Android 2.0.0 المتصلة تستخدم نفس معرّف التطبيق ومفتاح الرفع السابقين. عند أول تشغيل أدخل رابط HTTPS الذي نشر عليه هذا المشروع. على الهاتف، `localhost` يعني الهاتف نفسه ولا يصل إلى خادم الحاسوب.

- أدخل رابط جذر الموقع، مثل `https://academy.example`، دون `/api` ودون مسار فرعي.
- استخدم رابط الخادم نفسه في الموقع والتطبيق؛ لا تستخدم الرابط القديم ذي الحفظ المحلي.
- من زر «الاتصال» يمكن مراجعة الرابط أو تغييره أو إعادة تحميل الموقع.
- تغيير عنوان الخادم لا ينقل قاعدة البيانات من استضافة لأخرى.
- المحتوى والمظهر وبيانات الطالب تأتي من الخادم. تغييرات كود الواجهة تظهر بإعادة التحميل؛ التغييرات في كود Android الأصلي تحتاج إصدار تطبيق جديد.
- الحزمة لا تحتوي مفتاح الرفع أو كلمة مروره. احتفظ بالحزمة السرية السابقة خارج GitHub.
- لم تُختبر نسخة Android المتصلة على هاتف فعلي أو خدمة HTTPS فعلية بعد.

المصدر في `android/`، ودليل البناء في `android/README.md`.

## النسخ الاحتياطي

```sh
npm run backup
```

يُنتج نسخة SQLite متسقة في `backups/`. انقل نسخة احتياطية إلى مكان آمن خارج الخادم بانتظام. تُحفظ الشهادات العادية في القاعدة ولا تُحذف بالتحقق، لكن لا يمكن ضمان بقاء البيانات عند حذف قرص الاستضافة أو فقده دون نسخ احتياطية.

## نقل النسخة المحلية السابقة

لا تنتقل تلقائياً بيانات المتصفح أو التطبيق 1.0.0، ولا كلمات الدخول المحلية، إلى هذه القاعدة الجديدة. لا تعتمد شهادات أو درجات مرسلة من جهاز طالب على أنها سجلات موثوقة. قبل الانتقال، احتفظ بالنسخة المحلية وراجع ما تريد نقله من محتوى ودورات مع الإدارة. ستحتاج حسابات الطلاب إلى إنشاء كلمات مرور جديدة على الخادم. الحزمة تبدأ بالمحتوى النموذجي في `seed.json`، وليس بالضرورة كل التعديلات التي أدخلتها على متصفحك القديم.

## حدود تحتاج استكمالاً قبل الإطلاق العام

- إرسال البريد الآلي وتأكيد ملكية البريد لم يُربطا بخدمة بريد. استعادة حساب الطالب متاحة برمز مؤقت تصدره الإدارة يدوياً، وليست برسالة بريد آلية. المراسلات الحالية تفتح برنامج البريد للمراجعة والإرسال اليدوي.
- يلزم استكمال سياسة الخصوصية العامة، وبيانات التواصل وطلبات حذف الحساب، واعتماد المحتوى الدراسي، ومتطلبات Play Console قبل الإصدار العام.
- الصور والمراجع في هذه النسخة تحفظ في القاعدة بصيغة بيانات مرفقة، بحد 1 ميغابايت لكل ملف في المحرر. عند زيادة الاستخدام يفضل نقل الملفات إلى تخزين ملفات مخصص.
- هذه الحزمة ليست نظاماً موزعاً لعدة خوادم؛ خادم واحد وقرص دائم واحد هما إعدادها المقصود.
- لا يوجد نشر فعلي أو اتصال بالخادم في التطبيق حتى توفر رابط HTTPS صالحاً لهذه الحزمة.

## الاختبارات

تشمل الفحوص جلستين للطالب نفسه، مزامنة المحتوى، صلاحيات الإدارة، منع تسريب الإجابات، التصحيح على الخادم، شرط شهادة المستوى السابق، استمرار السجلات بعد إعادة فتح قاعدة البيانات، استهلاك ZZ مرة واحدة، إبقاء الشهادة العادية، ومراجعة المقالات وإخفائها.

## صيغة رمز الشهادة

الرمز الجديد مثل `MF-2026-000001`: حرفا الدورة المحددان في الإدارة، ثم سنة إصدار الشهادة بتوقيت عمّان، ثم تسلسل عام من ست خانات يبدأ 000001. تسلسل الشهادات مستقل عن تسلسل الدورات، ولا يعاد استخدامه بعد حذف سجل تجريبي، ولا يبدأ من جديد عند تغير السنة. للتجربة تسلسل مستقل بصيغة `ZZ-2026-000001`. الشهادات السابقة تحتفظ برموزها الأصلية وتبقى قابلة للتحقق. إعادة عرض شهادة الطالب أو إعادة اجتياز الدورة لا تصدر رقماً آخر لها.

## الأقسام والمقالات والأخبار والتعليقات

تظهر الدورات بعد دخول قسمها فقط، واسم البطاقة مأخوذ من القسم نفسه. للمقالات أقسام مستقلة، مع اقتراحات أعلى الصفحة مرتبة حسب التقييم ثم عدد التقييمات والمشاهدات، وتستخدم أولوية الإدارة عند التساوي. من إدارة المقالات يمكن تغيير أولوية الاقتراح أو استبعاد المقال من الاقتراحات.

المقالات المقترحة والأخبار تعرض بالتتابع مع أزرار السابق والتالي وإيقاف التقليب. يتوقف التقليب عند التركيز داخل العارض أو مرور المؤشر، ويحترم إعداد تقليل الحركة.

لكل مقال عداد مشاهدات؛ يُحتسب القارئ مرة واحدة في اليوم على الخادم. يستطيع القارئ إرسال تعليق حتى 300 حرف وصورة PNG/JPG/WebP واحدة حتى 1 ميغابايت. التعليقات الجديدة تنشر مباشرة ويمكن للإدارة حذفها. التعليقات القديمة التي كانت قيد المراجعة لا تُنشر بأثر رجعي تلقائياً. يمكن مراجعة التعليقات أو نشرها أو حذفها من إدارة المقالات. يتم تخزين عدادات المشاهدة والتعليقات في القاعدة المشتركة، وتطبق الشروط في الخادم أيضاً.


الرئيسية المحدثة: عارض عناوين المقالات الأعلى تقييماً والأكثر مشاهدة مع روابط مباشرة، وتحته شريط أخبار متحرك بعناوين قابلة للفتح. التقييم من 1 إلى 5، وتقييم واحد لكل حساب طالب قابل للتعديل دون زيادة العدد. شريط الأخبار يتوقف عند المرور أو التركيز ويمكن إيقافه يدوياً.


## الملف الشخصي وفهرسة الطلاب واستعادة الحساب

تضم النسخة المحلية الجديدة قائمة عند اسم الطالب للوصول إلى Profile وتعديل الاسم الرباعي والبريد والبلد والتخصص والدرجة العلمية وكلمة المرور. راجع docs/PROFILE-RECOVERY-AR.md لتفاصيل الاستعادة وإحصاءات الإدارة وإدارة التعليقات. هذه الإضافات ضمن التحديث المجمع الموافق على رفعه إلى GitHub. تشغيلها على رابط عام يحتاج نشر الخادم.


## التعليقات والإشعارات وتغيير الاسم

التعليقات الجديدة تنشر مباشرة مع بقاء الحذف للإدارة. يوفّر زر الإشعارات تنبيهات داخل المنصة للتعليقات والشهادات، مع عداد غير المقروءة. تغيير اسم الطالب متاح مرة كل 60 يوماً وتفرض القاعدة على الخادم. راجع docs/NOTIFICATIONS-NAME-AR.md. هذه التغييرات ضمن التحديث المجمع الموافق على رفعه إلى GitHub؛ رفع المصدر وحده لا ينشر الخادم.

import {deflateRawSync} from 'node:zlib';
const xml=value=>String(value??'').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g,'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;');
const crcTable=Array.from({length:256},(_,n)=>{for(let i=0;i<8;i++)n=n&1?0xedb88320^(n>>>1):n>>>1;return n>>>0});
const crc32=bytes=>{let crc=0xffffffff;for(const b of bytes)crc=crcTable[(crc^b)&255]^(crc>>>8);return (crc^0xffffffff)>>>0};
function zip(files){const chunks=[],directory=[];let offset=0;for(const [path,text] of Object.entries(files)){const name=Buffer.from(path),raw=Buffer.from(text),data=deflateRawSync(raw),crc=crc32(raw),local=Buffer.alloc(30),central=Buffer.alloc(46);local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);local.writeUInt16LE(0x800,6);local.writeUInt16LE(8,8);local.writeUInt16LE(33,12);local.writeUInt32LE(crc,14);local.writeUInt32LE(data.length,18);local.writeUInt32LE(raw.length,22);local.writeUInt16LE(name.length,26);central.writeUInt32LE(0x02014b50);central.writeUInt16LE(20,4);central.writeUInt16LE(20,6);central.writeUInt16LE(0x800,8);central.writeUInt16LE(8,10);central.writeUInt16LE(33,14);central.writeUInt32LE(crc,16);central.writeUInt32LE(data.length,20);central.writeUInt32LE(raw.length,24);central.writeUInt16LE(name.length,28);central.writeUInt32LE(offset,42);chunks.push(local,name,data);directory.push(central,name);offset+=local.length+name.length+data.length}const central=Buffer.concat(directory),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(Object.keys(files).length,8);end.writeUInt16LE(Object.keys(files).length,10);end.writeUInt32LE(central.length,12);end.writeUInt32LE(offset,16);return Buffer.concat([...chunks,central,end])}
const paragraph=(value,{ltr=false,bold=false,style}={})=>`<w:p><w:pPr>${style?`<w:pStyle w:val="${style}"/>`:''}<w:bidi w:val="${ltr?0:1}"/><w:jc w:val="${ltr?'left':'right'}"/><w:spacing w:after="100"/></w:pPr><w:r><w:rPr><w:rtl w:val="${ltr?0:1}"/>${bold?'<w:b/><w:bCs/>':''}<w:lang w:val="${ltr?'en-US':'ar-JO'}" w:bidi="ar-JO"/></w:rPr><w:t xml:space="preserve">${xml(value)}</w:t></w:r></w:p>`;
export function courseReportDocx(report,academyName='أكاديمية الفقه المالكي'){
 const widths=[550,2700,3300,1800,1000,1500,1400,3148],heads=['م','الاسم','البريد الإلكتروني','الحالة','العلامة','التقدير','المحاولات','رمز الشهادة'];
 const row=(values,header=false)=>`<w:tr><w:trPr><w:cantSplit/>${header?'<w:tblHeader/>':''}</w:trPr>${values.map((v,i)=>`<w:tc><w:tcPr><w:tcW w:w="${widths[i]}" w:type="dxa"/><w:vAlign w:val="center"/>${header?'<w:shd w:fill="E5EFEC"/>':''}</w:tcPr>${paragraph(v,{ltr:!header&&[0,2,4,6,7].includes(i),bold:header})}</w:tc>`).join('')}</w:tr>`;
 const s=report.stats,date=new Date(report.generatedAt||Date.now()).toLocaleString('ar-JO',{timeZone:'Asia/Amman'}),table=`<w:tbl><w:tblPr><w:tblW w:w="15398" w:type="dxa"/><w:bidiVisual/><w:tblLayout w:type="fixed"/><w:tblBorders>${['top','left','bottom','right','insideH','insideV'].map(k=>`<w:${k} w:val="single" w:sz="4" w:color="C9D7D2"/>`).join('')}</w:tblBorders><w:tblCellMar><w:top w:w="90" w:type="dxa"/><w:left w:w="90" w:type="dxa"/><w:bottom w:w="90" w:type="dxa"/><w:right w:w="90" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tblGrid>${widths.map(w=>`<w:gridCol w:w="${w}"/>`).join('')}</w:tblGrid>${row(heads,true)}${report.students.map((u,i)=>row([i+1,u.name,u.email,u.status,u.score===null?'—':u.score+'%',u.grade,u.attempts,u.certificateId||'—'])).join('')||row(['—','لا يوجد طلاب مسجلون','','','','','',''])}</w:tbl>`;
 const ns='http://schemas.openxmlformats.org/wordprocessingml/2006/main',rel='http://schemas.openxmlformats.org/officeDocument/2006/relationships';
 const document=`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="${ns}" xmlns:r="${rel}"><w:body>${paragraph('كشف طلاب الدورة',{style:'Title',bold:true})}${paragraph(academyName)}${paragraph(report.course.title,{bold:true})}${paragraph(report.course.code,{ltr:true})}${paragraph('تاريخ استخراج الكشف '+date)}${paragraph(`الملتحقون ${s.enrolled}   المتقدمون للشامل ${s.examined}   الناجحون ${s.passed}   الراسبون ${s.failed}   متوسط العلامات ${s.average===null?'—':s.average+'%'}`)}${paragraph('يعرض الكشف آخر نتيجة لكل طالب أو علامة شهادة الاجتياز ولا يشمل بيانات طلاب الدورات الأخرى.')}${table}<w:p/><w:sectPr><w:footerReference w:type="default" r:id="rFooter"/><w:pgSz w:w="16838" w:h="11906" w:orient="landscape"/><w:pgMar w:top="720" w:right="720" w:bottom="720" w:left="720" w:header="300" w:footer="300"/><w:bidi/></w:sectPr></w:body></w:document>`;
 return zip({'[Content_Types].xml':`<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/></Types>`,
 '_rels/.rels':`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rDocument" Type="${rel}/officeDocument" Target="word/document.xml"/></Relationships>`,
 'word/document.xml':document,
 'word/_rels/document.xml.rels':`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rStyles" Type="${rel}/styles" Target="styles.xml"/><Relationship Id="rFooter" Type="${rel}/footer" Target="footer1.xml"/></Relationships>`,
 'word/styles.xml':`<?xml version="1.0"?><w:styles xmlns:w="${ns}"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:bCs/><w:color w:val="000000"/><w:sz w:val="36"/><w:szCs w:val="36"/></w:rPr></w:style></w:styles>`,
 'word/footer1.xml':`<?xml version="1.0"?><w:ftr xmlns:w="${ns}"><w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:t xml:space="preserve">صفحة </w:t></w:r><w:fldSimple w:instr="PAGE"/></w:p></w:ftr>`});
}

{
  "sections": [
    "الفقه المالكي",
    "الحديث الشريف",
    "أصول الفقه",
    "اللغة العربية"
  ],
  "articleSections": [
    "فقه وتأصيل",
    "دراسات شرعية",
    "آداب طالب العلم"
  ],
  "courses": [
    {
      "id": 1,
      "title": "مدخل إلى الفقه المالكي",
      "book": "متن الأخضري",
      "author": "عبد الرحمن الأخضري",
      "teacher": "يحدد المدرس من الإدارة",
      "level": "مبتدئ",
      "section": "الفقه المالكي",
      "code": "MF-2026-000001",
      "pass": 50,
      "finalCount": 1,
      "finalTime": 20,
      "lessonCount": 1,
      "lessonTime": 10,
      "lessons": [
        {
          "title": "مدخل إلى دراسة المتن",
          "intro": "هذا درس توضيحي لتجربة المنصة، ويمكن للإدارة استبداله بمادة علمية معتمدة.",
          "preface": "تبدأ رحلة التعلم بفهم مقاصد الكتاب والتعرف إلى اصطلاحات مؤلفه.",
          "terms": "المتن: نص مختصر يجمع أصول العلم ومسائله.",
          "paragraphs": "اقرأ الفقرة بتأنّ، ثم دوّن ما أشكل عليك، واستعن بالمراجع المقررة في الدورة.",
          "refs": "تحدد الإدارة المراجع العلمية المعتمدة.",
          "link": "",
          "questions": [
            {
              "text": "ما الخطوة المناسبة قبل البدء في دراسة المتن؟",
              "options": [
                "التعرف إلى اصطلاحات المؤلف",
                "تجاوز المقدمة",
                "ترك المراجعة",
                "الاكتفاء بالعنوان"
              ],
              "correct": 0
            }
          ]
        }
      ],
      "questions": [
        {
          "text": "ما الخطوة المناسبة قبل البدء في دراسة المتن؟",
          "options": [
            "التعرف إلى اصطلاحات المؤلف",
            "تجاوز المقدمة",
            "ترك المراجعة",
            "الاكتفاء بالعنوان"
          ],
          "correct": 0
        }
      ],
      "demo": true,
      "prefix": "MF"
    },
    {
      "id": 2,
      "title": "الأربعون النووية",
      "book": "الأربعون النووية",
      "author": "الإمام النووي",
      "teacher": "يحدد المدرس من الإدارة",
      "level": "مبتدئ",
      "section": "الحديث الشريف",
      "code": "AA-2026-000002",
      "pass": 50,
      "finalCount": 1,
      "finalTime": 20,
      "lessonCount": 1,
      "lessonTime": 10,
      "lessons": [],
      "questions": [],
      "demo": true,
      "prefix": "AA"
    },
    {
      "id": 3,
      "title": "مبادئ أصول الفقه",
      "book": "الورقات",
      "author": "إمام الحرمين الجويني",
      "teacher": "يحدد المدرس من الإدارة",
      "level": "متوسط",
      "section": "أصول الفقه",
      "code": "AB-2026-000003",
      "pass": 50,
      "finalCount": 1,
      "finalTime": 20,
      "lessonCount": 1,
      "lessonTime": 10,
      "lessons": [],
      "questions": [],
      "demo": true,
      "prefix": "AB"
    },
    {
      "id": 4,
      "title": "الفقه المالكي — مفاتيح الدراسة (نموذج متكامل)",
      "book": "مذكرة تدريبية مدمجة في الدروس",
      "author": "إعداد النموذج التجريبي",
      "teacher": "مدرّس النموذج التجريبي",
      "section": "الفقه المالكي",
      "level": "مبتدئ",
      "prefix": "FB",
      "code": "FB-2026-000004",
      "pass": 50,
      "lessonCount": 2,
      "lessonTime": 5,
      "finalCount": 4,
      "finalTime": 10,
      "lessons": [
        {
          "title": "بناء خطة الدراسة",
          "preface": "درس 1 من نموذج المبتدئ في الفقه المالكي.",
          "intro": "قبل البدء في الفقه المالكي، حدّد هدفاً صغيراً قابلاً للمراجعة، واقسم وقتك بين القراءة والتلخيص والاختبار.",
          "terms": "الهدف: نتيجة واضحة تريد الوصول إليها. المراجعة: العودة إلى ما سبق تعلّمه.",
          "blocks": [
            {
              "title": "القراءة الأولى",
              "text": "اقرأ عنوان الدرس ومقدمته، ثم استخرج الكلمات التي تحتاج إلى توضيح. دوّن السؤال قبل الانتقال إلى الشرح.",
              "images": []
            },
            {
              "title": "التلخيص والمراجعة",
              "text": "اكتب فكرة كل فقرة بأسلوبك، ثم قارن تلخيصك بنص الدرس. أعد قراءة المواضع التي لم تتمكن من تلخيصها.",
              "images": []
            }
          ],
          "refs": "مادة تدريبية أصلية لتجربة الدراسة والاختبارات في المنصة. ليست مقرراً علمياً معتمداً، وتحتاج مراجعة المدرس قبل اعتمادها.",
          "link": "",
          "questions": [
            {
              "type": "mcq",
              "text": "ما الخطوة المناسبة قبل القراءة التفصيلية؟",
              "options": [
                "قراءة العنوان والمقدمة",
                "تجاوز جميع العناوين",
                "البدء بالاختبار دون قراءة",
                "ترك الكلمات غير المفهومة"
              ],
              "correct": 0
            },
            {
              "type": "tf",
              "text": "تلخيص الفقرة بأسلوب الطالب يساعد على مراجعة فهمه.",
              "options": [
                "صح",
                "خطأ"
              ],
              "correct": 0
            }
          ]
        },
        {
          "title": "تدوين المفاهيم وتوثيقها",
          "preface": "درس 2 من نموذج المبتدئ في الفقه المالكي.",
          "intro": "في دراسة الفقه المالكي، نظّم ملاحظاتك بحيث تفصل بين نص المصدر وتلخيصك وأسئلتك.",
          "terms": "النقل: كتابة كلام المصدر كما ورد. التلخيص: التعبير عن فكرته بإيجاز.",
          "blocks": [
            {
              "title": "بطاقة المفهوم",
              "text": "أنشئ بطاقة تتضمن اسم المفهوم، وشرحه الوارد في المادة، ومثالاً تعليمياً، والسؤال الذي تريد مراجعته.",
              "images": []
            },
            {
              "title": "بطاقة المرجع",
              "text": "عند النقل، اذكر اسم الكتاب والمؤلف وموضع النص. لا تنسب تلخيصك إلى المؤلف بوصفه نقلاً حرفياً.",
              "images": []
            }
          ],
          "refs": "مادة تدريبية أصلية لتجربة الدراسة والاختبارات في المنصة. ليست مقرراً علمياً معتمداً، وتحتاج مراجعة المدرس قبل اعتمادها.",
          "link": "",
          "questions": [
            {
              "type": "mcq",
              "text": "ماذا تتضمن بطاقة المرجع؟",
              "options": [
                "الكتاب والمؤلف وموضع النص",
                "عنواناً بلا مصدر",
                "اسم الطالب فقط",
                "تاريخ الاختبار فقط"
              ],
              "correct": 0
            },
            {
              "type": "tf",
              "text": "يجوز عرض التلخيص الشخصي على أنه اقتباس حرفي من المصدر.",
              "options": [
                "صح",
                "خطأ"
              ],
              "correct": 1
            }
          ]
        }
      ],
      "questions": [
        {
          "type": "mcq",
          "text": "ما الخطوة المناسبة قبل القراءة التفصيلية؟",
          "options": [
            "قراءة العنوان والمقدمة",
            "تجاوز جميع العناوين",
            "البدء بالاختبار دون قراءة",
            "ترك الكلمات غير المفهومة"
          ],
          "correct": 0
        },
        {
          "type": "tf",
          "text": "تلخيص الفقرة بأسلوب الطالب يساعد على مراجعة فهمه.",
          "options": [
            "صح",
            "خطأ"
          ],
          "correct": 0
        },
        {
          "type": "mcq",
          "text": "ماذا تتضمن بطاقة المرجع؟",
          "options": [
            "الكتاب والمؤلف وموضع النص",
            "عنواناً بلا مصدر",
            "اسم الطالب فقط",
            "تاريخ الاختبار فقط"
          ],
          "correct": 0
        },
        {
          "type": "tf",
          "text": "يجوز عرض التلخيص الشخصي على أنه اقتباس حرفي من المصدر.",
          "options": [
            "صح",
            "خطأ"
          ],
          "correct": 1
        }
      ],
      "demo": true,
      "modelCourse": true
    },
    {
      "id": 5,
      "title": "الفقه المالكي — تحليل المسائل (نموذج متكامل)",
      "book": "مذكرة تدريبية مدمجة في الدروس",
      "author": "إعداد النموذج التجريبي",
      "teacher": "مدرّس النموذج التجريبي",
      "section": "الفقه المالكي",
      "level": "متوسط",
      "prefix": "FM",
      "code": "FM-2026-000005",
      "pass": 50,
      "lessonCount": 2,
      "lessonTime": 5,
      "finalCount": 4,
      "finalTime": 10,
      "lessons": [
        {
          "title": "تحليل المسألة قبل المقارنة",
          "preface": "درس 1 من نموذج المتوسط في الفقه المالكي.",
          "intro": "بعد اجتياز المستوى الأول في الفقه المالكي، انتقل من جمع المصطلحات إلى تنظيم عناصر المسألة وتحرير السؤال.",
          "terms": "تصوير المسألة: بيان المقصود بالسؤال وحدوده. محل المقارنة: الجانب المشترك الذي تتم دراسته.",
          "blocks": [
            {
              "title": "حدود السؤال",
              "text": "اكتب السؤال في جملة واضحة، ثم حدّد ما يدخل فيه وما لا يدخل. غموض السؤال قد يؤدي إلى مقارنة غير متجانسة.",
              "images": []
            },
            {
              "title": "جدول المقارنة",
              "text": "نظّم عناصر المقارنة في جدول: المصدر، والفكرة، وموضع الاتفاق، وموضع الاختلاف، وما يحتاج إلى مراجعة المدرس.",
              "images": []
            }
          ],
          "refs": "مادة تدريبية أصلية لتجربة الدراسة والاختبارات في المنصة. ليست مقرراً علمياً معتمداً، وتحتاج مراجعة المدرس قبل اعتمادها.",
          "link": "",
          "questions": [
            {
              "type": "mcq",
              "text": "ما المطلوب قبل مقارنة الإجابات؟",
              "options": [
                "تحديد السؤال وحدوده",
                "إهمال سياق السؤال",
                "حذف أسماء المصادر",
                "البدء بالنتيجة دون قراءة"
              ],
              "correct": 0
            },
            {
              "type": "tf",
              "text": "تحديد محل المقارنة يساعد على تنظيم البحث.",
              "options": [
                "صح",
                "خطأ"
              ],
              "correct": 0
            }
          ]
        },
        {
          "title": "التمييز بين النقل والاستنتاج",
          "preface": "درس 2 من نموذج المتوسط في الفقه المالكي.",
          "intro": "في قراءة مصادر الفقه المالكي، فرّق بين ما يصرح به النص وما يستنتجه القارئ منه.",
          "terms": "الاستنتاج: نتيجة يصل إليها الباحث من قراءته. السياق: الكلام المحيط بالعبارة.",
          "blocks": [
            {
              "title": "قراءة السياق",
              "text": "ارجع إلى ما قبل العبارة وما بعدها قبل تلخيص معناها. قد توضّح المقدمة أو القيود مقصود الكاتب.",
              "images": []
            },
            {
              "title": "عرض النتيجة",
              "text": "ضع النقل في موضعه مع توثيقه، ثم اعرض فهمك بصيغة تدل على أنه استنتاج قابل للمراجعة، ولا تجعله قولاً صريحاً للمؤلف.",
              "images": []
            }
          ],
          "refs": "مادة تدريبية أصلية لتجربة الدراسة والاختبارات في المنصة. ليست مقرراً علمياً معتمداً، وتحتاج مراجعة المدرس قبل اعتمادها.",
          "link": "",
          "questions": [
            {
              "type": "mcq",
              "text": "كيف تعرض استنتاجك؟",
              "options": [
                "تذكر أنه فهمك مع توثيق النص",
                "تنسبه اقتباساً حرفياً للمؤلف",
                "تحذف النص الذي استندت إليه",
                "تخفي مواضع عدم اليقين"
              ],
              "correct": 0
            },
            {
              "type": "tf",
              "text": "كل استنتاج للقارئ هو نص صريح للمؤلف.",
              "options": [
                "صح",
                "خطأ"
              ],
              "correct": 1
            }
          ]
        }
      ],
      "questions": [
        {
          "type": "mcq",
          "text": "ما المطلوب قبل مقارنة الإجابات؟",
          "options": [
            "تحديد السؤال وحدوده",
            "إهمال سياق السؤال",
            "حذف أسماء المصادر",
            "البدء بالنتيجة دون قراءة"
          ],
          "correct": 0
        },
        {
          "type": "tf",
          "text": "تحديد محل المقارنة يساعد على تنظيم البحث.",
          "options": [
            "صح",
            "خطأ"
          ],
          "correct": 0
        },
        {
          "type": "mcq",
          "text": "كيف تعرض استنتاجك؟",
          "options": [
            "تذكر أنه فهمك مع توثيق النص",
            "تنسبه اقتباساً حرفياً للمؤلف",
            "تحذف النص الذي استندت إليه",
            "تخفي مواضع عدم اليقين"
          ],
          "correct": 0
        },
        {
          "type": "tf",
          "text": "كل استنتاج للقارئ هو نص صريح للمؤلف.",
          "options": [
            "صح",
            "خطأ"
          ],
          "correct": 1
        }
      ],
      "demo": true,
      "modelCourse": true
    },
    {
      "id": 6,
      "title": "الفقه المالكي — إعداد بحث (نموذج متكامل)",
      "book": "مذكرة تدريبية مدمجة في الدروس",
      "author": "إعداد النموذج التجريبي",
      "teacher": "مدرّس النموذج التجريبي",
      "section": "الفقه المالكي",
      "level": "منتهٍ",
      "prefix": "FA",
      "code": "FA-2026-000006",
      "pass": 50,
      "lessonCount": 2,
      "lessonTime": 5,
      "finalCount": 4,
      "finalTime": 10,
      "lessons": [
        {
          "title": "تصميم بحث تعليمي قصير",
          "preface": "درس 1 من نموذج المنتهي في الفقه المالكي.",
          "intro": "بعد شهادة المستوى المتوسط في الفقه المالكي، جرّب إعداد بحث قصير يعرض سؤالاً محدداً وخطة مناسبة للإجابة.",
          "terms": "خطة البحث: ترتيب الخطوات والعناوين. نطاق البحث: حدوده الموضوعية.",
          "blocks": [
            {
              "title": "صياغة السؤال والخطة",
              "text": "اختر سؤالاً محدوداً، واكتب سبب اختياره، ثم قسّم العرض إلى مقدمة ومحاور وخاتمة. اجعل كل محور مرتبطاً بالسؤال.",
              "images": []
            },
            {
              "title": "جمع المادة",
              "text": "اجمع النصوص ذات الصلة وسجل بيانات مراجعها فوراً. افصل ملف الاقتباسات عن ملف أفكارك الأولية.",
              "images": []
            }
          ],
          "refs": "مادة تدريبية أصلية لتجربة الدراسة والاختبارات في المنصة. ليست مقرراً علمياً معتمداً، وتحتاج مراجعة المدرس قبل اعتمادها.",
          "link": "",
          "questions": [
            {
              "type": "mcq",
              "text": "بماذا تبدأ خطة البحث؟",
              "options": [
                "سؤال محدد ونطاق واضح",
                "قائمة نتائج بلا سؤال",
                "نصوص بلا توثيق",
                "عنوان بعيد عن المادة"
              ],
              "correct": 0
            },
            {
              "type": "tf",
              "text": "ينبغي أن ترتبط محاور البحث بسؤاله الرئيس.",
              "options": [
                "صح",
                "خطأ"
              ],
              "correct": 0
            }
          ]
        },
        {
          "title": "مراجعة البحث وعرضه",
          "preface": "درس 2 من نموذج المنتهي في الفقه المالكي.",
          "intro": "المراجعة الأخيرة لبحث في الفقه المالكي تشمل سلامة النقل، وترابط العرض، ووضوح النتائج وحدودها.",
          "terms": "المراجعة العلمية: فحص الأدلة والنقول. المراجعة التحريرية: فحص اللغة والتنظيم.",
          "blocks": [
            {
              "title": "مراجعة التوثيق",
              "text": "قارن كل اقتباس بمصدره، وطابق أسماء المؤلفين والكتب ومواضع النصوص. أزل أي نسبة لم تتمكن من التحقق منها.",
              "images": []
            },
            {
              "title": "مراجعة الخاتمة",
              "text": "اكتب النتائج التي يدعمها العرض وحدد ما بقي من أسئلة. اعرض البحث على المدرس للمراجعة، ولا تقدّم النموذج التعليمي على أنه فتوى أو دراسة محكّمة.",
              "images": []
            }
          ],
          "refs": "مادة تدريبية أصلية لتجربة الدراسة والاختبارات في المنصة. ليست مقرراً علمياً معتمداً، وتحتاج مراجعة المدرس قبل اعتمادها.",
          "link": "",
          "questions": [
            {
              "type": "mcq",
              "text": "ماذا تفعل بالنسبة التي لم تتحقق منها؟",
              "options": [
                "تراجعها أو تزيلها",
                "تتركها وكأنها مؤكدة",
                "تستبدلها بقول بلا مصدر",
                "تنقلها إلى الخاتمة فقط"
              ],
              "correct": 0
            },
            {
              "type": "tf",
              "text": "النموذج التعليمي يغني عن اعتماد المدرس للمحتوى العلمي.",
              "options": [
                "صح",
                "خطأ"
              ],
              "correct": 1
            }
          ]
        }
      ],
      "questions": [
        {
          "type": "mcq",
          "text": "بماذا تبدأ خطة البحث؟",
          "options": [
            "سؤال محدد ونطاق واضح",
            "قائمة نتائج بلا سؤال",
            "نصوص بلا توثيق",
            "عنوان بعيد عن المادة"
          ],
          "correct": 0
        },
        {
          "type": "tf",
          "text": "ينبغي أن ترتبط محاور البحث بسؤاله الرئيس.",
          "options": [
            "صح",
            "خطأ"
          ],
          "correct": 0
        },
        {
          "type": "mcq",
          "text": "ماذا تفعل بالنسبة التي لم تتحقق منها؟",
          "options": [
            "تراجعها أو تزيلها",
            "تتركها وكأنها مؤكدة",
            "تستبدلها بقول بلا مصدر",
            "تنقلها إلى الخاتمة فقط"
          ],
          "correct": 0
        },
        {
          "type": "tf",
          "text": "النموذج التعليمي يغني عن اعتماد المدرس للمحتوى العلمي.",
          "options": [
            "صح",
            "خطأ"
          ],
          "correct": 1
        }
      ],
      "demo": true,
      "modelCourse": true
    },
    {
      "id": 7,
      "title": "الحديث الشريف — مفاتيح الدراسة (نموذج متكامل)",
      "book": "مذكرة تدريبية مدمجة في الدروس",
      "author": "إعداد النموذج التجريبي",
      "teacher": "مدرّس النموذج التجريبي",
      "section": "الحديث الشريف",
      "level": "مبتدئ",
      "prefix": "HB",
      "code": "HB-2026-000007",
      "pass": 50,
      "lessonCount": 2,
      "lessonTime": 5,
      "finalCount": 4,
      "finalTime": 10,
      "lessons": [
        {
          "title": "بناء خطة الدراسة",
          "preface": "درس 1 من نموذج المبتدئ في الحديث الشريف.",
          "intro": "قبل البدء في الحديث الشريف، حدّد هدفاً صغيراً قابلاً للمراجعة، واقسم وقتك بين القراءة والتلخيص والاختبار.",
          "terms": "الهدف: نتيجة واضحة تريد الوصول إليها. المراجعة: العودة إلى ما سبق تعلّمه.",
          "blocks": [
            {
              "title": "القراءة الأولى",
              "text": "اقرأ عنوان الدرس ومقدمته، ثم استخرج الكلمات التي تحتاج إلى توضيح. دوّن السؤال قبل الانتقال إلى الشرح.",
              "images": []
            },
            {
              "title": "التلخيص والمراجعة",
              "text": "اكتب فكرة كل فقرة بأسلوبك، ثم قارن تلخيصك بنص الدرس. أعد قراءة المواضع التي لم تتمكن من تلخيصها.",
              "images": []
            }
          ],
          "refs": "مادة تدريبية أصلية لتجربة الدراسة والاختبارات في المنصة. ليست مقرراً علمياً معتمداً، وتحتاج مراجعة المدرس قبل اعتمادها.",
          "link": "",
          "questions": [
            {
              "type": "mcq",
              "text": "ما الخطوة المناسبة قبل القراءة التفصيلية؟",
              "options": [
                "قراءة العنوان والمقدمة",
                "تجاوز جميع العناوين",
                "البدء بالاختبار دون قراءة",
                "ترك الكلمات غير المفهومة"
              ],
              "correct": 0
            },
            {
              "type": "tf",
              "text": "تلخيص الفقرة بأسلوب الطالب يساعد على مراجعة فهمه.",
              "options": [
                "صح",
                "خطأ"
              ],
              "correct": 0
            }
          ]
        },
        {
          "title": "تدوين المفاهيم وتوثيقها",
          "preface": "درس 2 من نموذج المبتدئ في الحديث الشريف.",
          "intro": "في دراسة الحديث الشريف، نظّم ملاحظاتك بحيث تفصل بين نص المصدر وتلخيصك وأسئلتك.",
          "terms": "النقل: كتابة كلام المصدر كما ورد. التلخيص: التعبير عن فكرته بإيجاز.",
          "blocks": [
            {
              "title": "بطاقة المفهوم",
              "text": "أنشئ بطاقة تتضمن اسم المفهوم، وشرحه الوارد في المادة، ومثالاً تعليمياً، والسؤال الذي تريد مراجعته.",
              "images": []
            },
            {
              "title": "بطاقة المرجع",
              "text": "عند النقل، اذكر اسم الكتاب والمؤلف وموضع النص. لا تنسب تلخيصك إلى المؤلف بوصفه نقلاً حرفياً.",
              "images": []
            }
          ],
          "refs": "مادة تدريبية أصلية لتجربة الدراسة والاختبارات في المنصة. ليست مقرراً علمياً معتمداً، وتحتاج مراجعة المدرس قبل اعتمادها.",
          "link": "",
          "questions": [
            {
              "type": "mcq",
              "text": "ماذا تتضمن بطاقة المرجع؟",
              "options": [
                "الكتاب والمؤلف وموضع النص",
                "عنواناً بلا مصدر",
                "اسم الطالب فقط",
                "تاريخ الاختبار فقط"
              ],
              "correct": 0
            },
            {
              "type": "tf",
              "text": "يجوز عرض التلخيص الشخصي على أنه اقتباس حرفي من المصدر.",
              "options": [
                "صح",
                "خطأ"
              ],
              "correct": 1
            }
          ]
        }
      ],
      "questions": [
        {
          "type": "mcq",
          "text": "ما الخطوة المناسبة قبل القراءة التفصيلية؟",
          "options": [
            "قراءة العنوان والمقدمة",
            "تجاوز جميع العناوين",
            "البدء بالاختبار دون قراءة",
            "ترك الكلمات غير المفهومة"
          ],
          "correct": 0
        },
        {
          "type": "tf",
          "text": "تلخيص الفقرة بأسلوب الطالب يساعد على مراجعة فهمه.",
          "options": [
            "صح",
            "خطأ"
          ],
          "correct": 0
        },
        {
          "type": "mcq",
          "text": "ماذا تتضمن بطاقة المرجع؟",
          "options": [
            "الكتاب والمؤلف وموضع النص",
            "عنواناً بلا مصدر",
            "اسم الطالب فقط",
            "تاريخ الاختبار فقط"
          ],
          "correct": 0
        },
        {
          "type": "tf",
          "text": "يجوز عرض التلخيص الشخصي على أنه اقتباس حرفي من المصدر.",
          "options": [
            "صح",
            "خطأ"
          ],
          "correct": 1
        }
      ],
      "demo": true,
      "modelCourse": true
    },
    {
      "id": 8,
      "title": "الحديث الشريف — تحليل المسائل (نموذج متكامل)",
      "book": "مذكرة تدريبية مدمجة في الدروس",
      "author": "إعداد النموذج التجريبي",
      "teacher": "مدرّس النموذج التجريبي",
      "section": "الحديث الشريف",
      "level": "متوسط",
      "prefix": "HM",
      "code": "HM-2026-000008",
      "pass": 50,
      "lessonCount": 2,
      "lessonTime": 5,
      "finalCount": 4,
      "finalTime": 10,
      "lessons": [
        {
          "title": "تحليل المسألة قبل المقارنة",
          "preface": "درس 1 من نموذج المتوسط في الحديث الشريف.",
          "intro": "بعد اجتياز المستوى الأول في الحديث الشريف، انتقل من جمع المصطلحات إلى تنظيم عناصر المسألة وتحرير السؤال.",
          "terms": "تصوير المسألة: بيان المقصود بالسؤال وحدوده. محل المقارنة: الجانب المشترك الذي تتم دراسته.",
          "blocks": [
            {
              "title": "حدود السؤال",
              "text": "اكتب السؤال في جملة واضحة، ثم حدّد ما يدخل فيه وما لا يدخل. غموض السؤال قد يؤدي إلى مقارنة غير متجانسة.",
              "images": []
            },
            {
              "title": "جدول المقارنة",
              "text": "نظّم عناصر المقارنة في جدول: المصدر، والفكرة، وموضع الاتفاق، وموضع الاختلاف، وما يحتاج إلى مراجعة المدرس.",
              "images": []
            }
          ],
          "refs": "مادة تدريبية أصلية لتجربة الدراسة والاختبارات في المنصة. ليست مقرراً علمياً معتمداً، وتحتاج مراجعة المدرس قبل اعتمادها.",
          "link": "",
          "questions": [
            {
              "type": "mcq",
              "text": "ما المطلوب قبل مقارنة الإجابات؟",
              "options": [
                "تحديد السؤال وحدوده",
                "إهمال سياق السؤال",
                "حذف أسماء المصادر",
                "البدء بالنتيجة دون قراءة"
              ],
              "correct": 0
            },
            {
              "type": "tf",
              "text": "تحديد محل المقارنة يساعد على تنظيم البحث.",
              "options": [
                "صح",
                "خطأ"
              ],
              "correct": 0
            }
          ]
        },
        {
          "title": "التمييز بين النقل والاستنتاج",
          "preface": "درس 2 من نموذج المتوسط في الحديث الشريف.",
          "intro": "في قراءة مصادر الحديث الشريف، فرّق بين ما يصرح به النص وما يستنتجه القارئ منه.",
          "terms": "الاستنتاج: نتيجة يصل إليها الباحث من قراءته. السياق: الكلام المحيط بالعبارة.",
          "blocks": [
            {
              "title": "قراءة السياق",
              "text": "ارجع إلى ما قبل العبارة وما بعدها قبل تلخيص معناها. قد توضّح المقدمة أو القيود مقصود الكاتب.",
              "images": []
            },
            {
              "title": "عرض النتيجة",
              "text": "ضع النقل في موضعه مع توثيقه، ثم اعرض فهمك بصيغة تدل على أنه استنتاج قابل للمراجعة، ولا تجعله قولاً صريحاً للمؤلف.",
              "images": []
            }
          ],
          "refs": "مادة تدريبية أصلية لتجربة الدراسة والاختبارات في المنصة. ليست مقرراً علمياً معتمداً، وتحتاج مراجعة المدرس قبل اعتمادها.",
          "link": "",
          "questions": [
            {
              "type": "mcq",
              "text": "كيف تعرض استنتاجك؟",
              "options": [
                "تذكر أنه فهمك مع توثيق النص",
                "تنسبه اقتباساً حرفياً للمؤلف",
                "تحذف النص الذي استندت إليه",
                "تخفي مواضع عدم اليقين"
              ],
              "correct": 0
            },
            {
              "type": "tf",
              "text": "كل استنتاج للقارئ هو نص صريح للمؤلف.",
              "options": [
                "صح",
                "خطأ"
              ],
              "correct": 1
            }
          ]
        }
      ],
      "questions": [
        {
          "type": "mcq",
          "text": "ما المطلوب قبل مقارنة الإجابات؟",
          "options": [
            "تحديد السؤال وحدوده",
            "إهمال سياق السؤال",
            "حذف أسماء المصادر",
            "البدء بالنتيجة دون قراءة"
          ],
          "correct": 0
        },
        {
          "type": "tf",
          "text": "تحديد محل المقارنة يساعد على تنظيم البحث.",
          "options": [
            "صح",
            "خطأ"
          ],
          "correct": 0
        },
        {
          "type": "mcq",
          "text": "كيف تعرض استنتاجك؟",
          "options": [
            "تذكر أنه فهمك مع توثيق النص",
            "تنسبه اقتباساً حرفياً للمؤلف",
            "تحذف النص الذي استندت إليه",
            "تخفي مواضع عدم اليقين"
          ],
          "correct": 0
        },
        {
          "type": "tf",
          "text": "كل استنتاج للقارئ هو نص صريح للمؤلف.",
          "options": [
            "صح",
            "خطأ"
          ],
          "correct": 1
        }
      ],
      "demo": true,
      "modelCourse": true
    },
    {
      "id": 9,
      "title": "الحديث الشريف — إعداد بحث (نموذج متكامل)",
      "book": "مذكرة تدريبية مدمجة في الدروس",
      "author": "إعداد النموذج التجريبي",
      "teacher": "مدرّس النموذج التجريبي",
      "section": "الحديث الشريف",
      "level": "منتهٍ",
      "prefix": "HA",
      "code": "HA-2026-000009",
      "pass": 50,
      "lessonCount": 2,
      "lessonTime": 5,
      "finalCount": 4,
      "finalTime": 10,
      "lessons": [
        {
          "title": "تصميم بحث تعليمي قصير",
          "preface": "درس 1 من نموذج المنتهي في الحديث الشريف.",
          "intro": "بعد شهادة المستوى المتوسط في الحديث الشريف، جرّب إعداد بحث قصير يعرض سؤالاً محدداً وخطة مناسبة للإجابة.",
          "terms": "خطة البحث: ترتيب الخطوات والعناوين. نطاق البحث: حدوده الموضوعية.",
          "blocks": [
            {
              "title": "صياغة السؤال والخطة",
              "text": "اختر سؤالاً محدوداً، واكتب سبب اختياره، ثم قسّم العرض إلى مقدمة ومحاور وخاتمة. اجعل كل محور مرتبطاً بالسؤال.",
              "images": []
            },
            {
              "title": "جمع المادة",
              "text": "اجمع النصوص ذات الصلة وسجل بيانات مراجعها فوراً. افصل ملف الاقتباسات عن ملف أفكارك الأولية.",
              "images": []
            }
          ],
          "refs": "مادة تدريبية أصلية لتجربة الدراسة والاختبارات في المنصة. ليست مقرراً علمياً معتمداً، وتحتاج مراجعة المدرس قبل اعتمادها.",
          "link": "",
          "questions": [
            {
              "type": "mcq",
              "text": "بماذا تبدأ خطة البحث؟",
              "options": [
                "سؤال محدد ونطاق واضح",
                "قائمة نتائج بلا سؤال",
                "نصوص بلا توثيق",
                "عنوان بعيد عن المادة"
              ],
              "correct": 0
            },
            {
              "type": "tf",
              "text": "ينبغي أن ترتبط محاور البحث بسؤاله الرئيس.",
              "options": [
                "صح",
                "خطأ"
              ],
              "correct": 0
            }
          ]
        },
        {
          "title": "مراجعة البحث وعرضه",
          "preface": "درس 2 من نموذج المنتهي في الحديث الشريف.",
          "intro": "المراجعة الأخيرة لبحث في الحديث الشريف تشمل سلامة النقل، وترابط العرض، ووضوح النتائج وحدودها.",
          "terms": "المراجعة العلمية: فحص الأدلة والنقول. المراجعة التحريرية: فحص اللغة والتنظيم.",
          "blocks": [
            {
              "title": "مراجعة التوثيق",
              "text": "قارن كل اقتباس بمصدره، وطابق أسماء المؤلفين والكتب ومواضع النصوص. أزل أي نسبة لم تتمكن من التحقق منها.",
              "images": []
            },
            {
              "title": "مراجعة الخاتمة",
              "text": "اكتب النتائج التي يدعمها العرض وحدد ما بقي من أسئلة. اعرض البحث على المدرس للمراجعة، ولا تقدّم النموذج التعليمي على أنه فتوى أو دراسة محكّمة.",
              "images": []
            }
          ],
          "refs": "مادة تدريبية أصلية لتجربة الدراسة والاختبارات في المنصة. ليست مقرراً علمياً معتمداً، وتحتاج مراجعة المدرس قبل اعتمادها.",
          "link": "",
          "questions": [
            {
              "type": "mcq",
              "text": "ماذا تفعل بالنسبة التي لم تتحقق منها؟",
              "options": [
                "تراجعها أو تزيلها",
                "تتركها وكأنها مؤكدة",
                "تستبدلها بقول بلا مصدر",
                "تنقلها إلى الخاتمة فقط"
              ],
              "correct": 0
            },
            {
              "type": "tf",
              "text": "النموذج التعليمي يغني عن اعتماد المدرس للمحتوى العلمي.",
              "options": [
                "صح",
                "خطأ"
              ],
              "correct": 1
            }
          ]
        }
      ],
      "questions": [
        {
          "type": "mcq",
          "text": "بماذا تبدأ خطة البحث؟",
          "options": [
            "سؤال محدد ونطاق واضح",
            "قائمة نتائج بلا سؤال",
            "نصوص بلا توثيق",
            "عنوان بعيد عن المادة"
          ],
          "correct": 0
        },
        {
          "type": "tf",
          "text": "ينبغي أن ترتبط محاور البحث بسؤاله الرئيس.",
          "options": [
            "صح",
            "خطأ"
          ],
          "correct": 0
        },
        {
          "type": "mcq",
          "text": "ماذا تفعل بالنسبة التي لم تتحقق منها؟",
          "options": [
            "تراجعها أو تزيلها",
            "تتركها وكأنها مؤكدة",
            "تستبدلها بقول بلا مصدر",
            "تنقلها إلى الخاتمة فقط"
          ],
          "correct": 0
        },
        {
          "type": "tf",
          "text": "النموذج التعليمي يغني عن اعتماد المدرس للمحتوى العلمي.",
          "options": [
            "صح",
            "خطأ"
          ],
          "correct": 1
        }
      ],
      "demo": true,
      "modelCourse": true
    },
    {
      "id": 10,
      "title": "أصول الفقه — مفاتيح الدراسة (نموذج متكامل)",
      "book": "مذكرة تدريبية مدمجة في الدروس",
      "author": "إعداد النموذج التجريبي",
      "teacher": "مدرّس النموذج التجريبي",
      "section": "أصول الفقه",
      "level": "مبتدئ",
      "prefix": "UB",
      "code": "UB-2026-000010",
      "pass": 50,
      "lessonCount": 2,
      "lessonTime": 5,
      "finalCount": 4,
      "finalTime": 10,
      "lessons": [
        {
          "title": "بناء خطة الدراسة",
          "preface": "درس 1 من نموذج المبتدئ في أصول الفقه.",
          "intro": "قبل البدء في أصول الفقه، حدّد هدفاً صغيراً قابلاً للمراجعة، واقسم وقتك بين القراءة والتلخيص والاختبار.",
          "terms": "الهدف: نتيجة واضحة تريد الوصول إليها. المراجعة: العودة إلى ما سبق تعلّمه.",
          "blocks": [
            {
              "title": "القراءة الأولى",
              "text": "اقرأ عنوان الدرس ومقدمته، ثم استخرج الكلمات التي تحتاج إلى توضيح. دوّن السؤال قبل الانتقال إلى الشرح.",
              "images": []
            },
            {
              "title": "التلخيص والمراجعة",
              "text": "اكتب فكرة كل فقرة بأسلوبك، ثم قارن تلخيصك بنص الدرس. أعد قراءة المواضع التي لم تتمكن من تلخيصها.",
              "images": []
            }
          ],
          "refs": "مادة تدريبية أصلية لتجربة الدراسة والاختبارات في المنصة. ليست مقرراً علمياً معتمداً، وتحتاج مراجعة المدرس قبل اعتمادها.",
          "link": "",
          "questions": [
            {
              "type": "mcq",
              "text": "ما الخطوة المناسبة قبل القراءة التفصيلية؟",
              "options": [
                "قراءة العنوان والمقدمة",
                "تجاوز جميع العناوين",
                "البدء بالاختبار دون قراءة",
                "ترك الكلمات غير المفهومة"
              ],
              "correct": 0
            },
            {
              "type": "tf",
              "text": "تلخيص الفقرة بأسلوب الطالب يساعد على مراجعة فهمه.",
              "options": [
                "صح",
                "خطأ"
              ],
              "correct": 0
            }
          ]
        },
        {
          "title": "تدوين المفاهيم وتوثيقها",
          "preface": "درس 2 من نموذج المبتدئ في أصول الفقه.",
          "intro": "في دراسة أصول الفقه، نظّم ملاحظاتك بحيث تفصل بين نص المصدر وتلخيصك وأسئلتك.",
          "terms": "النقل: كتابة كلام المصدر كما ورد. التلخيص: التعبير عن فكرته بإيجاز.",
          "blocks": [
            {
              "title": "بطاقة المفهوم",
              "text": "أنشئ بطاقة تتضمن اسم المفهوم، وشرحه الوارد في المادة، ومثالاً تعليمياً، والسؤال الذي تريد مراجعته.",
              "images": []
            },
            {
              "title": "بطاقة المرجع",
              "text": "عند النقل، اذكر اسم الكتاب والمؤلف وموضع النص. لا تنسب تلخيصك إلى المؤلف بوصفه نقلاً حرفياً.",
              "images": []
            }
          ],
          "refs": "مادة تدريبية أصلية لتجربة الدراسة والاختبارات في المنصة. ليست مقرراً علمياً معتمداً، وتحتاج مراجعة المدرس قبل اعتمادها.",
          "link": "",
          "questions": [
            {
              "type": "mcq",
              "text": "ماذا تتضمن بطاقة المرجع؟",
              "options": [
                "الكتاب والمؤلف وموضع النص",
                "عنواناً بلا مصدر",
                "اسم الطالب فقط",
                "تاريخ الاختبار فقط"
              ],
              "correct": 0
            },
            {
              "type": "tf",
              "text": "يجوز عرض التلخيص الشخصي على أنه اقتباس حرفي من المصدر.",
              "options": [
                "صح",
                "خطأ"
              ],
              "correct": 1
            }
          ]
        }
      ],
      "questions": [
        {
          "type": "mcq",
          "text": "ما الخطوة المناسبة قبل القراءة التفصيلية؟",
          "options": [
            "قراءة العنوان والمقدمة",
            "تجاوز جميع العناوين",
            "البدء بالاختبار دون قراءة",
            "ترك الكلمات غير المفهومة"
          ],
          "correct": 0
        },
        {
          "type": "tf",
          "text": "تلخيص الفقرة بأسلوب الطالب يساعد على مراجعة فهمه.",
          "options": [
            "صح",
            "خطأ"
          ],
          "correct": 0
        },
        {
          "type": "mcq",
          "text": "ماذا تتضمن بطاقة المرجع؟",
          "options": [
            "الكتاب والمؤلف وموضع النص",
            "عنواناً بلا مصدر",
            "اسم الطالب فقط",
            "تاريخ الاختبار فقط"
          ],
          "correct": 0
        },
        {
          "type": "tf",
          "text": "يجوز عرض التلخيص الشخصي على أنه اقتباس حرفي من المصدر.",
          "options": [
            "صح",
            "خطأ"
          ],
          "correct": 1
        }
      ],
      "demo": true,
      "modelCourse": true
    },
    {
      "id": 11,
      "title": "أصول الفقه — تحليل المسائل (نموذج متكامل)",
      "book": "مذكرة تدريبية مدمجة في الدروس",
      "author": "إعداد النموذج التجريبي",
      "teacher": "مدرّس النموذج التجريبي",
      "section": "أصول الفقه",
      "level": "متوسط",
      "prefix": "UM",
      "code": "UM-2026-000011",
      "pass": 50,
      "lessonCount": 2,
      "lessonTime": 5,
      "finalCount": 4,
      "finalTime": 10,
      "lessons": [
        {
          "title": "تحليل المسألة قبل المقارنة",
          "preface": "درس 1 من نموذج المتوسط في أصول الفقه.",
          "intro": "بعد اجتياز المستوى الأول في أصول الفقه، انتقل من جمع المصطلحات إلى تنظيم عناصر المسألة وتحرير السؤال.",
          "terms": "تصوير المسألة: بيان المقصود بالسؤال وحدوده. محل المقارنة: الجانب المشترك الذي تتم دراسته.",
          "blocks": [
            {
              "title": "حدود السؤال",
              "text": "اكتب السؤال في جملة واضحة، ثم حدّد ما يدخل فيه وما لا يدخل. غموض السؤال قد يؤدي إلى مقارنة غير متجانسة.",
              "images": []
            },
            {
              "title": "جدول المقارنة",
              "text": "نظّم عناصر المقارنة في جدول: المصدر، والفكرة، وموضع الاتفاق، وموضع الاختلاف، وما يحتاج إلى مراجعة المدرس.",
              "images": []
            }
          ],
          "refs": "مادة تدريبية أصلية لتجربة الدراسة والاختبارات في المنصة. ليست مقرراً علمياً معتمداً، وتحتاج مراجعة المدرس قبل اعتمادها.",
          "link": "",
          "questions": [
            {
              "type": "mcq",
              "text": "ما المطلوب قبل مقارنة الإجابات؟",
              "options": [
                "تحديد السؤال وحدوده",
                "إهمال سياق السؤال",
                "حذف أسماء المصادر",
                "البدء بالنتيجة دون قراءة"
              ],
              "correct": 0
            },
            {
              "type": "tf",
              "text": "تحديد محل المقارنة يساعد على تنظيم البحث.",
              "options": [
                "صح",
                "خطأ"
              ],
              "correct": 0
            }
          ]
        },
        {
          "title": "التمييز بين النقل والاستنتاج",
          "preface": "درس 2 من نموذج المتوسط في أصول الفقه.",
          "intro": "في قراءة مصادر أصول الفقه، فرّق بين ما يصرح به النص وما يستنتجه القارئ منه.",
          "terms": "الاستنتاج: نتيجة يصل إليها الباحث من قراءته. السياق: الكلام المحيط بالعبارة.",
          "blocks": [
            {
              "title": "قراءة السياق",
              "text": "ارجع إلى ما قبل العبارة وما بعدها قبل تلخيص معناها. قد توضّح المقدمة أو القيود مقصود الكاتب.",
              "images": []
            },
            {
              "title": "عرض النتيجة",
              "text": "ضع النقل في موضعه مع توثيقه، ثم اعرض فهمك بصيغة تدل على أنه استنتاج قابل للمراجعة، ولا تجعله قولاً صريحاً للمؤلف.",
              "images": []
            }
          ],
          "refs": "مادة تدريبية أصلية لتجربة الدراسة والاختبارات في المنصة. ليست مقرراً علمياً معتمداً، وتحتاج مراجعة المدرس قبل اعتمادها.",
          "link": "",
          "questions": [
            {
              "type": "mcq",
              "text": "كيف تعرض استنتاجك؟",
              "options": [
                "تذكر أنه فهمك مع توثيق النص",
                "تنسبه اقتباساً حرفياً للمؤلف",
                "تحذف النص الذي استندت إليه",
                "تخفي مواضع عدم اليقين"
              ],
              "correct": 0
            },
            {
              "type": "tf",
              "text": "كل استنتاج للقارئ هو نص صريح للمؤلف.",
              "options": [
                "صح",
                "خطأ"
              ],
              "correct": 1
            }
          ]
        }
      ],
      "questions": [
        {
          "type": "mcq",
          "text": "ما المطلوب قبل مقارنة الإجابات؟",
          "options": [
            "تحديد السؤال وحدوده",
            "إهمال سياق السؤال",
            "حذف أسماء المصادر",
            "البدء بالنتيجة دون قراءة"
          ],
          "correct": 0
        },
        {
          "type": "tf",
          "text": "تحديد محل المقارنة يساعد على تنظيم البحث.",
          "options": [
            "صح",
            "خطأ"
          ],
          "correct": 0
        },
        {
          "type": "mcq",
          "text": "كيف تعرض استنتاجك؟",
          "options": [
            "تذكر أنه فهمك مع توثيق النص",
            "تنسبه اقتباساً حرفياً للمؤلف",
            "تحذف النص الذي استندت إليه",
            "تخفي مواضع عدم اليقين"
          ],
          "correct": 0
        },
        {
          "type": "tf",
          "text": "كل استنتاج للقارئ هو نص صريح للمؤلف.",
          "options": [
            "صح",
            "خطأ"
          ],
          "correct": 1
        }
      ],
      "demo": true,
      "modelCourse": true
    },
    {
      "id": 12,
      "title": "أصول الفقه — إعداد بحث (نموذج متكامل)",
      "book": "مذكرة تدريبية مدمجة في الدروس",
      "author": "إعداد النموذج التجريبي",
      "teacher": "مدرّس النموذج التجريبي",
      "section": "أصول الفقه",
      "level": "منتهٍ",
      "prefix": "UA",
      "code": "UA-2026-000012",
      "pass": 50,
      "lessonCount": 2,
      "lessonTime": 5,
      "finalCount": 4,
      "finalTime": 10,
      "lessons": [
        {
          "title": "تصميم بحث تعليمي قصير",
          "preface": "درس 1 من نموذج المنتهي في أصول الفقه.",
          "intro": "بعد شهادة المستوى المتوسط في أصول الفقه، جرّب إعداد بحث قصير يعرض سؤالاً محدداً وخطة مناسبة للإجابة.",
          "terms": "خطة البحث: ترتيب الخطوات والعناوين. نطاق البحث: حدوده الموضوعية.",
          "blocks": [
            {
              "title": "صياغة السؤال والخطة",
              "text": "اختر سؤالاً محدوداً، واكتب سبب اختياره، ثم قسّم العرض إلى مقدمة ومحاور وخاتمة. اجعل كل محور مرتبطاً بالسؤال.",
              "images": []
            },
            {
              "title": "جمع المادة",
              "text": "اجمع النصوص ذات الصلة وسجل بيانات مراجعها فوراً. افصل ملف الاقتباسات عن ملف أفكارك الأولية.",
              "images": []
            }
          ],
          "refs": "مادة تدريبية أصلية لتجربة الدراسة والاختبارات في المنصة. ليست مقرراً علمياً معتمداً، وتحتاج مراجعة المدرس قبل اعتمادها.",
          "link": "",
          "questions": [
            {
              "type": "mcq",
              "text": "بماذا تبدأ خطة البحث؟",
              "options": [
                "سؤال محدد ونطاق واضح",
                "قائمة نتائج بلا سؤال",
                "نصوص بلا توثيق",
                "عنوان بعيد عن المادة"
              ],
              "correct": 0
            },
            {
              "type": "tf",
              "text": "ينبغي أن ترتبط محاور البحث بسؤاله الرئيس.",
              "options": [
                "صح",
                "خطأ"
              ],
              "correct": 0
            }
          ]
        },
        {
          "title": "مراجعة البحث وعرضه",
          "preface": "درس 2 من نموذج المنتهي في أصول الفقه.",
          "intro": "المراجعة الأخيرة لبحث في أصول الفقه تشمل سلامة النقل، وترابط العرض، ووضوح النتائج وحدودها.",
          "terms": "المراجعة العلمية: فحص الأدلة والنقول. المراجعة التحريرية: فحص اللغة والتنظيم.",
          "blocks": [
            {
              "title": "مراجعة التوثيق",
              "text": "قارن كل اقتباس بمصدره، وطابق أسماء المؤلفين والكتب ومواضع النصوص. أزل أي نسبة لم تتمكن من التحقق منها.",
              "images": []
            },
            {
              "title": "مراجعة الخاتمة",
              "text": "اكتب النتائج التي يدعمها العرض وحدد ما بقي من أسئلة. اعرض البحث على المدرس للمراجعة، ولا تقدّم النموذج التعليمي على أنه فتوى أو دراسة محكّمة.",
              "images": []
            }
          ],
          "refs": "مادة تدريبية أصلية لتجربة الدراسة والاختبارات في المنصة. ليست مقرراً علمياً معتمداً، وتحتاج مراجعة المدرس قبل اعتمادها.",
          "link": "",
          "questions": [
            {
              "type": "mcq",
              "text": "ماذا تفعل بالنسبة التي لم تتحقق منها؟",
              "options": [
                "تراجعها أو تزيلها",
                "تتركها وكأنها مؤكدة",
                "تستبدلها بقول بلا مصدر",
                "تنقلها إلى الخاتمة فقط"
              ],
              "correct": 0
            },
            {
              "type": "tf",
              "text": "النموذج التعليمي يغني عن اعتماد المدرس للمحتوى العلمي.",
              "options": [
                "صح",
                "خطأ"
              ],
              "correct": 1
            }
          ]
        }
      ],
      "questions": [
        {
          "type": "mcq",
          "text": "بماذا تبدأ خطة البحث؟",
          "options": [
            "سؤال محدد ونطاق واضح",
            "قائمة نتائج بلا سؤال",
            "نصوص بلا توثيق",
            "عنوان بعيد عن المادة"
          ],
          "correct": 0
        },
        {
          "type": "tf",
          "text": "ينبغي أن ترتبط محاور البحث بسؤاله الرئيس.",
          "options": [
            "صح",
            "خطأ"
          ],
          "correct": 0
        },
        {
          "type": "mcq",
          "text": "ماذا تفعل بالنسبة التي لم تتحقق منها؟",
          "options": [
            "تراجعها أو تزيلها",
            "تتركها وكأنها مؤكدة",
            "تستبدلها بقول بلا مصدر",
            "تنقلها إلى الخاتمة فقط"
          ],
          "correct": 0
        },
        {
          "type": "tf",
          "text": "النموذج التعليمي يغني عن اعتماد المدرس للمحتوى العلمي.",
          "options": [
            "صح",
            "خطأ"
          ],
          "correct": 1
        }
      ],
      "demo": true,
      "modelCourse": true
    },
    {
      "id": 13,
      "title": "اللغة العربية — مفاتيح الدراسة (نموذج متكامل)",
      "book": "مذكرة تدريبية مدمجة في الدروس",
      "author": "إعداد النموذج التجريبي",
      "teacher": "مدرّس النموذج التجريبي",
      "section": "اللغة العربية",
      "level": "مبتدئ",
      "prefix": "LB",
      "code": "LB-2026-000013",
      "pass": 50,
      "lessonCount": 2,
      "lessonTime": 5,
      "finalCount": 4,
      "finalTime": 10,
      "lessons": [
        {
          "title": "بناء خطة الدراسة",
          "preface": "درس 1 من نموذج المبتدئ في اللغة العربية.",
          "intro": "قبل البدء في اللغة العربية، حدّد هدفاً صغيراً قابلاً للمراجعة، واقسم وقتك بين القراءة والتلخيص والاختبار.",
          "terms": "الهدف: نتيجة واضحة تريد الوصول إليها. المراجعة: العودة إلى ما سبق تعلّمه.",
          "blocks": [
            {
              "title": "القراءة الأولى",
              "text": "اقرأ عنوان الدرس ومقدمته، ثم استخرج الكلمات التي تحتاج إلى توضيح. دوّن السؤال قبل الانتقال إلى الشرح.",
              "images": []
            },
            {
              "title": "التلخيص والمراجعة",
              "text": "اكتب فكرة كل فقرة بأسلوبك، ثم قارن تلخيصك بنص الدرس. أعد قراءة المواضع التي لم تتمكن من تلخيصها.",
              "images": []
            }
          ],
          "refs": "مادة تدريبية أصلية لتجربة الدراسة والاختبارات في المنصة. ليست مقرراً علمياً معتمداً، وتحتاج مراجعة المدرس قبل اعتمادها.",
          "link": "",
          "questions": [
            {
              "type": "mcq",
              "text": "ما الخطوة المناسبة قبل القراءة التفصيلية؟",
              "options": [
                "قراءة العنوان والمقدمة",
                "تجاوز جميع العناوين",
                "البدء بالاختبار دون قراءة",
                "ترك الكلمات غير المفهومة"
              ],
              "correct": 0
            },
            {
              "type": "tf",
              "text": "تلخيص الفقرة بأسلوب الطالب يساعد على مراجعة فهمه.",
              "options": [
                "صح",
                "خطأ"
              ],
              "correct": 0
            }
          ]
        },
        {
          "title": "تدوين المفاهيم وتوثيقها",
          "preface": "درس 2 من نموذج المبتدئ في اللغة العربية.",
          "intro": "في دراسة اللغة العربية، نظّم ملاحظاتك بحيث تفصل بين نص المصدر وتلخيصك وأسئلتك.",
          "terms": "النقل: كتابة كلام المصدر كما ورد. التلخيص: التعبير عن فكرته بإيجاز.",
          "blocks": [
            {
              "title": "بطاقة المفهوم",
              "text": "أنشئ بطاقة تتضمن اسم المفهوم، وشرحه الوارد في المادة، ومثالاً تعليمياً، والسؤال الذي تريد مراجعته.",
              "images": []
            },
            {
              "title": "بطاقة المرجع",
              "text": "عند النقل، اذكر اسم الكتاب والمؤلف وموضع النص. لا تنسب تلخيصك إلى المؤلف بوصفه نقلاً حرفياً.",
              "images": []
            }
          ],
          "refs": "مادة تدريبية أصلية لتجربة الدراسة والاختبارات في المنصة. ليست مقرراً علمياً معتمداً، وتحتاج مراجعة المدرس قبل اعتمادها.",
          "link": "",
          "questions": [
            {
              "type": "mcq",
              "text": "ماذا تتضمن بطاقة المرجع؟",
              "options": [
                "الكتاب والمؤلف وموضع النص",
                "عنواناً بلا مصدر",
                "اسم الطالب فقط",
                "تاريخ الاختبار فقط"
              ],
              "correct": 0
            },
            {
              "type": "tf",
              "text": "يجوز عرض التلخيص الشخصي على أنه اقتباس حرفي من المصدر.",
              "options": [
                "صح",
                "خطأ"
              ],
              "correct": 1
            }
          ]
        }
      ],
      "questions": [
        {
          "type": "mcq",
          "text": "ما الخطوة المناسبة قبل القراءة التفصيلية؟",
          "options": [
            "قراءة العنوان والمقدمة",
            "تجاوز جميع العناوين",
            "البدء بالاختبار دون قراءة",
            "ترك الكلمات غير المفهومة"
          ],
          "correct": 0
        },
        {
          "type": "tf",
          "text": "تلخيص الفقرة بأسلوب الطالب يساعد على مراجعة فهمه.",
          "options": [
            "صح",
            "خطأ"
          ],
          "correct": 0
        },
        {
          "type": "mcq",
          "text": "ماذا تتضمن بطاقة المرجع؟",
          "options": [
            "الكتاب والمؤلف وموضع النص",
            "عنواناً بلا مصدر",
            "اسم الطالب فقط",
            "تاريخ الاختبار فقط"
          ],
          "correct": 0
        },
        {
          "type": "tf",
          "text": "يجوز عرض التلخيص الشخصي على أنه اقتباس حرفي من المصدر.",
          "options": [
            "صح",
            "خطأ"
          ],
          "correct": 1
        }
      ],
      "demo": true,
      "modelCourse": true
    },
    {
      "id": 14,
      "title": "اللغة العربية — تحليل المسائل (نموذج متكامل)",
      "book": "مذكرة تدريبية مدمجة في الدروس",
      "author": "إعداد النموذج التجريبي",
      "teacher": "مدرّس النموذج التجريبي",
      "section": "اللغة العربية",
      "level": "متوسط",
      "prefix": "LM",
      "code": "LM-2026-000014",
      "pass": 50,
      "lessonCount": 2,
      "lessonTime": 5,
      "finalCount": 4,
      "finalTime": 10,
      "lessons": [
        {
          "title": "تحليل المسألة قبل المقارنة",
          "preface": "درس 1 من نموذج المتوسط في اللغة العربية.",
          "intro": "بعد اجتياز المستوى الأول في اللغة العربية، انتقل من جمع المصطلحات إلى تنظيم عناصر المسألة وتحرير السؤال.",
          "terms": "تصوير المسألة: بيان المقصود بالسؤال وحدوده. محل المقارنة: الجانب المشترك الذي تتم دراسته.",
          "blocks": [
            {
              "title": "حدود السؤال",
              "text": "اكتب السؤال في جملة واضحة، ثم حدّد ما يدخل فيه وما لا يدخل. غموض السؤال قد يؤدي إلى مقارنة غير متجانسة.",
              "images": []
            },
            {
              "title": "جدول المقارنة",
              "text": "نظّم عناصر المقارنة في جدول: المصدر، والفكرة، وموضع الاتفاق، وموضع الاختلاف، وما يحتاج إلى مراجعة المدرس.",
              "images": []
            }
          ],
          "refs": "مادة تدريبية أصلية لتجربة الدراسة والاختبارات في المنصة. ليست مقرراً علمياً معتمداً، وتحتاج مراجعة المدرس قبل اعتمادها.",
          "link": "",
          "questions": [
            {
              "type": "mcq",
              "text": "ما المطلوب قبل مقارنة الإجابات؟",
              "options": [
                "تحديد السؤال وحدوده",
                "إهمال سياق السؤال",
                "حذف أسماء المصادر",
                "البدء بالنتيجة دون قراءة"
              ],
              "correct": 0
            },
            {
              "type": "tf",
              "text": "تحديد محل المقارنة يساعد على تنظيم البحث.",
              "options": [
                "صح",
                "خطأ"
              ],
              "correct": 0
            }
          ]
        },
        {
          "title": "التمييز بين النقل والاستنتاج",
          "preface": "درس 2 من نموذج المتوسط في اللغة العربية.",
          "intro": "في قراءة مصادر اللغة العربية، فرّق بين ما يصرح به النص وما يستنتجه القارئ منه.",
          "terms": "الاستنتاج: نتيجة يصل إليها الباحث من قراءته. السياق: الكلام المحيط بالعبارة.",
          "blocks": [
            {
              "title": "قراءة السياق",
              "text": "ارجع إلى ما قبل العبارة وما بعدها قبل تلخيص معناها. قد توضّح المقدمة أو القيود مقصود الكاتب.",
              "images": []
            },
            {
              "title": "عرض النتيجة",
              "text": "ضع النقل في موضعه مع توثيقه، ثم اعرض فهمك بصيغة تدل على أنه استنتاج قابل للمراجعة، ولا تجعله قولاً صريحاً للمؤلف.",
              "images": []
            }
          ],
          "refs": "مادة تدريبية أصلية لتجربة الدراسة والاختبارات في المنصة. ليست مقرراً علمياً معتمداً، وتحتاج مراجعة المدرس قبل اعتمادها.",
          "link": "",
          "questions": [
            {
              "type": "mcq",
              "text": "كيف تعرض استنتاجك؟",
              "options": [
                "تذكر أنه فهمك مع توثيق النص",
                "تنسبه اقتباساً حرفياً للمؤلف",
                "تحذف النص الذي استندت إليه",
                "تخفي مواضع عدم اليقين"
              ],
              "correct": 0
            },
            {
              "type": "tf",
              "text": "كل استنتاج للقارئ هو نص صريح للمؤلف.",
              "options": [
                "صح",
                "خطأ"
              ],
              "correct": 1
            }
          ]
        }
      ],
      "questions": [
        {
          "type": "mcq",
          "text": "ما المطلوب قبل مقارنة الإجابات؟",
          "options": [
            "تحديد السؤال وحدوده",
            "إهمال سياق السؤال",
            "حذف أسماء المصادر",
            "البدء بالنتيجة دون قراءة"
          ],
          "correct": 0
        },
        {
          "type": "tf",
          "text": "تحديد محل المقارنة يساعد على تنظيم البحث.",
          "options": [
            "صح",
            "خطأ"
          ],
          "correct": 0
        },
        {
          "type": "mcq",
          "text": "كيف تعرض استنتاجك؟",
          "options": [
            "تذكر أنه فهمك مع توثيق النص",
            "تنسبه اقتباساً حرفياً للمؤلف",
            "تحذف النص الذي استندت إليه",
            "تخفي مواضع عدم اليقين"
          ],
          "correct": 0
        },
        {
          "type": "tf",
          "text": "كل استنتاج للقارئ هو نص صريح للمؤلف.",
          "options": [
            "صح",
            "خطأ"
          ],
          "correct": 1
        }
      ],
      "demo": true,
      "modelCourse": true
    },
    {
      "id": 15,
      "title": "اللغة العربية — إعداد بحث (نموذج متكامل)",
      "book": "مذكرة تدريبية مدمجة في الدروس",
      "author": "إعداد النموذج التجريبي",
      "teacher": "مدرّس النموذج التجريبي",
      "section": "اللغة العربية",
      "level": "منتهٍ",
      "prefix": "LA",
      "code": "LA-2026-000015",
      "pass": 50,
      "lessonCount": 2,
      "lessonTime": 5,
      "finalCount": 4,
      "finalTime": 10,
      "lessons": [
        {
          "title": "تصميم بحث تعليمي قصير",
          "preface": "درس 1 من نموذج المنتهي في اللغة العربية.",
          "intro": "بعد شهادة المستوى المتوسط في اللغة العربية، جرّب إعداد بحث قصير يعرض سؤالاً محدداً وخطة مناسبة للإجابة.",
          "terms": "خطة البحث: ترتيب الخطوات والعناوين. نطاق البحث: حدوده الموضوعية.",
          "blocks": [
            {
              "title": "صياغة السؤال والخطة",
              "text": "اختر سؤالاً محدوداً، واكتب سبب اختياره، ثم قسّم العرض إلى مقدمة ومحاور وخاتمة. اجعل كل محور مرتبطاً بالسؤال.",
              "images": []
            },
            {
              "title": "جمع المادة",
              "text": "اجمع النصوص ذات الصلة وسجل بيانات مراجعها فوراً. افصل ملف الاقتباسات عن ملف أفكارك الأولية.",
              "images": []
            }
          ],
          "refs": "مادة تدريبية أصلية لتجربة الدراسة والاختبارات في المنصة. ليست مقرراً علمياً معتمداً، وتحتاج مراجعة المدرس قبل اعتمادها.",
          "link": "",
          "questions": [
            {
              "type": "mcq",
              "text": "بماذا تبدأ خطة البحث؟",
              "options": [
                "سؤال محدد ونطاق واضح",
                "قائمة نتائج بلا سؤال",
                "نصوص بلا توثيق",
                "عنوان بعيد عن المادة"
              ],
              "correct": 0
            },
            {
              "type": "tf",
              "text": "ينبغي أن ترتبط محاور البحث بسؤاله الرئيس.",
              "options": [
                "صح",
                "خطأ"
              ],
              "correct": 0
            }
          ]
        },
        {
          "title": "مراجعة البحث وعرضه",
          "preface": "درس 2 من نموذج المنتهي في اللغة العربية.",
          "intro": "المراجعة الأخيرة لبحث في اللغة العربية تشمل سلامة النقل، وترابط العرض، ووضوح النتائج وحدودها.",
          "terms": "المراجعة العلمية: فحص الأدلة والنقول. المراجعة التحريرية: فحص اللغة والتنظيم.",
          "blocks": [
            {
              "title": "مراجعة التوثيق",
              "text": "قارن كل اقتباس بمصدره، وطابق أسماء المؤلفين والكتب ومواضع النصوص. أزل أي نسبة لم تتمكن من التحقق منها.",
              "images": []
            },
            {
              "title": "مراجعة الخاتمة",
              "text": "اكتب النتائج التي يدعمها العرض وحدد ما بقي من أسئلة. اعرض البحث على المدرس للمراجعة، ولا تقدّم النموذج التعليمي على أنه فتوى أو دراسة محكّمة.",
              "images": []
            }
          ],
          "refs": "مادة تدريبية أصلية لتجربة الدراسة والاختبارات في المنصة. ليست مقرراً علمياً معتمداً، وتحتاج مراجعة المدرس قبل اعتمادها.",
          "link": "",
          "questions": [
            {
              "type": "mcq",
              "text": "ماذا تفعل بالنسبة التي لم تتحقق منها؟",
              "options": [
                "تراجعها أو تزيلها",
                "تتركها وكأنها مؤكدة",
                "تستبدلها بقول بلا مصدر",
                "تنقلها إلى الخاتمة فقط"
              ],
              "correct": 0
            },
            {
              "type": "tf",
              "text": "النموذج التعليمي يغني عن اعتماد المدرس للمحتوى العلمي.",
              "options": [
                "صح",
                "خطأ"
              ],
              "correct": 1
            }
          ]
        }
      ],
      "questions": [
        {
          "type": "mcq",
          "text": "بماذا تبدأ خطة البحث؟",
          "options": [
            "سؤال محدد ونطاق واضح",
            "قائمة نتائج بلا سؤال",
            "نصوص بلا توثيق",
            "عنوان بعيد عن المادة"
          ],
          "correct": 0
        },
        {
          "type": "tf",
          "text": "ينبغي أن ترتبط محاور البحث بسؤاله الرئيس.",
          "options": [
            "صح",
            "خطأ"
          ],
          "correct": 0
        },
        {
          "type": "mcq",
          "text": "ماذا تفعل بالنسبة التي لم تتحقق منها؟",
          "options": [
            "تراجعها أو تزيلها",
            "تتركها وكأنها مؤكدة",
            "تستبدلها بقول بلا مصدر",
            "تنقلها إلى الخاتمة فقط"
          ],
          "correct": 0
        },
        {
          "type": "tf",
          "text": "النموذج التعليمي يغني عن اعتماد المدرس للمحتوى العلمي.",
          "options": [
            "صح",
            "خطأ"
          ],
          "correct": 1
        }
      ],
      "demo": true,
      "modelCourse": true
    }
  ],
  "news": [
    {
      "id": 1,
      "title": "مرحباً بكم في أكاديمية الفقه المالكي",
      "text": "رحلة علمية متدرجة، تجمع بين دراسة المتون وفهم المسائل ومراجعة المكتسبات. هذا خبر تجريبي قابل للتعديل من الإدارة.",
      "date": "2026-10-24"
    }
  ],
  "about": "أكاديمية الفقه المالكي مساحة تعليمية تعنى بتقريب العلوم الشرعية، وتيسير دراسة الفقه المالكي وفق مسار علمي متدرج. نطمح إلى بناء تجربة تجمع بين التأصيل، والمراجعة، والتقويم المستمر.",
  "rules": "أن يكون المقال أصيلاً، موثق المراجع، واضح اللغة، ملتزماً بأدب البحث العلمي. تخضع جميع المشاركات لمراجعة الإدارة قبل النشر.",
  "settings": {
    "green": "#143e43",
    "gold": "#c9a434",
    "logo": "assets/logo.jpg"
  },
  "seq": 15,
  "prefixHistory": [
    "MF",
    "AA",
    "AB",
    "FB",
    "FM",
    "FA",
    "HB",
    "HM",
    "HA",
    "UB",
    "UM",
    "UA",
    "LB",
    "LM",
    "LA"
  ],
  "learningPathsVersion": 1
}
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createAcademy } from './backend.mjs';
const port=Number(process.env.PORT||3000);
const publicUrl=process.env.PUBLIC_URL||`http://localhost:${port}`;
if(process.env.NODE_ENV==='production'&&!publicUrl.startsWith('https://'))throw new Error('Production requires PUBLIC_URL=https://your-domain');
const application=createAcademy({databasePath:process.env.DATABASE_PATH||'data/academy.sqlite',adminPassword:process.env.ADMIN_PASSWORD,publicUrl});
const root=path.resolve(fileURLToPath(new URL('./public/',import.meta.url)));
const types={'.html':'text/html; charset=utf-8','.mjs':'application/javascript; charset=utf-8','.js':'application/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.jpg':'image/jpeg','.png':'image/png','.svg':'image/svg+xml','.webp':'image/webp','.pdf':'application/pdf','.json':'application/json','.webmanifest':'application/manifest+json','.txt':'text/plain; charset=utf-8'};
const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,publicUrl);
  try{
    if(url.pathname.startsWith('/api/')){
      const chunks=[];let bytes=0;
      for await(const chunk of req){bytes+=chunk.length;if(bytes>(url.pathname==='/api/admin/course-book'?60:url.pathname==='/api/admin/lesson-pdf'?25:url.pathname==='/api/admin/lesson-image'?5:16)*1024*1024){res.writeHead(413,{'content-type':'application/json'});res.end(JSON.stringify({error:'حجم الملف أكبر من الحد المسموح.'}));return}chunks.push(chunk)}
      const headers=new Headers();for(const [name,value] of Object.entries(req.headers))if(value!==undefined)headers.set(name,Array.isArray(value)?value.join(','):value);
      const ip=process.env.TRUST_PROXY==='1'?String(req.headers['x-forwarded-for']||req.socket.remoteAddress).split(',')[0].trim():req.socket.remoteAddress;
      headers.set('x-academy-client-ip',ip||'unknown');
      const request=new Request(url,{method:req.method,headers,...(!['GET','HEAD'].includes(req.method)?{body:Buffer.concat(chunks)}:{})});
      const response=await application.handle(request);
      res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));return;
    }
    if(!['GET','HEAD'].includes(req.method)){res.writeHead(405);res.end();return}
    const requested=url.pathname==='/'?'index.html':decodeURIComponent(url.pathname).replace(/^\//,'');
    const file=path.resolve(root,requested);if(!file.startsWith(root+path.sep)){res.writeHead(403);res.end();return}
    const info=await stat(file);if(!info.isFile())throw Error('not found');
    res.writeHead(200,{'content-type':types[path.extname(file)]||'application/octet-stream','cache-control':'no-cache','x-content-type-options':'nosniff','referrer-policy':'same-origin','x-frame-options':'DENY','content-security-policy':"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; frame-src 'self' https: data: blob:; media-src 'self' https: blob:; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'self'"});
    res.end(req.method==='HEAD'?undefined:await readFile(file));
  }catch{res.writeHead(404,{'content-type':'text/plain; charset=utf-8'});res.end('الصفحة غير موجودة')}
});
server.listen(port,'0.0.0.0',()=>console.log(`Academy listening on port ${port}`));
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>server.close(()=>{application.close();process.exit(0)}));


node_modules
.git
.env
data
backups
android
*.sqlite*
*.p12
*.jks

PORT=3000
PUBLIC_URL=http://localhost:3000
DATABASE_PATH=data/academy.sqlite
# Set your own unique admin password before first start (12 characters minimum).
ADMIN_PASSWORD=
NODE_ENV=development
TRUST_PROXY=0

NODE_ENV=production
PUBLIC_URL=https://your-academy-domain.example
DATABASE_PATH=/data/academy.sqlite
ADMIN_PASSWORD=
PORT=3000
TRUST_PROXY=0

node_modules/
data/
.env
*.sqlite*
*.p12
*.jks
*PASSWORD*
android/build/
backups/

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

# إجراء التطوير المعتمد

- بعد كل تعديل مطلوب، اختبر الوظائف المتأثرة والفحوص المعتمدة، ثم ارفع التحديث إلى مستودع malikicollege-cell/maliki-academy-learning على فرع main عند نجاح الاختبارات. تفويض المستخدم قائم لهذا الإجراء ولا يتطلب تأكيداً جديداً لكل تحديث.
- قبل الرفع راجع أحدث حالة للمستودع، واحفظ التعديلات الخارجية. لا تفرض استبدال الفرع.
- أبلغ المستخدم بما اختبر فعلياً وبأي مراجعة بصرية أو على الهاتف لم تكتمل. لا تصف ملف AAB بأنه محدث دون بنائه وفحصه.
- لا ترفع بيانات الطلاب أو قاعدة البيانات الفعلية أو ملفات البيئة السرية أو مفاتيح توقيع التطبيق.

import {courseReportDocx} from './reports.mjs';
import {installPermissions} from './permissions.mjs';
import {installNotifications} from './notifications.mjs';
import {installAccounts} from './accounts.mjs';
import {installDisplayDemo} from './display-demo.mjs';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID, scryptSync, timingSafeEqual, createHash, randomInt } from 'node:crypto';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const hash=v=>createHash('sha256').update(v).digest('hex');
const passwordHash=p=>{const salt=randomBytes(16).toString('hex');return salt+':'+scryptSync(p,salt,64).toString('hex')};
const passwordMatches=(p,stored)=>{try{const [salt,value]=stored.split(':');return timingSafeEqual(scryptSync(p,salt,64),Buffer.from(value,'hex'))}catch{return false}};
const level=v=>{v=String(v||'').replace(/[ًٌٍَُِّْ]/g,'');return v==='متوسط'?'متوسط':['منتهي','منته','منتهى'].includes(v)?'منتهٍ':'مبتدئ'};
const fail=(status,message)=>{const e=new Error(message);e.status=status;throw e};
const parse=value=>JSON.parse(value);
const clone=value=>structuredClone(value);
const json=(data,status=200,headers={})=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store',...headers}});
const LIMIT=16*1024*1024;
const text=(v,max=100000)=>String(v??'').slice(0,max);

export function balancedQuestions(bank,count){const shuffle=items=>{const a=structuredClone(items);for(let i=a.length-1;i>0;i--){const j=randomInt(i+1);[a[i],a[j]]=[a[j],a[i]]}return a};const buckets=shuffle(['mcq','tf']).map(type=>shuffle(bank.filter(q=>(q.type||'mcq')===type))),selected=[];while(selected.length<count&&buckets.some(b=>b.length))for(const bucket of buckets)if(bucket.length&&selected.length<count)selected.push(bucket.pop());return shuffle(selected)}
const reportGrade=n=>n>=90?'امتياز':n>=80?'جيد جداً':n>=70?'جيد':n>=60?'متوسط':n>=50?'مقبول':'راسب';
const csvCell=v=>'"'+String(v??'').replace(/^[=+@\-\t\r]/,"'$&").replaceAll('"','""')+'"';
export function createAcademy({databasePath='data/academy.sqlite',adminPassword,publicUrl='http://localhost:3000',seed,displayDemo=process.env.ACADEMY_DISPLAY_DEMO!=='0'&&!process.env.NODE_TEST_CONTEXT}={}) {
  if(databasePath!==':memory:')mkdirSync(dirname(databasePath),{recursive:true});
  const database=new DatabaseSync(databasePath);
  database.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
  CREATE TABLE IF NOT EXISTS content (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1);
  CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY,email TEXT UNIQUE NOT NULL,name TEXT NOT NULL,password_hash TEXT NOT NULL,role TEXT NOT NULL,joined TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),csrf TEXT NOT NULL,expires INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS progress (user_id TEXT NOT NULL REFERENCES users(id),course_id INTEGER NOT NULL,data TEXT NOT NULL,PRIMARY KEY(user_id,course_id));
  CREATE TABLE IF NOT EXISTS certificates (id TEXT PRIMARY KEY,user_id TEXT,course_id INTEGER,is_test INTEGER NOT NULL DEFAULT 0,data TEXT NOT NULL,created INTEGER NOT NULL);
  CREATE UNIQUE INDEX IF NOT EXISTS one_student_certificate ON certificates(user_id,course_id) WHERE is_test=0;
  CREATE TABLE IF NOT EXISTS exams (id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),course_id INTEGER NOT NULL,lesson_uid TEXT,questions TEXT NOT NULL,expires INTEGER NOT NULL,submitted INTEGER NOT NULL DEFAULT 0,result TEXT);
  CREATE TABLE IF NOT EXISTS articles (id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),data TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS article_views (article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,viewer TEXT NOT NULL,day INTEGER NOT NULL,PRIMARY KEY(article_id,viewer,day));
  CREATE TABLE IF NOT EXISTS article_ratings (article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,user_id TEXT NOT NULL REFERENCES users(id),stars INTEGER NOT NULL CHECK(stars BETWEEN 1 AND 5),PRIMARY KEY(article_id,user_id));
  CREATE TABLE IF NOT EXISTS comments (id TEXT PRIMARY KEY,article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,user_id TEXT,name TEXT NOT NULL,text TEXT NOT NULL,image TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',created INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS counters (name TEXT PRIMARY KEY,value INTEGER NOT NULL DEFAULT 0);
  INSERT OR IGNORE INTO counters(name,value) VALUES ('visits',0);`);
  const query=(sql,...args)=>database.prepare(sql).get(...args);
  const rows=(sql,...args)=>database.prepare(sql).all(...args);
  const run=(sql,...args)=>database.prepare(sql).run(...args);
  const atomic=fn=>{database.exec('BEGIN IMMEDIATE');try{const r=fn();database.exec('COMMIT');return r}catch(e){database.exec('ROLLBACK');throw e}};
  if(!query('SELECT id FROM users WHERE role=?','admin')) {
    if(!adminPassword||adminPassword.length<12)throw new Error('Set ADMIN_PASSWORD to a unique password of at least 12 characters before first start.');
    run('INSERT INTO users VALUES (?,?,?,?,?,?)',randomUUID(),'admin@academy.internal','إدارة الأكاديمية',passwordHash(adminPassword),'admin',new Date().toISOString());
  }
  if(!query('SELECT id FROM content WHERE id=1')) {
    const data=clone(seed||JSON.parse(readFileSync(new URL('./seed.json',import.meta.url),'utf8')));
    delete data.settings.pin;
    for(const c of data.courses)for(const l of c.lessons)l.uid||=randomUUID();
    run('INSERT INTO content(id,data) VALUES (1,?)',JSON.stringify(data));
  }
  for(const [counter,isTest] of [['certificate_seq',0],['test_certificate_seq',1]]){let maximum=0;for(const row of rows('SELECT id FROM certificates WHERE is_test=?',isTest)){const match=/^[A-Z]{2}-\d{4}-(\d{6})$/.exec(row.id);if(match)maximum=Math.max(maximum,Number(match[1]))}run('INSERT OR IGNORE INTO counters(name,value) VALUES (?,?)',counter,maximum);run('UPDATE counters SET value=MAX(value,?) WHERE name=?',maximum,counter)}
  function nextCertificateId(prefix,isTest=false){const counter=isTest?'test_certificate_seq':'certificate_seq',current=query('SELECT value FROM counters WHERE name=?',counter).value;if(current>=999999)fail(409,'استُنفدت أرقام الشهادات ذات الست خانات. تواصل مع الإدارة.');run('UPDATE counters SET value=value+1 WHERE name=?',counter);const year=new Intl.DateTimeFormat('en',{timeZone:'Asia/Amman',year:'numeric'}).format(new Date());return prefix+'-'+year+'-'+String(current+1).padStart(6,'0')}
  const content=()=>{const r=query('SELECT data,revision FROM content WHERE id=1');return {...parse(r.data),revision:r.revision}};
  const certs=uid=>rows('SELECT data FROM certificates WHERE user_id=? AND is_test=0',uid).map(r=>parse(r.data));
  const eligible=(c,u)=>{const required=level(c.level)==='متوسط'?'مبتدئ':level(c.level)==='منتهٍ'?'متوسط':null;return !required||!!u&&certs(u.id).some(cert=>cert.section===c.section&&level(cert.level)===required)};
  const progressFor=(uid,cid)=>{const r=query('SELECT data FROM progress WHERE user_id=? AND course_id=?',uid,cid);return r?parse(r.data):{lessons:{}}};
  const storeProgress=(uid,cid,p)=>run('INSERT INTO progress VALUES (?,?,?) ON CONFLICT(user_id,course_id) DO UPDATE SET data=excluded.data',uid,cid,JSON.stringify(p));
  const studentData=(u,config)=>{const progress={};for(const r of rows('SELECT course_id,data FROM progress WHERE user_id=?',u.id)){const p=parse(r.data),course=config.courses.find(c=>c.id===r.course_id);const lessons={};course?.lessons.forEach((l,i)=>{if(p.lessons[l.uid]!==undefined)lessons[i]=p.lessons[l.uid]});progress[r.course_id]={...p,lessons}}return {id:u.id,name:u.name,email:u.email,joined:u.joined,...accounts.profileFor(u.id),progress}};
  const ratingStats=id=>query('SELECT COALESCE(AVG(stars),0) ratingAverage,COUNT(*) ratingCount FROM article_ratings WHERE article_id=?',id);
  const state=(session)=>{const config=content(),isAdmin=session?.user.role==='admin',managed=access.manager(session),scope=access.allowed(session),u=session?.user;delete config.settings.pin;const students=isAdmin?rows("SELECT id,name,email,joined FROM users WHERE role='student'").map(x=>studentData(x,config)):u?.role==='student'?[studentData(u,config)]:[];
    const courses=config.courses.filter(c=>(isAdmin||u?.role==='staff')?(isAdmin||scope.includes(c.id)):access.published(c)).map(c=>{c={...c,views:query('SELECT COUNT(*) total FROM course_views WHERE course_id=?',c.id).total,certificateReady:access.ready(c.id),certificateVersion:managed?access.certificateRecord(c.id)?.version:null,publicationStatus:c.hidden?'hidden':access.ready(c.id)?'published':'pending_certificate',canDelete:managed?access.canDelete(session,c.id):undefined};if(managed)return c;const enrolled=u?.role==='student'&&!!query('SELECT user_id FROM progress WHERE user_id=? AND course_id=?',u.id,c.id),canRead=enrolled&&eligible(c,u);return {...c,questions:[],lessons:c.lessons.map(l=>canRead?{...l,pdf:!!l.pdf,questions:[]}:{title:l.title,uid:l.uid,questions:[]})}});
    const articles=rows('SELECT data FROM articles').map(x=>({...parse(x.data),...ratingStats(parse(x.data).id),views:query('SELECT COUNT(*) total FROM article_views WHERE article_id=?',parse(x.data).id).total,commentCount:query("SELECT COUNT(*) total FROM comments WHERE article_id=? AND status='approved'",parse(x.data).id).total})).filter(a=>access.canReview(session)||a.status==='approved'&&!a.hidden||u&&a.userId===u.id).map(a=>{if(access.canReview(session)||u&&a.userId===u.id)return a;const result={...a};delete result.email;delete result.userId;delete result.reason;delete result.deletionRequest;return result});
    const certificates=managed?rows('SELECT data FROM certificates').map(x=>parse(x.data)).filter(c=>isAdmin||scope.includes(c.courseId)&&!c.isTest).map(c=>isAdmin?c:{courseId:c.courseId,studentId:c.studentId}):u?certs(u.id):[];
    return {state:{...config,courses,students,certificates,articles,...accounts.extras(session),...notificationCenter.snapshot(session),visits:isAdmin?query('SELECT value FROM counters WHERE name=?','visits').value:0},revision:config.revision,auth:u?{id:u.id,role:u.role,name:u.name,...access.auth(session)}:null,csrf:session?.csrf||null};
  };
  function sessionOf(request){const cookie=request.headers.get('cookie')||'',token=/(?:^|;\s*)academy_session=([A-Za-z0-9_-]+)/.exec(cookie)?.[1];if(!token)return null;const r=query('SELECT user_id,csrf,expires FROM sessions WHERE token_hash=?',hash(token));if(!r||r.expires<Date.now())return null;const u=query('SELECT id,email,name,role,joined FROM users WHERE id=?',r.user_id);return u&&(u.role!=='staff'||access.staff(u.id)?.enabled)?{user:u,csrf:r.csrf,token}:null}
  function openSession(user){const token=randomBytes(32).toString('base64url'),csrf=randomBytes(24).toString('hex');run('DELETE FROM sessions WHERE expires < ?',Date.now());run('INSERT INTO sessions VALUES (?,?,?,?)',hash(token),user.id,csrf,Date.now()+7*86400000);return {user,token,csrf}}
  function cookie(token,maxAge=604800){return `academy_session=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAge}${publicUrl.startsWith('https://')?'; Secure':''}`}
  const limits=new Map();
  function rate(key,max,period){const now=Date.now(),old=limits.get(key);if(!old||old.until<now){if(limits.size>10000)limits.clear();limits.set(key,{count:1,until:now+period});return}if(++old.count>max)fail(429,'طلبات كثيرة. حاول لاحقاً.')}
  function validateConfig(data,old){for(const key of ['courses','sections','articleSections','news'])if(!Array.isArray(data[key]))fail(400,'بيانات إعدادات غير صالحة.');if(data.courses.length>650)fail(400,'عدد الدورات يتجاوز سعة الرموز المتاحة.');const prefixCounts=new Map();for(const c of data.courses){const prefix=String(c?.prefix||c?.code?.split('-')[0]||'').toUpperCase();if(prefixCounts.has(prefix))fail(400,'رمز الحرفين '+prefix+' مستخدم لدورة أخرى ظاهرة أو مخفية. اختر رمزاً مختلفاً.');prefixCounts.set(prefix,1)}const ids=new Set(),prefixes=new Set(),fullCodes=new Set();for(const c of data.courses){if(!c||typeof c!=='object'||!Number.isSafeInteger(c.id)||c.id<1||ids.has(c.id)||typeof c.title!=='string'||!c.title.trim()||!data.sections.includes(c.section))fail(400,'دورة غير صالحة أو مكررة.');ids.add(c.id);for(const key of ['certificateReady','certificateVersion','publicationStatus','canDelete'])delete c[key];const p=String(c.prefix||c.code?.split('-')[0]||'').toUpperCase();if(prefixes.has(p))fail(400,'رمز الحرفين '+p+' مستخدم لدورة أخرى ظاهرة أو مخفية. اختر رمزاً مختلفاً.');if(!/^[A-Z]{2}$/.test(p)||p==='ZZ'||prefixes.has(p)||!new RegExp('^'+p+'-\\d{4}-\\d{6}$').test(c.code)||fullCodes.has(c.code))fail(400,'رمز الدورة يجب أن يكون فريداً، وZZ محجوز للتجربة.');const before=old.courses.find(x=>x.id===c.id);if((old.prefixHistory||[]).includes(p)&&before?.prefix!==p)fail(400,'بادئة الرمز محجوزة لدورة سابقة.');prefixes.add(p);fullCodes.add(c.code);if(c.retakeDelayHours!==undefined&&(!Number.isInteger(c.retakeDelayHours)||c.retakeDelayHours<0||c.retakeDelayHours>8760))fail(400,'مدة إعادة الشامل يجب أن تكون من صفر إلى 8760 ساعة.');delete c.views;c.prefix=p;if(c.books!==undefined){if(!Array.isArray(c.books)||c.books.length>5)fail(400,'يمكن إضافة خمسة كتب ومراجع كحد أقصى لكل دورة.');const bookIds=new Set();for(const b of c.books){if(!b||typeof b.name!=='string'||!b.name.trim()||b.name.length>300||bookIds.has(b.id)||!query('SELECT id FROM lesson_pdfs WHERE id=? AND course_id=? AND lesson_uid=?',b.id,c.id,'course'))fail(400,'مرجع كتاب الدورة غير صالح.');bookIds.add(b.id);}}for(const [key,max] of [['pass',100],['lessonCount',100],['finalCount',200],['lessonTime',180],['finalTime',300]])if(!Number.isInteger(c[key])||c[key]<(key==='pass'?50:1)||c[key]>max)fail(400,'إعدادات اختبار غير صالحة.');if(!Array.isArray(c.lessons)||!Array.isArray(c.questions))fail(400,'دروس أو أسئلة غير صالحة.');const lessonIds=new Set();for(const l of c.lessons){if(!l||typeof l!=='object')fail(400,'درس غير صالح.');l.uid||=randomUUID();if(lessonIds.has(l.uid))fail(400,'معرف درس مكرر.');lessonIds.add(l.uid);if(l.links!==undefined){if(!Array.isArray(l.links)||l.links.length>3)fail(400,'يمكن إضافة ثلاثة روابط مساندة لكل درس.');l.links=l.links.map(v=>{let link=String(v).trim();if(!/^[a-z][a-z0-9+.-]*:/i.test(link))link='https://'+link;try{const u=new URL(link);if(!['http:','https:'].includes(u.protocol))throw Error();return u.href}catch{fail(400,'رابط مساند غير صالح.')}});}if(l.pdfAssetId&&!query('SELECT id FROM lesson_pdfs WHERE id=? AND course_id=? AND lesson_uid=?',l.pdfAssetId,c.id,l.uid))fail(400,'مرجع الكتاب غير صالح.');if(l.link){let link=String(l.link).trim();if(!/^[a-z][a-z0-9+.-]*:/i.test(link))link='https://'+link;try{const u=new URL(link);if(!['http:','https:'].includes(u.protocol))throw Error();l.link=u.href}catch{fail(400,'رابط الدرس المساند غير صالح.')}}validateQuestions(l.questions)}validateQuestions(c.questions)}data.prefixHistory=[...new Set([...(old.prefixHistory||[]),...prefixes])];data.seq=Math.max(old.seq||0,...data.courses.map(c=>c.id));if(!data.settings||!/^#[0-9a-f]{6}$/i.test(data.settings.green)||!/^#[0-9a-f]{6}$/i.test(data.settings.gold))fail(400,'ألوان الهوية غير صالحة.');if(data.settings.platformName!==undefined){if(typeof data.settings.platformName!=='string'||!data.settings.platformName.trim()||data.settings.platformName.trim().length>100)fail(400,'اسم المنصة مطلوب ولا يزيد على 100 حرف.');data.settings.platformName=data.settings.platformName.trim();}if(data.settings.homeCertificateImage){const image=/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(data.settings.homeCertificateImage);if(!image)fail(400,'صورة نموذج الشهادة غير صالحة.');const bytes=Buffer.from(image[2],'base64');if(bytes.length>5*1048576)fail(413,'صورة نموذج الشهادة حتى 5 ميغابايت.');const valid=image[1]==='png'?bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])):image[1]==='jpeg'?bytes[0]===255&&bytes[1]===216&&bytes[2]===255:bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP';if(!valid)fail(400,'ملف الصورة غير صالح.');}delete data.settings.pin;return data}
  function validateQuestions(questions){if(!Array.isArray(questions))fail(400,'بنك أسئلة غير صالح.');for(const q of questions)if(!q||typeof q!=='object'||typeof q.text!=='string'||!q.text.trim()||!Array.isArray(q.options)||![2,4].includes(q.options.length)||!Number.isInteger(q.correct)||q.correct<0||q.correct>=q.options.length||q.options.some(x=>typeof x!=='string'||!x.trim()))fail(400,'خيارات السؤال أو الإجابة غير صالحة.')}
  function requireStudent(session){if(session?.user.role!=='student')fail(401,'سجّل الدخول بحساب طالب.');return session.user}
  function requireAdmin(session){if(session?.user.role!=='admin')fail(403,'هذه العملية متاحة للإدارة فقط.')}
  function accessibleCourse(id,u){const c=content().courses.find(c=>c.id===Number(id)&&!c.hidden);if(!c)fail(404,'الدورة غير متاحة.');if(!access.published(c))fail(409,'الدورة بانتظار إضافة قالب شهادة خاص بها.');if(!eligible(c,u))fail(403,'تحتاج شهادة من المستوى السابق في القسم نفسه.');return c}
  database.exec('CREATE TABLE IF NOT EXISTS lesson_pdfs (id TEXT PRIMARY KEY, course_id INTEGER NOT NULL, lesson_uid TEXT NOT NULL, bytes BLOB NOT NULL)');
  database.exec('CREATE TABLE IF NOT EXISTS lesson_images (id TEXT PRIMARY KEY, course_id INTEGER NOT NULL, lesson_uid TEXT NOT NULL, bytes BLOB NOT NULL, mime TEXT NOT NULL)');
  if(!rows('PRAGMA table_info(exams)').some(c=>c.name==='completed_at'))database.exec('ALTER TABLE exams ADD COLUMN completed_at INTEGER');
  database.exec('CREATE TABLE IF NOT EXISTS course_views (course_id INTEGER NOT NULL,viewer TEXT NOT NULL,created INTEGER NOT NULL,PRIMARY KEY(course_id,viewer)); CREATE TABLE IF NOT EXISTS course_view_browsers (token_hash TEXT PRIMARY KEY,account_viewer TEXT)');
  const accounts=installAccounts({database,state,openSession,cookie,passwordHash,passwordMatches,hash,rate});
  const notificationCenter=installNotifications({database});
  const access=installPermissions({database,content,state,openSession,cookie,passwordHash,passwordMatches,rate});
  // Curated content is applied only to the normal deployment seed, never to test/custom seeds.
  if(seed===undefined&&displayDemo){
    const logo=readFileSync(new URL('./public/assets/logo.jpg',import.meta.url)).toString('base64');
    installDisplayDemo({database,content,atomic,passwordHash,certificateTemplate:'data:image/jpeg;base64,'+logo});
  }
  async function handle(request){try {
    const url=new URL(request.url),path=url.pathname,method=request.method,session=sessionOf(request),ip=request.headers.get('x-academy-client-ip')||'local';
    if(!path.startsWith('/api/'))return json({error:'غير موجود'},404);
    rate('all:'+ip,300,60000);
    if(method==='GET'&&path==='/api/admin/course-report'){
      access.requireManager(session);const c=content().courses.find(c=>c.id===Number(url.searchParams.get('courseId')));if(!c)fail(404,'الدورة غير موجودة.');access.requireCourse(session,c.id);
      const students=rows('SELECT u.id,u.name,u.email FROM progress p JOIN users u ON u.id=p.user_id WHERE p.course_id=? ORDER BY u.name',c.id).map(u=>{const exams=rows('SELECT result,expires,submitted,completed_at FROM exams WHERE user_id=? AND course_id=? AND lesson_uid IS NULL ORDER BY COALESCE(completed_at,expires) DESC',u.id,c.id).filter(e=>e.submitted||e.expires+5000<Date.now()),last=exams[0],result=last?(last.submitted?parse(last.result):{score:0,passed:false}):null,cert=query('SELECT data FROM certificates WHERE user_id=? AND course_id=? AND is_test=0',u.id,c.id),certificate=cert?parse(cert.data):null,score=certificate?.score??result?.score??null,passed=!!certificate||!!result?.passed;return {id:u.id,name:u.name,email:u.email,score,grade:score===null?'لم يتقدم للشامل':reportGrade(score),status:passed?'ناجح':result?'راسب':'لم يتقدم للشامل',attempts:exams.length,certificateId:certificate?.id||'',lastAttemptAt:last?(last.completed_at||last.expires):null}});
      const scores=students.filter(u=>u.score!==null),stats={enrolled:students.length,examined:scores.length,passed:students.filter(u=>u.status==='ناجح').length,failed:students.filter(u=>u.status==='راسب').length,average:scores.length?Math.round(scores.reduce((n,u)=>n+u.score,0)/scores.length*100)/100:null};
      if(url.searchParams.get('format')==='csv'){const lines=[['الدورة','الاسم','البريد الإلكتروني','الحالة','العلامة','التقدير','محاولات الشامل','رمز الشهادة'],...students.map(u=>[c.title,u.name,u.email,u.status,u.score??'',u.grade,u.attempts,u.certificateId])];return new Response('\uFEFF'+lines.map(row=>row.map(csvCell).join(',')).join('\r\n'),{headers:{'content-type':'text/csv; charset=utf-8','content-disposition':'attachment; filename="course-'+c.prefix+'-report.csv"','cache-control':'no-store'}})}const report={course:{id:c.id,title:c.title,code:c.code},stats,students};if(url.searchParams.get('format')==='docx')return new Response(courseReportDocx(report,content().settings.platformName),{headers:{'content-type':'application/vnd.openxmlformats-officedocument.wordprocessingml.document','content-disposition':'attachment; filename="course-'+c.prefix+'-report.docx"','cache-control':'no-store'}});return json(report);
    }
    if(method==='GET'&&['/api/admin/staff','/api/admin/course-message','/api/admin/student-messages','/api/admin/course-certificate','/api/certificates/layout'].includes(path))return access.handle({path,method,session,request,ip});
    if(method==='GET'&&path==='/api/state')return json(state(session));
    if(path==='/api/course-book'&&method==='GET'){
      const c=content().courses.find(c=>c.id===Number(url.searchParams.get('courseId'))),id=url.searchParams.get('bookId');if(!c||(c.books||[]).every(b=>b.id!==id))fail(404,'الكتاب غير متاح.');
      if(access.manager(session)){access.requireCourse(session,c.id)}else{const u=requireStudent(session);accessibleCourse(c.id,u);if(!query('SELECT user_id FROM progress WHERE user_id=? AND course_id=?',u.id,c.id))fail(403,'التحق بالدورة أولاً.');}
      const asset=query('SELECT bytes FROM lesson_pdfs WHERE id=? AND course_id=? AND lesson_uid=?',id,c.id,'course');if(!asset)fail(404,'الكتاب غير متاح.');return new Response(asset.bytes,{headers:{'content-type':'application/pdf','cache-control':'private, no-store','content-disposition':'inline','x-content-type-options':'nosniff'}});
    }
    if(path==='/api/admin/course-book'&&method==='POST'){
      access.requireManager(session);if(request.headers.get('x-csrf-token')!==session.csrf)fail(403,'أعد تحميل الصفحة.');const origin=request.headers.get('origin');if(origin&&origin!==new URL(publicUrl).origin)fail(403,'مصدر غير مسموح.');const cid=Number(url.searchParams.get('courseId'));if(!content().courses.some(c=>c.id===cid))fail(404,'الدورة غير موجودة.');access.requireCourse(session,cid);const bytes=Buffer.from(await request.arrayBuffer());if(bytes.length>60*1024*1024)fail(413,'الكتاب لا يزيد على 60 ميغابايت.');if(bytes.subarray(0,5).toString()!=='%PDF-')fail(400,'اختر ملف PDF صحيحاً.');const id=hash(Buffer.concat([Buffer.from(cid+':course:'),bytes]));run('INSERT OR IGNORE INTO lesson_pdfs VALUES (?,?,?,?)',id,cid,'course',bytes);return json({id,size:bytes.length});
    }
    if(['/api/lesson-pdf','/api/lesson-image'].includes(path)&&method==='GET'){
      const c=content().courses.find(c=>c.id===Number(url.searchParams.get('courseId'))),l=c?.lessons.find(l=>l.uid===url.searchParams.get('lessonUid'));
      if(!l)fail(404,'الكتاب غير متاح.');
      if(access.manager(session)){access.requireCourse(session,c.id)}else{const u=requireStudent(session);accessibleCourse(c.id,u);if(!query('SELECT user_id FROM progress WHERE user_id=? AND course_id=?',u.id,c.id))fail(403,'التحق بالدورة أولاً.');}
      if(path==='/api/lesson-image'){
        const id=url.searchParams.get('imageId'),src='/api/lesson-image?courseId='+c.id+'&lessonUid='+encodeURIComponent(l.uid)+'&imageId='+id;
        if(!(l.blocks||[]).some(b=>(b.images||[]).includes(src)))fail(404,'الصورة غير متاحة.');
        const image=query('SELECT bytes,mime FROM lesson_images WHERE id=? AND course_id=? AND lesson_uid=?',id,c.id,l.uid);if(!image)fail(404,'الصورة غير متاحة.');
        return new Response(image.bytes,{headers:{'content-type':image.mime,'cache-control':'private, no-store','x-content-type-options':'nosniff'}});
      }
      const asset=l.pdfAssetId&&query('SELECT bytes FROM lesson_pdfs WHERE id=? AND course_id=? AND lesson_uid=?',l.pdfAssetId,c.id,l.uid);
      const bytes=asset?.bytes||(typeof l.pdf==='string'&&l.pdf.startsWith('data:application/pdf;base64,')?Buffer.from(l.pdf.split(',')[1],'base64'):null);
      if(!bytes)fail(404,'لا يوجد كتاب لهذا الدرس.');
      return new Response(bytes,{headers:{'content-type':'application/pdf','cache-control':'private, no-store','content-disposition':'inline','x-content-type-options':'nosniff'}});
    }
    if(['/api/admin/lesson-pdf','/api/admin/lesson-image'].includes(path)&&method==='POST'){
      access.requireManager(session);if(request.headers.get('x-csrf-token')!==session.csrf)fail(403,'أعد تحميل الصفحة.');
      const origin=request.headers.get('origin');if(origin&&origin!==new URL(publicUrl).origin)fail(403,'مصدر غير مسموح.');
      const cid=Number(url.searchParams.get('courseId')),uid=url.searchParams.get('lessonUid');
      if(!content().courses.some(c=>c.id===cid)||!uid||uid.length>100)fail(400,'بيانات الدرس غير صالحة.');access.requireCourse(session,cid);
      if(path==='/api/admin/lesson-image'){
        const bytes=Buffer.from(await request.arrayBuffer());if(bytes.length>5*1024*1024)fail(413,'كل صورة لا تزيد على 5 ميغابايت.');
        const mime=bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))?'image/png':bytes[0]===255&&bytes[1]===216&&bytes[2]===255?'image/jpeg':bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP'?'image/webp':null;
        if(!mime)fail(400,'اختر صورة PNG أو JPG أو WebP صحيحة.');
        const id=hash(Buffer.concat([Buffer.from(cid+':'+uid+':'),bytes]));run('INSERT OR IGNORE INTO lesson_images VALUES (?,?,?,?,?)',id,cid,uid,bytes,mime);return json({id,src:'/api/lesson-image?courseId='+cid+'&lessonUid='+encodeURIComponent(uid)+'&imageId='+id});
      }
      const bytes=Buffer.from(await request.arrayBuffer());if(bytes.length>25*1024*1024)fail(413,'الكتاب لا يزيد على 25 ميغابايت.');
      if(bytes.subarray(0,5).toString()!=='%PDF-')fail(400,'اختر ملف PDF صحيحاً.');
      const id=hash(Buffer.concat([Buffer.from(cid+':'+uid+':'),bytes]));run('INSERT OR IGNORE INTO lesson_pdfs VALUES (?,?,?,?)',id,cid,uid,bytes);return json({id,size:bytes.length});
    }
    if(method==='GET'&&path==='/api/health')return json({ok:true});
    if(method==='GET'&&path==='/api/notifications')return notificationCenter.handle({path,method,session,request});
    if(method==='GET'&&['/api/admin/student-index','/api/admin/comments'].includes(path))return accounts.handle({path,method,body:{},session,ip,request});
    if(!['POST','PUT','DELETE'].includes(method))fail(405,'طريقة غير مدعومة.');
    const origin=request.headers.get('origin');if(origin&&origin!==new URL(publicUrl).origin)fail(403,'مصدر الطلب غير مسموح.');
    if(!(request.headers.get('content-type')||'').startsWith('application/json'))fail(415,'يلزم إرسال JSON.');
    const raw=await request.text();if(Buffer.byteLength(raw)>LIMIT)fail(413,'حجم الطلب كبير.');let body;try{body=raw?parse(raw):{}}catch{fail(400,'JSON غير صالح.')}if(!body||typeof body!=='object'||Array.isArray(body))fail(400,'يلزم إرسال كائن بيانات صالح.');
    const openPaths=['/api/login','/api/register','/api/admin/login','/api/staff/login','/api/verify','/api/visit','/api/courses/view','/api/articles/view','/api/comments','/api/recovery/request','/api/recovery/reset'];if(!openPaths.includes(path)&&session&&request.headers.get('x-csrf-token')!==session.csrf)fail(403,'انتهى رمز الجلسة. أعد تحميل الصفحة.');
    if(['/api/staff/login','/api/admin/staff','/api/admin/staff-message','/api/admin/course-message','/api/student/admin-message','/api/admin/student-message-read','/api/admin/course-certificate'].includes(path))return atomic(()=>access.handle({path,method,body,session,request,ip}));
    const notificationResult=notificationCenter.handle({path,method,session,request,body});if(notificationResult)return notificationResult;
    const accountResult=accounts.handle({path,method,body,session,ip,request});if(accountResult)return accountResult;
    if(path==='/api/courses/view'){
      rate('course-views:'+ip,60,60000);const c=content().courses.find(c=>c.id===Number(body.courseId)&&access.published(c));if(!c)fail(404,'الدورة غير متاحة.');if(access.manager(session))return json({courseId:c.id,views:query('SELECT COUNT(*) total FROM course_views WHERE course_id=?',c.id).total});
      const supplied=/(?:^|;\s*)academy_viewer=([A-Za-z0-9_-]{32})/.exec(request.headers.get('cookie')||'')?.[1],token=supplied||randomBytes(24).toString('base64url'),browserHash=hash(token),browserViewer='browser:'+browserHash;
      return atomic(()=>{const known=query('SELECT account_viewer FROM course_view_browsers WHERE token_hash=?',browserHash),account=session?.user.role==='student'?'user:'+hash(session.user.id):known?.account_viewer,viewer=account||browserViewer;run('INSERT INTO course_view_browsers(token_hash,account_viewer) VALUES (?,?) ON CONFLICT(token_hash) DO UPDATE SET account_viewer=COALESCE(excluded.account_viewer,course_view_browsers.account_viewer)',browserHash,account||null);if(account)run('DELETE FROM course_views WHERE course_id=? AND viewer=?',c.id,browserViewer);run('INSERT OR IGNORE INTO course_views VALUES (?,?,?)',c.id,viewer,Date.now());return json({courseId:c.id,views:query('SELECT COUNT(*) total FROM course_views WHERE course_id=?',c.id).total},200,supplied?{}:{'set-cookie':`academy_viewer=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=31536000${publicUrl.startsWith('https://')?'; Secure':''}`})});
    }
    if(path==='/api/visit'){run('UPDATE counters SET value=value+1 WHERE name=?','visits');return json({ok:true})}
    if(path==='/api/register'||path==='/api/login'||path==='/api/admin/login'){
      rate('auth:'+ip,20,900000);const isAdmin=path==='/api/admin/login',email=isAdmin?'admin@academy.internal':text(body.email,254).trim().toLowerCase(),password=text(body.password,256);let user=query('SELECT * FROM users WHERE email=?',email);
      if(path==='/api/register'){if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||password.length<8||text(body.name,200).trim().split(/\s+/).length<4)fail(400,'أدخل الاسم الرباعي وبريداً صحيحاً وكلمة مرور لا تقل عن 8 أحرف.');if(user)fail(409,'البريد مسجل بالفعل. استخدم تسجيل الدخول.');const id=randomUUID();run('INSERT INTO users VALUES (?,?,?,?,?,?)',id,email,text(body.name,200).trim(),passwordHash(password),'student',new Date().toISOString());user=query('SELECT * FROM users WHERE id=?',id)}
      else if(!user||user.role!==(isAdmin?'admin':'student')||!passwordMatches(password,user.password_hash))fail(401,'بيانات الدخول غير صحيحة.');
      const next=openSession(user);return json(state(next),200,{'set-cookie':cookie(next.token)});
    }
    if(path==='/api/logout'){if(session)run('DELETE FROM sessions WHERE token_hash=?',hash(session.token));return json({ok:true},200,{'set-cookie':cookie('',0)})}
    if(path==='/api/admin/content'){
      access.requireManager(session);if(!body.content||typeof body.content!=='object'||Array.isArray(body.content))fail(400,'بيانات إعدادات غير صالحة.');return atomic(()=>{const old=content();if(body.revision!==old.revision)fail(409,'تغير المحتوى من جلسة أخرى. أعد تحميله قبل الحفظ.');const incoming=access.mergeStaff(body.content,old,session);const allowed=['sections','articleSections','courses','settings','news','about','aboutImage','rules','seq','prefixHistory','learningPathsVersion'],data={};for(const k of allowed)if(incoming[k]!==undefined)data[k]=incoming[k];validateConfig(data,old);access.afterContent(old,data,session);for(const [key,table] of [['sections','certificates'],['articleSections','articles']]){const removed=old[key].filter(v=>!data[key].includes(v)),added=data[key].filter(v=>!old[key].includes(v));if(removed.length===1&&added.length===1&&old[key].length===data[key].length){const from=removed[0],to=added[0];if(key==='sections'&&old.courses.some(c=>c.section===from&&data.courses.find(n=>n.id===c.id)?.section!==to))continue;for(const row of rows('SELECT id,data FROM '+table)){const record=parse(row.data);if(record.section===from){record.section=to;run('UPDATE '+table+' SET data=? WHERE id=?',JSON.stringify(record),row.id)}}}}run('UPDATE content SET data=?,revision=revision+1 WHERE id=1',JSON.stringify(data));return json({ok:true,revision:old.revision+1})});
    }
    if(path==='/api/admin/password'){requireAdmin(session);if(text(body.password).length<12)fail(400,'كلمة مرور الإدارة يجب أن تكون 12 حرفاً على الأقل.');run('UPDATE users SET password_hash=? WHERE id=?',passwordHash(body.password),session.user.id);run('DELETE FROM sessions WHERE user_id=? AND token_hash<>?',session.user.id,hash(session.token));return json({ok:true})}
    if(path==='/api/enroll'){const u=requireStudent(session),c=accessibleCourse(body.courseId,u);if(!c.lessons.length)fail(409,'لم تنشر دروس الدورة بعد.');if(!query('SELECT user_id FROM progress WHERE user_id=? AND course_id=?',u.id,c.id))storeProgress(u.id,c.id,{lessons:{}});return json(state(session))}
    if(path==='/api/exams/start'){
      const u=requireStudent(session),c=accessibleCourse(body.courseId,u),p=progressFor(u.id,c.id);if(!query('SELECT user_id FROM progress WHERE user_id=? AND course_id=?',u.id,c.id))fail(409,'التحق بالدورة أولاً.');const final=body.type==='final',lesson=final?null:c.lessons[Number(body.type)];if(!final&&!lesson)fail(404,'الدرس غير موجود.');if(final&&(!c.lessons.length||c.lessons.some(l=>p.lessons[l.uid]===undefined)))fail(403,'أكمل اختبارات الدروس أولاً.');const bank=final?c.questions:lesson.questions,count=final?c.finalCount:c.lessonCount;if(bank.length<count)fail(409,'بنك الأسئلة غير مكتمل: أضف الأسئلة الناقصة أو عدّل عدد أسئلة الاختبار من تعديل الدورة.');run('DELETE FROM exams WHERE submitted=0 AND lesson_uid IS NOT NULL AND expires < ?',Date.now()-86400000);if(final){for(const expired of rows('SELECT id,expires FROM exams WHERE user_id=? AND course_id=? AND lesson_uid IS NULL AND submitted=0 AND expires+5000<?',u.id,c.id,Date.now()))run('UPDATE exams SET submitted=1,result=?,completed_at=? WHERE id=?',JSON.stringify({score:0,passed:false,expired:true,certificate:null,feedback:[]}),expired.expires,expired.id);}const existing=query('SELECT * FROM exams WHERE user_id=? AND course_id=? AND lesson_uid IS ? AND submitted=0 AND expires>?',u.id,c.id,lesson?.uid||null,Date.now());if(existing)return json(examView(existing));if(final){const last=query('SELECT result,completed_at,expires FROM exams WHERE user_id=? AND course_id=? AND lesson_uid IS NULL AND submitted=1 ORDER BY COALESCE(completed_at,expires) DESC LIMIT 1',u.id,c.id),available=last&&!parse(last.result).passed?(last.completed_at||last.expires)+(c.retakeDelayHours||0)*3600000:0;if(available>Date.now())fail(409,'يمكنك إعادة الامتحان الشامل بعد '+new Date(available).toLocaleString('ar-JO',{timeZone:'Asia/Amman'})+'.');}const selected=final?balancedQuestions(bank,count):balancedQuestions(bank,bank.length).slice(0,count),id=randomUUID(),expires=Date.now()+(final?c.finalTime:c.lessonTime)*60000;run('INSERT INTO exams(id,user_id,course_id,lesson_uid,questions,expires) VALUES (?,?,?,?,?,?)',id,u.id,c.id,lesson?.uid||null,JSON.stringify(selected),expires);return json(examView(query('SELECT * FROM exams WHERE id=?',id)));
    }
    if(path==='/api/exams/submit'){
      const u=requireStudent(session);return atomic(()=>{const ex=query('SELECT * FROM exams WHERE id=? AND user_id=?',text(body.examId,100),u.id);if(!ex)fail(404,'الاختبار غير موجود.');if(ex.submitted)return json({...parse(ex.result),...state(session)});const c=accessibleCourse(ex.course_id,u),questions=parse(ex.questions),answers=Array.isArray(body.answers)?body.answers:[],expired=Date.now()>ex.expires+5000,score=expired?0:Math.round(questions.filter((q,i)=>Number.isInteger(answers[i])&&answers[i]===q.correct).length/questions.length*100),passed=score>=c.pass,p=progressFor(u.id,c.id);let certificate=null;if(passed){if(ex.lesson_uid){if(!c.lessons.some(l=>l.uid===ex.lesson_uid))fail(409,'حُذف الدرس أثناء الاختبار.');p.lessons[ex.lesson_uid]=score}else{if(c.lessons.some(l=>p.lessons[l.uid]===undefined))fail(403,'لم تجتز جميع الدروس الحالية.');const old=query('SELECT data FROM certificates WHERE user_id=? AND course_id=? AND is_test=0',u.id,c.id);certificate=old?parse(old.data):{id:nextCertificateId(c.prefix||c.code.split('-')[0]),courseCode:c.code,courseId:c.id,section:c.section,level:c.level,studentId:u.id,name:u.name,course:c.title,score,date:new Date().toLocaleDateString('ar-JO'),templateVersion:access.capture(c.id)};if(!old){run('INSERT INTO certificates VALUES (?,?,?,?,?,?)',certificate.id,u.id,c.id,0,JSON.stringify(certificate),Date.now());notificationCenter.emit({eventKey:'certificate:'+certificate.id,kind:'certificate',entityId:certificate.id,title:'صدرت شهادة جديدة',message:certificate.name+' — '+certificate.course+' — '+certificate.id,studentId:u.id})}p.cert=certificate.id;p.score=certificate.score}storeProgress(u.id,c.id,p)}const feedback=questions.map((q,i)=>({question:q.text,selectedAnswer:Number.isInteger(answers[i])&&q.options[answers[i]]!==undefined?q.options[answers[i]]:'لم تُجب',correctAnswer:q.options[q.correct],correct:!expired&&Number.isInteger(answers[i])&&answers[i]===q.correct}));const completedAt=Date.now(),retryAvailableAt=!ex.lesson_uid&&!passed?completedAt+(c.retakeDelayHours||0)*3600000:null,result={score,passed,expired,certificate,feedback,retryAvailableAt};run('UPDATE exams SET submitted=1,result=?,completed_at=? WHERE id=?',JSON.stringify(result),completedAt,ex.id);return json({...result,...state(session)})});
    }
    if(path==='/api/certificates/test'){requireAdmin(session);return atomic(()=>{const config=content(),course=config.courses.find(c=>c.id===Number(body.courseId));if(!course)fail(400,'اختيار الدورة المرتبطة بالشهادة إجباري.');access.requireCourse(session,course.id);const certificate={id:nextCertificateId('ZZ',true),isTest:true,courseId:course.id,templateVersion:access.capture(course.id),name:'محمد أحمد عبد الله محمود',course:course.title,courseCode:course.code,score:95,date:new Date().toLocaleDateString('ar-JO')};run('INSERT INTO certificates VALUES (?,?,?,?,?,?)',certificate.id,null,course.id,1,JSON.stringify(certificate),Date.now());notificationCenter.emit({eventKey:'certificate:'+certificate.id,kind:'test-certificate',entityId:certificate.id,title:'صدرت شهادة تجريبية',message:certificate.id+' — تحقق واحد فقط',recipientId:session.user.id});return json({certificate,...state(session)})})}
    if(path==='/api/verify'){rate('verify:'+ip,30,60000);return atomic(()=>{const r=query('SELECT * FROM certificates WHERE id=?',text(body.id,150).trim().toUpperCase());if(!r)return json({valid:false},404);if(r.is_test)run('DELETE FROM certificates WHERE id=? AND is_test=1',r.id);const c=parse(r.data);return json({valid:true,isTest:!!r.is_test,certificate:{id:c.id,name:c.name,course:c.course,date:c.date,score:c.score}})})}
    if(path==='/api/articles'){const u=requireStudent(session),config=content();if(!config.articleSections.includes(body.section)||!text(body.title,300).trim()||!text(body.text).trim())fail(400,'أكمل عنوان المقال ونصه وقسمه.');const a={id:randomUUID(),userId:u.id,email:u.email,author:text(body.author||u.name,200),title:text(body.title,300),country:text(body.country,100),section:body.section,text:text(body.text),refs:text(body.refs),status:'pending',hidden:false};run('INSERT INTO articles VALUES (?,?,?)',a.id,u.id,JSON.stringify(a));return json(state(session))}



    if(path==='/api/articles/deletion-request'){const u=requireStudent(session);return atomic(()=>{const row=query('SELECT data FROM articles WHERE id=?',text(body.id,100));if(!row)fail(404,'المقال غير موجود.');const a=parse(row.data);if(a.userId!==u.id)fail(403,'طلب الحذف متاح لصاحب المقال فقط.');if(a.status!=='approved')fail(409,'طلب الحذف متاح للمقال الموافق عليه فقط.');if(a.deletionRequest?.status==='pending')fail(409,'يوجد طلب حذف قيد المراجعة.');if(body.reason!==undefined&&(typeof body.reason!=='string'||body.reason.length>2000))fail(400,'سبب الطلب لا يتجاوز 2000 حرف.');a.deletionRequest={status:'pending',reason:text(body.reason,2000).trim(),requestedAt:new Date().toISOString()};run('UPDATE articles SET data=? WHERE id=?',JSON.stringify(a),a.id);return json(state(session))})}
    if(path==='/api/admin/article/deletion-request'){requireAdmin(session);return atomic(()=>{const row=query('SELECT data FROM articles WHERE id=?',text(body.id,100));if(!row)fail(404,'المقال غير موجود.');const a=parse(row.data);if(a.deletionRequest?.status!=='pending')fail(409,'لا يوجد طلب حذف قيد المراجعة.');if(body.decision==='approve')run('DELETE FROM articles WHERE id=?',a.id);else if(body.decision==='reject'){const reason=text(body.reason,2000).trim();if(!reason)fail(400,'أدخل سبب رفض طلب الحذف.');a.deletionRequest={...a.deletionRequest,status:'rejected',reviewReason:reason,reviewedAt:new Date().toISOString()};run('UPDATE articles SET data=? WHERE id=?',JSON.stringify(a),a.id)}else fail(400,'قرار غير صالح.');return json(state(session))})}

    if(path==='/api/articles/rate'){const u=requireStudent(session),row=query('SELECT data FROM articles WHERE id=?',text(body.id,100));if(!row)fail(404,'المقال غير موجود.');const a=parse(row.data);if(a.hidden||a.status!=='approved')fail(404,'المقال غير متاح.');const stars=Number(body.stars);if(!Number.isInteger(stars)||stars<1||stars>5)fail(400,'التقييم من نجمة إلى خمس نجوم.');run('INSERT INTO article_ratings VALUES (?,?,?) ON CONFLICT(article_id,user_id) DO UPDATE SET stars=excluded.stars',a.id,u.id,stars);return json(state(session))}
    if(path==='/api/articles/view'){
      const row=query('SELECT data FROM articles WHERE id=?',text(body.id,100));if(!row)fail(404,'المقال غير موجود.');const a=parse(row.data),admin=access.superAdmin(session),reviewer=access.canReview(session);if(!reviewer&&(a.hidden||a.status!=='approved'))fail(404,'المقال غير متاح.');let readerCookie;const now=Math.floor(Date.now()/86400000);if(!reviewer){let token=/(?:^|;\s*)academy_reader=([A-Za-z0-9_-]{20,100})/.exec(request.headers.get('cookie')||'')?.[1];if(!token&&!session){token=randomBytes(24).toString('base64url');readerCookie='academy_reader='+token+'; HttpOnly; Path=/; SameSite=Lax; Max-Age=31536000'+(publicUrl.startsWith('https://')?'; Secure':'')}const viewer=hash(session?'user:'+session.user.id:'reader:'+token);run('INSERT OR IGNORE INTO article_views VALUES (?,?,?)',a.id,viewer,now)}a.views=query('SELECT COUNT(*) total FROM article_views WHERE article_id=?',a.id).total;Object.assign(a,ratingStats(a.id));a.myRating=session?query('SELECT stars FROM article_ratings WHERE article_id=? AND user_id=?',a.id,session.user.id)?.stars||null:null;if(!admin&&a.userId!==session?.user.id)delete a.deletionRequest;delete a.email;delete a.userId;delete a.reason;const comments=rows('SELECT id,name,text,image,status,created FROM comments WHERE article_id=? ORDER BY created',a.id).filter(c=>admin||c.status==='approved');return json({article:a,comments},200,readerCookie?{'set-cookie':readerCookie}:{})
    }
    if(path==='/api/comments'){
      rate('comments:'+ip,5,600000);const row=query('SELECT data FROM articles WHERE id=?',text(body.articleId,100));if(!row)fail(404,'المقال غير متاح.');const a=parse(row.data);if(a.hidden||a.status!=='approved')fail(404,'المقال غير متاح.');const message=typeof body.text==='string'?body.text.trim():'',name=session?.user.name||text(body.name,100).trim();if(!message||message.length>300||!name)fail(400,'اسم القارئ والتعليق مطلوبان؛ الحد 300 حرف.');if(body.images!==undefined||typeof(body.image||'')!=='string')fail(400,'يمكن إضافة صورة واحدة فقط.');const image=body.image||'';if(image){const match=/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(image);if(!match)fail(400,'اختر صورة PNG أو JPG أو WebP.');const buffer=Buffer.from(match[2],'base64');if(buffer.length>1048576)fail(413,'الصورة لا تزيد على 1 ميغابايت.');const valid=match[1]==='png'?buffer.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])):match[1]==='jpeg'?buffer[0]===255&&buffer[1]===216&&buffer[2]===255:buffer.subarray(0,4).toString()==='RIFF'&&buffer.subarray(8,12).toString()==='WEBP';if(!valid)fail(400,'بيانات الصورة غير صالحة.')}const id=randomUUID();return atomic(()=>{run('INSERT INTO comments VALUES (?,?,?,?,?,?,?,?)',id,a.id,session?.user.id||null,name,message,image,'approved',Date.now());notificationCenter.emit({eventKey:'comment:'+id,kind:'comment',entityId:id,articleId:a.id,title:'تعليق جديد على '+a.title,message:name+': '+message,studentId:a.userId});return json({ok:true,id,status:'approved'})})
    }
    if(path==='/api/admin/comment'){
      requireAdmin(session);const c=query('SELECT * FROM comments WHERE id=?',text(body.id,100));if(!c)fail(404,'التعليق غير موجود.');if(body.action==='delete')run('DELETE FROM comments WHERE id=?',c.id);else if(body.action==='approve')run("UPDATE comments SET status='approved' WHERE id=?",c.id);else fail(400,'إجراء غير صالح.');return json({ok:true})
    }
    if(path==='/api/admin/article'){access.requireReviewer(session,body);return atomic(()=>{const old=query('SELECT data FROM articles WHERE id=?',text(body.id,100));if(!old)fail(404,'المقال غير موجود.');if(body.action==='delete')run('DELETE FROM articles WHERE id=?',body.id);else{const a=parse(old.data),wasPublished=a.status==='approved'&&!a.hidden;if(body.action==='visibility')a.hidden=!!body.hidden;else if(body.action==='presentation'){const priority=Number(body.priority);if(!Number.isInteger(priority)||priority<0||priority>999)fail(400,'الأولوية من 0 إلى 999.');a.priority=priority;a.featured=!!body.featured}else if(['approved','rejected'].includes(body.status)){a.status=body.status;a.reason=body.status==='rejected'?text(body.reason,3000):'';if(a.status==='rejected'&&!a.reason.trim())fail(400,'أدخل سبب الرفض.')}else fail(400,'إجراء غير صالح.');if(!wasPublished&&a.status==='approved'&&!a.hidden){a.publicationSequence=(Number(a.publicationSequence)||0)+1;notificationCenter.emit({eventKey:'article-published:'+a.id+':'+a.publicationSequence,kind:'article-published',entityId:a.id,articleId:a.id,title:'تم نشر مقالك',message:'تمت الموافقة على مقالك «'+a.title+'» ونشره في المنصة.',studentId:a.userId})}run('UPDATE articles SET data=? WHERE id=?',JSON.stringify(a),a.id)}return json(state(session))})}
    fail(404,'المسار غير موجود.');
  }catch(e){return json({error:e.status?e.message:'حدث خطأ في الخادم.'},e.status||500)}}
  function examView(ex){const c=content().courses.find(c=>c.id===ex.course_id),index=ex.lesson_uid?c.lessons.findIndex(l=>l.uid===ex.lesson_uid):'final';return {exam:{token:ex.id,id:ex.course_id,type:index,ends:ex.expires,questions:parse(ex.questions).map(q=>({type:q.type||'mcq',text:q.text,options:q.options}))}}}
  return {handle,close:()=>database.close(),database};
}

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
mkdirSync('backups',{recursive:true});
const file=resolve('backups/academy-'+new Date().toISOString().replace(/[:.]/g,'-')+'.sqlite');
const database=new DatabaseSync(process.env.DATABASE_PATH||'data/academy.sqlite');
database.prepare('VACUUM INTO ?').run(file);database.close();console.log(file);

services:
  academy:
    build: .
    restart: unless-stopped
    env_file: .env
    environment:
      DATABASE_PATH: /data/academy.sqlite
      PORT: 3000
    ports:
      - "127.0.0.1:3000:3000"
    volumes:
      - academy_data:/data
volumes:
  academy_data:

import {createHash, randomUUID} from 'node:crypto';

const hash=value=>createHash('sha256').update(value).digest('hex');
const question=(text,options,correct,type=options.length===2?'tf':'mcq')=>({type,text,options,correct});

function lesson(title,preface,intro,terms,blocks,questions){
  return {uid:randomUUID(),title,preface,intro,terms,blocks:blocks.map(([heading,text])=>({title:heading,text,images:[]})),refs:'مادة عرض تعليمية للأكاديمية. تُراجع المادة العلمية النهائية من المدرس المختص قبل اعتمادها مقرراً رسمياً.',link:'',questions};
}

function courseBlueprint({title,book,author,teacher,section,prefix,id}){
  const shared=[
    lesson('المدخل وخطة التعلّم','الدرس الأول: تحديد المقصود من المادة وخطوات قراءتها.','ابدأ برسم خطة قصيرة: قراءة واعية، تدوين للمصطلحات، ثم مراجعة منظمة قبل الاختبار.','المنهج: طريق منظم لطلب العلم. المراجعة: العودة إلى المادة لتثبيت الفهم.',[
      ['القراءة المقصودة','اقرأ عنوان الدرس وتمهيده، ثم حدّد الفكرة الرئيسة والأسئلة التي تريد الإجابة عنها قبل الانتقال إلى التفاصيل.'],
      ['دفتر المصطلحات','اكتب المصطلح ومعناه في سياقه، ولا تكتفِ بحفظ اللفظ من غير فهم استعماله في الدرس.']
    ],[
      question('ما البداية الأنسب عند دراسة درس جديد؟',['قراءة العنوان والتمهيد وتحديد الأسئلة','الانتقال مباشرة إلى الاختبار','حفظ النتائج فقط','تجاوز المصطلحات'],0),
      question('تدوين المصطلحات مع معناها في السياق يساعد على الفهم.',['صح','خطأ'],0)
    ]),
    lesson('قراءة النص وتحليل المسألة','الدرس الثاني: الانتقال من القراءة إلى تنظيم عناصر المسألة.','تعلّم أن تميّز بين النص المنقول وفهمك له، وأن تربط كل نتيجة بدليلها أو موضعها في المادة.','النقل: إثبات النص مع مصدره. الاستنتاج: نتيجة يصل إليها القارئ من الدليل.',[
      ['تصوير المسألة','صغ السؤال بعبارة واضحة، واذكر حدوده قبل المقارنة بين العناصر أو قبل تدوين النتيجة.'],
      ['التوثيق والمراجعة','دوّن اسم المصدر والمؤلف وموضع الفكرة، ثم راجع أن النتيجة لا تتجاوز ما دل عليه النص.']
    ],[
      question('ما الذي يسبق المقارنة بين عناصر المسألة؟',['تحديد السؤال وحدوده','حذف المصادر','كتابة النتيجة أولاً','ترك التوثيق'],0),
      question('كل استنتاج للقارئ يُعد نقلاً حرفياً من المؤلف.',['صح','خطأ'],1)
    ]),
    lesson('المراجعة والتقويم','الدرس الثالث: تثبيت التعلم والاستعداد للتقويم.','اجعل المراجعة قصيرة ومتكررة، وارجع إلى مواضع الخطأ لتصحيح الفهم لا لحفظ الإجابة فقط.','التقويم: قياس الفهم بوسائل منظمة. الخلاصة: أهم ما يبقى بعد الدرس.',[
      ['خريطة الدرس','لخّص الدرس في عناوين: الهدف، المصطلحات، الدليل أو المثال، ثم الخلاصة التي توصلت إليها.'],
      ['التصحيح البنّاء','بعد الاختبار، اقرأ سبب صحة الجواب وخطأ البدائل، ثم ارجع إلى الفقرة المرتبطة بالسؤال.']
    ],[
      question('كيف تكون المراجعة أنفع؟',['قصيرة ومتكررة مع الرجوع إلى مواضع الخطأ','مرة واحدة بلا تلخيص','بحفظ الإجابة من غير فهم','بتجاوز الخلاصة'],0),
      question('فهم سبب الخطأ جزء من التقويم البنّاء.',['صح','خطأ'],0)
    ])
  ];
  return {id,title,book,author,teacher,section,level:'مبتدئ',prefix,code:`${prefix}-2026-${String(id).padStart(6,'0')}`,pass:50,lessonCount:2,lessonTime:10,finalCount:6,finalTime:25,lessons:shared,questions:shared.flatMap(item=>item.questions),demo:true,modelCourse:true};
}

const articleBlueprints=[
  {key:'article-fiqh',title:'فقه الطهارة بين التأصيل والتطبيق',author:'هيئة المحتوى العلمي',country:'الأردن',section:'فقه وتأصيل',priority:30,text:'تبدأ دراسة أبواب الطهارة بفهم المصطلحات وتقسيم المسائل، ثم بربط التطبيق العملي بأصل المسألة ودليلها. المنهج المتدرج يعين الطالب على ضبط مواضع الاتفاق والتمييز بين صور المسائل، ويجعل المراجعة أقرب إلى الفهم منها إلى الحفظ المجرد.',refs:'مادة عرض تحريرية للأكاديمية؛ تراجع المراجع المعتمدة قبل النشر العلمي النهائي.',views:38,comments:[['أميمة خالد','عرض مرتب وواضح، وأعجبني ربط المصطلح بالتطبيق.'],['محمد السالم','أتطلع إلى توسعة أمثلة المراجعة في الدرس القادم.']]},
  {key:'article-hadith',title:'منهج المحدثين في التثبت من الرواية',author:'هيئة المحتوى العلمي',country:'فلسطين',section:'دراسات شرعية',priority:29,text:'يقوم التثبت في الرواية على العناية بالمصدر والسند والمتن، وعلى عدم التسرع في نسبة القول قبل مراجعة موضعه وسياقه. وفي المسار التعليمي يتدرّب الطالب على سؤالين ثابتين: من أين نُقل النص، وما الذي يدل عليه في بابه؟',refs:'مادة عرض تحريرية للأكاديمية؛ تراجع المراجع المعتمدة قبل النشر العلمي النهائي.',views:31,comments:[['ليان عمر','لغة المقال سهلة ومناسبة للمبتدئين.'],['عبدالله ناصر','فكرة السؤالين الثابتين مفيدة جداً للقراءة المنظمة.']]},
  {key:'article-usul',title:'دلالة الأمر والنهي في أصول الفقه',author:'هيئة المحتوى العلمي',country:'المغرب',section:'دراسات شرعية',priority:28,text:'تساعد دراسة دلالات الألفاظ الطالب على القراءة الدقيقة للنص؛ فلا يفصل الأمر أو النهي عن سياقه، ولا يبني نتيجة قبل تحرير محل السؤال. ويبدأ التدريب بتمييز اللفظ، ثم السياق، ثم القاعدة التي يُراد تطبيقها، مع عرض ذلك على المدرس المختص.',refs:'مادة عرض تحريرية للأكاديمية؛ تراجع المراجع المعتمدة قبل النشر العلمي النهائي.',views:26,comments:[['سارة محمود','تنظيم الفكرة إلى لفظ وسياق وقاعدة جعل المدخل أسهل.'],['يوسف أحمد','أتمنى إدراج تمارين تطبيقية في المقالات القادمة.']]}
];

/** Adds curated display records exactly once, without changing any editor-created content. */
export function installDisplayDemo({database,content,atomic,passwordHash,certificateTemplate}){
  const get=(sql,...args)=>database.prepare(sql).get(...args);
  const run=(sql,...args)=>database.prepare(sql).run(...args);
  database.exec('CREATE TABLE IF NOT EXISTS display_demo_entries (key TEXT PRIMARY KEY, entity_id TEXT NOT NULL, created INTEGER NOT NULL)');
  const now=Date.now();
  atomic(()=>{
    let config=content(),changed=false;
    const used=new Set([...(config.prefixHistory||[]),...config.courses.map(c=>String(c.prefix||'').toUpperCase())]);
    const choices=[['QF','XF','VF'],['QH','XH','VH'],['QU','XU','VU']];
    const specs=[
      ['course-fiqh','الفقه المالكي — مسار الدراسة المتدرج','مختصر تعليمي في الفقه المالكي','إعداد أكاديمية الفقه المالكي','الفقه المالكي'],
      ['course-hadith','الحديث الشريف — قراءة النص وفهمه','الأربعون النووية: قراءة تعليمية','إعداد أكاديمية الفقه المالكي','الحديث الشريف'],
      ['course-usul','أصول الفقه — مدخل إلى الاستدلال','الورقات: مدخل تعليمي','إعداد أكاديمية الفقه المالكي','أصول الفقه']
    ];
    specs.forEach((spec,index)=>{
      if(get('SELECT key FROM display_demo_entries WHERE key=?',spec[0]))return;
      const prefix=choices[index].find(value=>!used.has(value));
      if(!prefix)return;
      used.add(prefix);
      const id=Math.max(config.seq||0,...config.courses.map(c=>c.id))+1;
      const course=courseBlueprint({id,prefix,title:spec[1],book:spec[2],author:spec[3],teacher:'فريق العرض الأكاديمي',section:spec[4]});
      config.courses.push(course);config.seq=id;config.prefixHistory=[...(config.prefixHistory||[]),prefix];
      const layout=JSON.stringify({template:certificateTemplate,nameX:50,nameY:42,gradeX:50,gradeY:54,dateX:50,dateY:64,verificationX:50,verificationY:87,nameFontSize:28,gradeFontSize:22,dateFontSize:16,verificationFontSize:14});
      run('INSERT INTO course_certificates VALUES (?,?,?)',id,layout,hash(layout));
      run('INSERT INTO display_demo_entries VALUES (?,?,?)',spec[0],String(id),now);changed=true;
    });
    if(changed)run('UPDATE content SET data=?,revision=revision+1 WHERE id=1',JSON.stringify(config));
    const authorId='00000000-0000-4000-8000-0000000000d1';
    if(!get('SELECT id FROM users WHERE id=?',authorId))run('INSERT INTO users VALUES (?,?,?,?,?,?)',authorId,'demo-author@academy.internal','فريق العرض الأكاديمي',passwordHash('Display-content-not-for-login'),'demo',new Date(now).toISOString());
    const raterIds=[1,2,3].map(index=>'00000000-0000-4000-8000-0000000000d'+(index+1));
    raterIds.forEach((id,index)=>{if(!get('SELECT id FROM users WHERE id=?',id))run('INSERT INTO users VALUES (?,?,?,?,?,?)',id,`demo-rater-${index+1}@academy.internal`,'قارئ عرض',passwordHash('Display-rater-not-for-login'),'demo',new Date(now).toISOString())});
    articleBlueprints.forEach((item,index)=>{
      if(get('SELECT key FROM display_demo_entries WHERE key=?',item.key))return;
      const id=randomUUID(),article={id,userId:authorId,email:'demo-author@academy.internal',author:item.author,title:item.title,country:item.country,section:item.section,text:item.text,refs:item.refs,status:'approved',hidden:false,featured:true,priority:item.priority,publicationSequence:1,demo:true};
      run('INSERT INTO articles VALUES (?,?,?)',id,authorId,JSON.stringify(article));
      item.comments.forEach(([name,text],commentIndex)=>run('INSERT INTO comments VALUES (?,?,?,?,?,?,?,?)',randomUUID(),id,null,name,text,'','approved',now-(commentIndex+1)*60000));
      [5,5,4].forEach((stars,ratingIndex)=>run('INSERT INTO article_ratings VALUES (?,?,?)',id,raterIds[ratingIndex],stars));
      for(let view=0;view<item.views;view++)run('INSERT INTO article_views VALUES (?,?,?)',id,hash(`display:${item.key}:${view}`),Math.floor(now/86400000));
      run('INSERT INTO display_demo_entries VALUES (?,?,?)',item.key,id,now);
    });
  });
}
