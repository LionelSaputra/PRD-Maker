// Bandingkan konteks tasks PENUH vs RAMPING dengan prompt asli dari
// src/ai-prd.js, memakai skeleton seukuran PRD live nyata. Mengukur apakah
// pemangkasan benar-benar menstabilkan latensi di bawah batas ~249 detik.
import { readFileSync } from 'node:fs';

const cfg = readFileSync('/root/.prdmaker/config.yaml', 'utf8');
const key = cfg.match(/api_key:\s*(\S+)/)[1];
const base = cfg.match(/base_url:\s*(\S+)/)[1].replace(/\/+$/, '');
const src = readFileSync(new URL('../src/ai-prd.js', import.meta.url), 'utf8');
const TASKS_SYS = src.match(/const PRD_TASKS_SYSTEM_PROMPT = `([\s\S]*?)`;/)[1];

const model = process.argv[2] || 'oa/gpt-6-luna';

const mkFeature = (m) => ({
  module: m,
  description: `Modul ${m} untuk aplikasi arsip surat 5 petugas, 500 surat/bulan. Alur: petugas membuka daftar, menambah atau mengubah metadata surat, lalu mencari berdasarkan nomor atau judul. Validasi di server, kesalahan dikembalikan sebagai status HTTP dengan pesan jelas.`,
  userStories: [`Sebagai petugas, saya ingin mengelola ${m} sehingga pekerjaan arsip lebih cepat.`, `Sebagai admin, saya ingin mengawasi ${m} sehingga data tetap rapi.`],
  acceptanceCriteria: [
    'Aksi berhasil memberi hasil terlihat dalam 2 detik dan mencatat waktu operasi.',
    'Aksi oleh petugas tanpa hak ditolak 403 dan tidak menampilkan data apa pun.',
    'Nomor surat duplikat ditolak 409 dengan pesan kesalahan yang jelas.',
    'Sesi kedaluwarsa di tengah form: submit ditolak, data isian tidak hilang.'
  ],
  edgeCases: ['Input kosong atau terlalu panjang ditolak validasi server.', 'Koneksi putus saat menyimpan: tidak ada data setengah tertulis.']
});

const skeleton = {
  projectName: 'Arsip Kantor',
  tagline: 'Cari dan catat surat kantor lewat nomor atau judul, tanpa unggah berkas.',
  summary: 'Arsip Kantor dibuat untuk menggantikan pencatatan surat masuk manual yang lambat dan rawan hilang. '.repeat(12) + ' Di luar lingkup: unggah berkas, pembayaran, notifikasi realtime.',
  techStack: ['Node.js 22 + node:http', 'SQLite WAL', 'Server-rendered HTML + CSS', 'scrypt untuk hash password', 'Caddy reverse proxy TLS'],
  architectureOverview: ('Keputusan teknologi: Node.js monolith dan SQLite dipilih karena lima petugas dan 500 surat per bulan tidak sepadan dengan biaya operasional Postgres. Alternatif ditolak: Supabase menambah vendor lock. '.repeat(14)),
  features: ['Autentikasi dan Sesi', 'Manajemen Surat', 'Pencarian Surat', 'Manajemen Akun Petugas', 'Design System'].map(mkFeature),
  databaseSchema: [
    { table: 'users', description: 'akun petugas dan admin', fields: ['id TEXT PRIMARY KEY', 'username TEXT UNIQUE NOT NULL', 'password_hash TEXT NOT NULL', 'role TEXT NOT NULL', 'created_at TEXT NOT NULL'] },
    { table: 'sessions', description: 'sesi login server-side', fields: ['id TEXT PRIMARY KEY', 'user_id TEXT NOT NULL', 'token_hash TEXT NOT NULL', 'expires_at INTEGER NOT NULL'] },
    { table: 'surat', description: 'metadata surat masuk', fields: ['id TEXT PRIMARY KEY', 'nomor TEXT UNIQUE NOT NULL', 'judul TEXT NOT NULL', 'tanggal TEXT NOT NULL', 'jenis TEXT', 'status TEXT', 'created_by TEXT', 'created_at TEXT NOT NULL'] }
  ],
  apiEndpoints: [
    { method: 'POST', path: '/api/v1/login', description: 'login petugas/admin, set cookie sesi', payload: '{}', response: '{}' },
    { method: 'POST', path: '/api/v1/logout', description: 'hapus sesi', payload: '', response: '{}' },
    { method: 'GET', path: '/api/v1/surat', description: 'daftar + cari surat', payload: '', response: '{}' },
    { method: 'POST', path: '/api/v1/surat', description: 'tambah surat', payload: '{}', response: '{}' },
    { method: 'PATCH', path: '/api/v1/surat/:id', description: 'ubah metadata surat', payload: '{}', response: '{}' },
    { method: 'DELETE', path: '/api/v1/surat/:id', description: 'hapus surat (admin)', payload: '', response: '{}' },
    { method: 'GET', path: '/api/v1/users', description: 'daftar akun (admin)', payload: '', response: '{}' },
    { method: 'POST', path: '/api/v1/users', description: 'buat akun (admin)', payload: '{}', response: '{}' },
    { method: 'PATCH', path: '/api/v1/users/:id', description: 'ubah akun (admin)', payload: '{}', response: '{}' },
    { method: 'GET', path: '/api/v1/log', description: 'log aktivitas (admin)', payload: '', response: '{}' }
  ]
};

