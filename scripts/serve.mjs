import http from 'node:http';
import { readFile } from 'node:fs/promises';
const types={'.html':'text/html; charset=utf-8','.css':'text/css','.js':'text/javascript'};
http.createServer(async(req,res)=>{const path=new URL(req.url,'http://localhost').pathname;const allowed=['/','/index.html','/style.css','/app.js'];if(!allowed.includes(path)){res.writeHead(404);res.end('Not found');return;}const file=path==='/'?'/index.html':path;try{res.setHeader('Content-Type',types[file.slice(file.lastIndexOf('.'))]);res.end(await readFile('public'+file));}catch{res.writeHead(500);res.end('Unable to serve file');}}).listen(3000,'127.0.0.1',()=>console.log('Local: http://localhost:3000'));
