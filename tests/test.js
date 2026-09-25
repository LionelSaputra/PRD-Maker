import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';
import { skeleton, tasks, clarification, change } from './fixtures/prd.js';
import { validatePRD } from '../src/ai-prd.js';
import { buildArchitecturePrompt, buildTaskPrompt } from '../src/prompt-export.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const temp = mkdtempSync(join(tmpdir(), 'prd-audit-'));
const listen = async s => { s.listen(0, '127.0.0.1'); await once(s, 'listening'); return s.address().port; };
const clone = x => structuredClone(x);
let calls = 0, mode = 'ok', seen = [], logs = '', child;
const auth = createServer((req,res) => { res.writeHead(req.headers.cookie === 'session=test' ? 200 : 401); res.end(); });
const ai = createServer(async (req,res) => {
  res.setHeader('Content-Type','application/json');
  if (req.url === '/v1/models') return res.end(JSON.stringify({data:[{id:'oa/gpt-6-astra'},{id:'image-model',capabilities:{imageOutput:true}}]}));
  let raw = ''; for await (const c of req) raw += c;
  const body = JSON.parse(raw); calls++; seen.push(body);
  if (mode === 'provider-error') { res.writeHead(403); return res.end(JSON.stringify({error:'SECRET-SHOULD-NOT-LEAK model_not_available'})); }
  const prompt = body.messages[0].content;
  // Tahap 1 dipecah tiga panggilan: identitas, stack+arsitektur, fitur+DB+API.
  const identity = { projectName: skeleton.projectName, tagline: skeleton.tagline, summary: skeleton.summary };
  const core = { techStack: skeleton.techStack, architectureOverview: skeleton.architectureOverview };
  const detail = { features: skeleton.features, databaseSchema: skeleton.databaseSchema, apiEndpoints: skeleton.apiEndpoints };
  // Urutan penting: prompt inti teknis juga menyebut "Lead Engineer", jadi
  // pencocokan jumlah kunci harus mendahului cabang lain.
  let data;
  if (prompt.includes('Product Manager ramah')) data = clarification;
  else if (prompt.includes('Head of Product & Lead Architect')) data = change;
  else if (prompt.includes('tepat dua kunci')) data = core;
  else if (prompt.includes('"features"')) data = detail;
  else if (prompt.includes('"projectName"')) data = identity;
  else data = {tasks};
  // Mode invalid-prd membuat validator tahap 2 yang menolak, bukan bentuk tahap 1.
  const isStageOne = /tepat dua kunci|"features"|"projectName"/.test(prompt);
  if (mode === 'invalid-prd' && !isStageOne) data = {tasks:[]};
  if (mode === 'invalid-clarify') data = {questions:[null]};
  res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(data)}}]}));
});
try {
  assert.deepEqual(validatePRD({...skeleton,tasks}), []);
  for (const mutate of [p=>p.tasks[0]=null,p=>p.tasks[0].spec='',p=>p.tasks[1].id='TASK-01',p=>p.databaseSchema={},p=>p.databaseSchema[0].fields=[],p=>p.apiEndpoints[0].path='/api/missing',p=>p.tasks[0].spec+='\nDependensi: TASK-99',p=>p.features[0].acceptanceCriteria=[]]) {
    const p=clone({...skeleton,tasks}); mutate(p);
    // Last dependency test modifies the first dependency explicitly below.
    if (p.tasks[0]?.spec?.includes('TASK-99')) p.tasks[0].spec=p.tasks[0].spec.replace('Dependensi: tidak ada','Dependensi: TASK-99');
    assert.ok(validatePRD(p).length);
  }
  const ws={...skeleton,id:'ws_test',token:'tok_'+'a'.repeat(32)};
  const prompt=buildArchitecturePrompt(ws,tasks);
  for(const marker of ['GET','/api/v1/letters','acceptanceCriteria','TASK-08','design-taste-frontend','ui-ux-design-pro','emil-design-eng']) assert.ok(prompt.includes(marker),marker);
  assert.ok(!prompt.includes(ws.token));
  assert.ok(buildTaskPrompt(ws,tasks,'TASK-03').includes('TASK TARGET: TASK-03'));
  assert.throws(()=>buildTaskPrompt(ws,tasks,'TASK-99'));
  const authPort=await listen(auth), aiPort=await listen(ai);
  const reservation=createServer(); const appPort=await listen(reservation); await new Promise(r=>reservation.close(r));
  child=spawn(process.execPath,['server.js'],{cwd:root,env:{...process.env,PORT:String(appPort),HOST:'127.0.0.1',DB_PATH:join(temp,'test.db'),AUTH_CHECK_URL:`http://127.0.0.1:${authPort}/check`,PRDMAKER_CONFIG:join(temp,'no-config'),PRDMAKER_API_KEY:'test-only',PRDMAKER_BASE_URL:`http://127.0.0.1:${aiPort}/v1`,PRDMAKER_MODEL:'oa/gpt-6-astra'}});
  child.stdout.on('data',d=>logs+=d); child.stderr.on('data',d=>logs+=d);
  const base=`http://127.0.0.1:${appPort}`;
  for(let i=0;i<50;i++) { try {await fetch(base,{signal:AbortSignal.timeout(200)});break;}catch {if(child.exitCode!==null)throw Error(logs); await new Promise(r=>setTimeout(r,50));} }
  const request = async (path,method='GET',body,session=true,extra={}) => {
    const res=await fetch(base+path,{method,headers:{...(session?{Cookie:'session=test'}:{}),'Content-Type':'application/json',...extra},body:body===undefined?undefined:typeof body==='string'?body:JSON.stringify(body),signal:AbortSignal.timeout(10000)});
    return {status:res.status,data:await res.json(),headers:res.headers};
  };
  const html=await (await fetch(base)).text();
  for(const [,script] of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)) new Script(script);
  assert.ok(html.includes('for="proj-idea"'));
  assert.equal((await request('/api/v1/models','GET',undefined,false)).status,401);
  assert.deepEqual((await request('/api/v1/models')).data.models,['oa/gpt-6-astra']);
  assert.equal((await request('/api/v1/workspaces','GET',undefined,false)).status,401);
  for(const body of ['{','[]','null',{idea:3},{idea:'x',clarifications:'wrong'}]) assert.equal((await request('/api/v1/workspaces/generate','POST',body)).status,400);
  assert.equal((await request('/api/v1/workspaces/generate','POST','x'.repeat(140000))).status,413);
  assert.equal((await request('/api/v1/workspaces/generate','POST',{idea:'surat'},true,{Origin:'https://evil.example'})).status,403);
  assert.equal(calls,0);
  assert.equal((await request('/api/v1/workspaces/clarify','POST',{idea:'Arsip surat'})).data.questions.length,4);
  mode='invalid-clarify'; assert.equal((await request('/api/v1/workspaces/clarify','POST',{idea:'Arsip surat'})).status,500); mode='ok';
  const generated=await request('/api/v1/workspaces/generate','POST',{idea:'Arsip surat',model:'oa/gpt-6-astra'});
  assert.equal(generated.status,201,JSON.stringify(generated.data)+'\n'+logs);
  const {id,token}=generated.data.workspace;
  assert.equal(generated.data.totalTasks,8);
  const path='/api/v1/workspaces/'+id;
  assert.equal((await request(path,'GET',undefined,false)).status,401);
  assert.equal((await request(path)).data.workspace.token,undefined);
  assert.equal((await request(path,'GET',undefined,false,{Authorization:'Bearer '+token})).status,200);
  assert.equal((await request(path+'/prompts','GET',undefined,false)).status,401);
  const exported=await request(path+'/prompts'); assert.equal(exported.status,200); assert.ok(exported.data.prompt.includes('/api/v1/letters')); assert.ok(!exported.data.prompt.includes(token));
  assert.equal(exported.headers.get('cache-control'),'no-store');
  assert.equal((await request(path+'/prompts/TASK-03')).status,200);
  assert.equal((await request(path+'/prompts/TASK-99')).status,404);
  assert.equal((await request(path+'/tasks/TASK-01','PATCH',{status:'done'},false,{Authorization:'Bearer '+token})).status,200);
  assert.equal((await request(path+'/tasks/TASK-01','PATCH',{status:'invalid'})).status,400);
  assert.equal((await request(path)).data.stats.completed,1);
  assert.equal((await fetch(base+path+'/preview',{headers:{Cookie:'session=test'}})).status,200);
  // Arah visual: daftar untuk UI, simpan dari form, tolak id ngawur.
  const dirList=await request('/api/v1/design-directions'); assert.equal(dirList.status,200);
  assert.ok(dirList.data.directions.length>=7 && dirList.data.directions.some(d=>d.id==='data-analysis'));
  assert.equal((await request('/api/v1/design-directions','GET',undefined,false)).status,401);
  const cmp=await (await fetch(base+path+'/preview?compare=1',{headers:{Cookie:'session=test'}})).text();
  assert.ok(cmp.includes('Pilih arah visual') && cmp.includes('Pakai arah ini'));
  const formPost=await fetch(base+path+'/preview/direction',{method:'POST',headers:{Cookie:'session=test','Content-Type':'application/x-www-form-urlencoded'},body:'direction=data-analysis',redirect:'manual'});
  assert.equal(formPost.status,303);
  assert.equal((await request(path)).data.workspace.designDirection,'data-analysis');
  const shown=await (await fetch(base+path+'/preview?direction=playful-expressive',{headers:{Cookie:'session=test'}})).text();
  assert.ok(shown.includes('Playful &amp; Expressive'),'pratinjau arah yang diminta harus dipakai');
  assert.equal((await request(path+'/preview/direction','POST','direction=nope',true,{'Content-Type':'application/x-www-form-urlencoded'})).status,400);
  assert.equal((await request(path+'/preview/direction','POST','direction=data-analysis',false,{'Content-Type':'application/x-www-form-urlencoded'})).status,401);
  assert.equal((await request(path)).data.workspace.designDirection,'data-analysis');
  const appended=await request(path+'/append-change','POST',{changeRequest:'Label arsip'}); assert.equal(appended.status,200,JSON.stringify(appended.data)+logs);
  const updated=(await request(path)).data; assert.equal(updated.tasks.length,9); assert.ok(updated.workspace.features.some(f=>f.module==='Label Arsip')); assert.ok(updated.workspace.apiEndpoints.some(e=>e.path==='/api/v1/labels'));
  assert.equal((await request(path+'/append-change','POST',{changeRequest:'Label arsip ulang'})).status,422);
  assert.equal((await request(path)).data.tasks.length,9);
  mode='invalid-prd'; const rejected=await request('/api/v1/workspaces/generate','POST',{idea:'Invalid'}); assert.equal(rejected.status,422,JSON.stringify(rejected.data)); mode='ok';
  assert.equal((await request('/api/v1/workspaces')).data.workspaces.length,1);
  mode='provider-error'; const failed=await request('/api/v1/workspaces/generate','POST',{idea:'Provider down',model:'oa/gpt-6-astra'}); assert.equal(failed.status,500); assert.ok(!JSON.stringify(failed).includes('SECRET-SHOULD-NOT-LEAK')); mode='ok';
  assert.ok(seen.every(r=>r.model==='oa/gpt-6-astra'));
  // Kontrak desain menyatu di system prompt tahap arsitektur, tepat satu kali.
  assert.ok(seen.filter(r => r.messages[0].content.includes('architectureOverview')).every(r => (r.messages[0].content.match(/KONTRAK DESAIN ANTI AI-SLOP/g) || []).length === 1));
  assert.equal((await request(path,'DELETE',undefined,false)).status,401);
  assert.equal((await request(path,'DELETE')).status,200);
  assert.equal((await request(path)).status,404);
  console.log('PASS: validator mutations, portable prompts, inline JS, auth, input limits, generation, model fidelity, exports, task status, preview, append persistence, failure/no-save, delete. No live AI called.');
} catch (err) { console.error(logs); throw err; }
finally {
  if(child && child.exitCode===null) { const exited=once(child,'exit'); child.kill(); await exited; }
  auth.closeAllConnections(); ai.closeAllConnections(); await Promise.all([new Promise(r=>auth.close(r)),new Promise(r=>ai.close(r))]);
  rmSync(temp,{recursive:true,force:true});
}
