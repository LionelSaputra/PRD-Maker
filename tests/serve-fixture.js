// Local-only browser fixture. Never used by the production service.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { skeleton,tasks,clarification,change } from './fixtures/prd.js';
const auth=createServer((req,res)=>{res.writeHead(req.headers.cookie==='session=test'?200:401);res.end();}).listen(3345,'127.0.0.1');
const ai=createServer(async(req,res)=>{
 res.setHeader('Content-Type','application/json');
 if(req.url==='/v1/models')return res.end(JSON.stringify({data:[{id:'oa/gpt-6-astra'}]}));
 let raw='';for await(const c of req)raw+=c;const b=JSON.parse(raw);const s=b.messages[0].content;
 const data=s.includes('Product Manager ramah')?clarification:s.includes('Head of Product & Lead Architect')?change:s.includes('Tugasmu tahap 1:')?skeleton:{tasks};
 res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(data)}}]}));
}).listen(3346,'127.0.0.1');
const child=spawn(process.execPath,['server.js'],{stdio:'inherit',env:{...process.env,PORT:'3344',DB_PATH:':memory:',AUTH_CHECK_URL:'http://127.0.0.1:3345/check',ALLOWED_ORIGIN:'http://127.0.0.1:3344',PRDMAKER_CONFIG:'/nonexistent-prd-test',PRDMAKER_BASE_URL:'http://127.0.0.1:3346/v1',PRDMAKER_API_KEY:'local-test-only',PRDMAKER_MODEL:'oa/gpt-6-astra'}});
const stop=()=>{child.kill();auth.close();ai.close();};process.on('SIGTERM',stop);process.on('SIGINT',stop);
