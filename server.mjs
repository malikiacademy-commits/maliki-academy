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

