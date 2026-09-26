// Bandingkan tahap 1d GABUNGAN (databaseSchema+apiEndpoints sekaligus, perilaku
// sekarang) vs TERPISAH (dua panggilan kecil), dengan prompt sistem ASLI dari
// src/ai-prd.js dan brief seukuran PRD nyata. Mengukur apakah pemecahan
// menurunkan latensi di bawah cap ~249 detik upstream OpenAgentic.
import { readFileSync } from 'node:fs';

const cfg = readFileSync('/root/.prdmaker/config.yaml', 'utf8');
const key = cfg.match(/api_key:\s*(\S+)/)[1];
const base = cfg.match(/base_url:\s*(\S+)/)[1].replace(/\/+$/, '');
const src = readFileSync(new URL('../src/ai-prd.js', import.meta.url), 'utf8');
const DB_API_SYS = src.match(/const PRD_DB_API_SYSTEM_PROMPT = `([\s\S]*?)`;/)[1];
// Prompt terpisah: DB saja / API saja, memakai aturan sistem yang sama.
const DB_SYS = DB_API_SYS.replace('tepat dua kunci', 'tepat satu kunci')
  .replace(/\n\s*"apiEndpoints":\s*\[[\s\S]*?\]\n/, '\n')
  .replace('databaseSchema dan apiEndpoints', 'databaseSchema');
const API_SYS = DB_API_SYS.replace('tepat dua kunci', 'tepat satu kunci')
  .replace(/\n\s*"databaseSchema":\s*\[[\s\S]*?\],\n/, '\n')
  .replace('databaseSchema dan apiEndpoints', 'apiEndpoints');

const model = process.argv[2] || 'oa/gpt-6-luna';

// Brief seukuran PRD nyata: 5 modul, stack lengkap, klarifikasi.
const brief = `Project Name: Arsip Kantor
Ide Aplikasi: Aplikasi web arsip surat untuk 5 petugas dan 1 admin di satu kantor. Petugas mencatat surat masuk/keluar, mencari berdasarkan nomor atau judul, menandai disposisi. Admin mengelola akun petugas dan melihat log aktivitas. Skala kecil-menengah, ~500 surat/bulan. UI terang tenang, tabel desktop + daftar mobile.

HASIL KLARIFIKASI & KEPUTUSAN PENGGUNA:
1. Tanya: Autentikasi?  Keputusan: login sesi kantor, 2 peran (petugas, admin).
2. Tanya: Penyimpanan berkas?  Keputusan: tanpa unggah berkas, metadata saja.
3. Tanya: Notifikasi?  Keputusan: tidak ada notifikasi realtime.

Arah visual: data-analysis.
Stack yang ditetapkan (techStack): ["Node.js 22 + node:http","SQLite WAL","Server-rendered HTML + CSS","scrypt untuk hash password","Caddy reverse proxy TLS"]
Daftar modul fitur (skema dan endpoint harus mendukung semua modul ini): ["Autentikasi dan Sesi","Manajemen Surat","Pencarian Surat","Manajemen Akun Petugas","Design System"]
`;

const call = async (label, sys, prompt, requiredKeys) => {
  const t0 = Date.now();
  const secs = () => ((Date.now() - t0) / 1000).toFixed(0) + 's';
  try {
    const r = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'system', content: `${sys}\n\n[ref:${label}-${Date.now().toString(36)}]` }, { role: 'user', content: prompt }],
        temperature: 0.2, max_tokens: 7000, response_format: { type: 'json_object' }
      })
    });
    const text = await r.text();
    if (r.status !== 200) return console.log(label.padEnd(12), r.status, secs(), (text.match(/fetch connect timeout|concurrent_limit|reset after \d+s/) || [])[0] || 'ERR');
    const cut = text.search(/\r?\n?data:\s*\[DONE\]/);
    const j = JSON.parse(text.slice(0, cut < 0 ? undefined : cut));
    const c = j.choices?.[0]?.message?.content ?? '';
    let ok = 'POTONG', n = '';
    try { const o = JSON.parse(c.slice(c.indexOf('{'), c.lastIndexOf('}') + 1)); ok = requiredKeys.every(k => o[k]) ? 'OK' : 'KURANG:' + requiredKeys.filter(k => !o[k]); n = requiredKeys.map(k => (o[k] || []).length).join('/'); } catch {}
    console.log(label.padEnd(12), '200', secs(), 'completion=' + (j.usage?.completion_tokens ?? '-'), ok, 'item=' + n);
  } catch (e) { console.log(label.padEnd(12), 'ERR', secs(), e.message.slice(0, 50)); }
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
console.log('model:', model);
console.log('--- A) GABUNGAN (perilaku sekarang), 2x');
await call('gabung-1', DB_API_SYS, brief + 'Susun databaseSchema dan apiEndpoints sekarang.', ['databaseSchema', 'apiEndpoints']); await sleep(3000);
await call('gabung-2', DB_API_SYS, brief + 'Susun databaseSchema dan apiEndpoints sekarang.', ['databaseSchema', 'apiEndpoints']); await sleep(3000);
console.log('--- B) TERPISAH (DB lalu API), 2x');
await call('db-1', DB_SYS, brief + 'Susun databaseSchema sekarang.', ['databaseSchema']); await sleep(2000);
await call('api-1', API_SYS, brief + 'Susun apiEndpoints sekarang.', ['apiEndpoints']); await sleep(3000);
await call('db-2', DB_SYS, brief + 'Susun databaseSchema sekarang.', ['databaseSchema']); await sleep(2000);
await call('api-2', API_SYS, brief + 'Susun apiEndpoints sekarang.', ['apiEndpoints']);
