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
