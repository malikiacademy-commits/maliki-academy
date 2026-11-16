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
