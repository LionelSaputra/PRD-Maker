// Regenerate PRD untuk workspace yang isinya template kosong.
// Jalankan dengan DB_PATH menunjuk salinan uji dulu.
import { db } from '../src/db.js';
import { generatePRDFromPrompt } from '../src/ai-prd.js';

const TARGETS = [
  { id: 'ws_4b82f5c2', name: 'Crypto Monitor Bot', idea: 'Bikin bot pemantau harga crypto dan alert Telegram' },
  { id: 'ws_831ca832', name: 'KameraSewa', idea: 'Web marketplace rental kamera dan alat fotografi dengan integrasi e-KTP verification, payment gateway, dan kalender booking' },
  { id: 'ws_99db81f4', name: 'Blogku', idea: 'Web Blog Sederhana' },
  { id: 'ws_9edb927a', name: 'LensRent', idea: 'Web rental kamera dengan booking kalender dan integrasi payment midtrans' },
  { id: 'ws_d0ecd9e1', name: 'Aplikasi Drafting Mobile Legend', idea: 'Saya ingin membuat aplikasi untuk draft di mobile legend. Jadi webnya itu bs merekomen hero yg cocok digunakan beserta alasannya. Saya ingin agar ainya di web bs belajar dr match2 MPL, penjoki global (dari live tiktok), analis, dsb. Saya ingin juga webnya otomatis update dan belajar jika ad patch baru' },
];

const CLAR = [
  { question: 'Skala pemakaian?', answer: 'Sedang: 20-500 orang, satu usaha/content creator yang sedang tumbuh' },
  { question: 'Perlu login pengguna?', answer: 'Ya, ada login dan beda hak akses' },
];

const only = process.argv[2] ? process.argv.slice(2) : null;

for (const t of TARGETS) {
  if (only && !only.includes(t.id)) continue;
  process.stdout.write(`\n[regen] ${t.id} ${t.name} ... `);
  try {
    const prd = await generatePRDFromPrompt(t.idea, t.name, CLAR);
    const name = prd.projectName || prd.name || t.name;
    const upd = db.prepare(`UPDATE workspaces SET name=?, tagline=?, summary=?, architecture=?, features_json=?, db_schema_json=?, api_endpoints_json=?, tech_stack=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`);
    upd.run(name, prd.tagline || null, prd.summary || null, prd.architectureOverview || null,
      JSON.stringify(prd.features || []), JSON.stringify(prd.databaseSchema || []),
      JSON.stringify(prd.apiEndpoints || []), JSON.stringify(prd.techStack || []), t.id);
    db.prepare('DELETE FROM tasks WHERE workspace_id = ?').run(t.id);
    const ins = db.prepare("INSERT INTO tasks (id, workspace_id, title, spec, status) VALUES (?, ?, ?, ?, 'todo')");
    const tx = db.transaction(() => {
      (prd.tasks || []).forEach((task, i) => {
        const slug = task.id || `TASK-${String(i + 1).padStart(2, '0')}`;
        ins.run(`${t.id}_${slug}`, t.id, task.title, task.spec);
      });
    });
    tx();
    console.log(`OK -> ${prd.tasks.length} task, ${prd.features.length} modul`);
  } catch (e) {
    console.log('GAGAL:', e.message.substring(0, 200));
  }
}
console.log('\n[regen] selesai.');
