import { generatePRDFromPrompt } from '../src/ai-prd.js';
import { writeFileSync } from 'node:fs';
const model = process.env.PRDMAKER_MODEL || 'oa/space-bunny-free';
const started=Date.now();
try {
  const prd=await generatePRDFromPrompt('Website arsip surat kantor untuk 5 petugas, 500 surat per bulan. Cari surat berdasarkan nomor dan judul, tambah metadata tanpa upload. Login sesi petugas dan admin. UI terang tenang, tabel desktop dan daftar mobile, tidak perlu landing page, pembayaran, AI runtime atau realtime. Stack sederhana Node.js SQLite dan HTML/CSS. Tidak pakai Redis/microservices. Metrik usulan: cari surat di bawah 30 detik.', 'Arsip Kantor', [], model);
  const artifact=`/opt/backups/ngodingpakeai-live-${model.replace(/[^a-z0-9-]+/gi,'-').replace(/^-|-$/g,'')}-result.json`;
  writeFileSync(artifact, JSON.stringify(prd,null,2));
  console.log(JSON.stringify({ok:true,model,seconds:Math.round((Date.now()-started)/1000),tasks:prd.tasks.length,features:prd.features.length,artifact}));
} catch(e) { console.log(JSON.stringify({ok:false,model,seconds:Math.round((Date.now()-started)/1000),error:e.message})); process.exitCode=1; }