// Persis seperti taskContext() di src/ai-prd.js.
const trimmed = JSON.stringify({
  projectName: skeleton.projectName,
  techStack: skeleton.techStack,
  features: skeleton.features.map(f => ({ module: f.module, description: String(f.description || '').slice(0, 320), acceptanceCriteria: (f.acceptanceCriteria || []).slice(0, 5) })),
  databaseSchema: skeleton.databaseSchema.map(t => ({ table: t.table, fields: t.fields })),
  apiEndpoints: skeleton.apiEndpoints.map(e => ({ method: e.method, path: e.path, description: String(e.description || '').slice(0, 160) }))
});

const modules = skeleton.features.map(f => f.module).join(', ');
const fullCtx = `Ide: aplikasi arsip surat 5 petugas.\nKerangka PRD tahap 1:\n${JSON.stringify(skeleton)}\n\nDaftar nama modul: ${modules}\n\n`;
const trimCtx = `Ide: aplikasi arsip surat 5 petugas.\nKerangka PRD tahap 1 (dipangkas ke yang relevan untuk tasks):\n${trimmed}\n\nDaftar nama modul: ${modules}\n\n`;

console.log('panjang konteks: PENUH=' + fullCtx.length + '  RAMPING=' + trimCtx.length + '  (' + Math.round(100 - 100 * trimCtx.length / fullCtx.length) + '% lebih kecil)');

const call = async (label, ctx) => {
  const t0 = Date.now();
  const secs = () => ((Date.now() - t0) / 1000).toFixed(0) + 's';
  try {
    const r = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'system', content: `${TASKS_SYS}\n\n[ref:${label}-${Date.now().toString(36)}]` }, { role: 'user', content: ctx + 'Susun tasks sekarang.' }],
        temperature: 0.2, max_tokens: 7000, response_format: { type: 'json_object' }
      })
    });
    const text = await r.text();
    if (r.status !== 200) return console.log(label.padEnd(10), r.status, secs(), (text.match(/fetch connect timeout|concurrent_limit|reset after \d+s/) || [])[0] || '');
    const cut = text.search(/\r?\n?data:\s*\[DONE\]/);
    const j = JSON.parse(text.slice(0, cut < 0 ? undefined : cut));
    const c = j.choices?.[0]?.message?.content ?? '';
    let n = 'POTONG';
    try { n = (JSON.parse(c.slice(c.indexOf('{'), c.lastIndexOf('}') + 1)).tasks || []).length; } catch {}
    console.log(label.padEnd(10), '200', secs(), 'completion=' + (j.usage?.completion_tokens ?? '-'), 'tasks=' + n);
  } catch (e) { console.log(label.padEnd(10), 'ERR', secs(), e.message.slice(0, 50)); }
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
console.log('model:', model);
await call('PENUH', fullCtx); await sleep(3000);
await call('RAMPING', trimCtx); await sleep(3000);
await call('PENUH', fullCtx); await sleep(3000);
await call('RAMPING', trimCtx);
