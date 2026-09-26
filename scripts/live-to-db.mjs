// Uji jalur PRODUKSI: panggil generate seperti server.js, lalu tulis ke DB
// produksi dengan transaksi yang sama persis. Ini membuktikan PRD benar-benar
// tersimpan, bukan hanya tertulis sebagai artefak.
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { generatePRDFromPrompt } from '../src/ai-prd.js';

const idea = process.env.LIVE_IDEA
  || 'Aplikasi web absensi siswa untuk 8 guru dan 300 siswa di satu SMK. Guru mencatat kehadiran per kelas, wali kelas melihat rekap bulanan, admin mengelola akun. Skala sedang, 300 siswa, sekitar 6000 baris absensi per bulan. UI terang tenang, tabel desktop dan daftar mobile. Tidak perlu landing page, pembayaran, AI, atau realtime. Stack sederhana Node.js + SQLite + HTML/CSS. Di luar lingkup: notifikasi WhatsApp dan integrasi Dapodik.';
const name = process.env.LIVE_NAME || 'Absensi Siswa SMK';

const started = Date.now();
const prd = await generatePRDFromPrompt(idea, name, [], process.env.PRDMAKER_MODEL || 'oa/space-bunny-free');
console.log('generate selesai dalam', Math.round((Date.now() - started) / 1000), 'dtk');

const db = new DatabaseSync('/opt/ngodingpakeai/data.db');
const wsId = 'ws_' + randomUUID().substring(0, 8);
const token = 'tok_' + randomUUID().replace(/-/g, '');

const insertWs = db.prepare(`
  INSERT INTO workspaces (id, token, name, tagline, summary, architecture, features_json, db_schema_json, api_endpoints_json, tech_stack, design_direction)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const insertTask = db.prepare(`INSERT INTO tasks (id, workspace_id, title, spec, status) VALUES (?, ?, ?, ?, 'todo')`);

db.transaction(() => {
  insertWs.run(
    wsId, token,
    prd.name || prd.projectName || name,
    prd.tagline || '',
    prd.summary || idea,
    prd.architectureOverview || prd.architecture || '',
    JSON.stringify(prd.features || []),
    JSON.stringify(prd.databaseSchema || []),
    JSON.stringify(prd.apiEndpoints || []),
    JSON.stringify(prd.techStack || []),
    null
  );
  const tasks = prd.tasks || [];
  tasks.forEach((t, i) => {
    const slug = t.id || `TASK-${String(i + 1).padStart(2, '0')}`;
    insertTask.run(`${wsId}_${slug}`, wsId, t.title, t.spec);
  });
})();

// Baca ulang dari DB — bukti, bukan asumsi.
const ws = db.prepare('SELECT id, name, tagline, summary, features_json, db_schema_json, api_endpoints_json, tech_stack FROM workspaces WHERE id = ?').get(wsId);
const taskRows = db.prepare('SELECT id, title, length(spec) L FROM tasks WHERE workspace_id = ? ORDER BY id').all(wsId);
console.log(JSON.stringify({
  ok: true,
  seconds: Math.round((Date.now() - started) / 1000),
  workspace: { id: ws.id, name: ws.name, summaryChars: ws.summary.length },
  features: JSON.parse(ws.features_json).map(f => f.module),
  tables: JSON.parse(ws.db_schema_json).length,
  endpoints: JSON.parse(ws.api_endpoints_json).length,
  techStack: JSON.parse(ws.tech_stack).length,
  tasks: taskRows.length,
  firstTask: taskRows[0] && { id: taskRows[0].id, title: taskRows[0].title, specChars: taskRows[0].L }
}, null, 1));
