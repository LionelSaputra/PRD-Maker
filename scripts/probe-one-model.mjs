// Uji apakah satu model tertentu (mis. gemini-3.8-flash-high) benar-benar bisa
// dipakai untuk tahap PRD — bukan hanya terdaftar di /models. Panggilan kecil
// dulu (cek akses), lalu satu panggilan besar seukuran tahap fitur.
import { readFileSync } from 'node:fs';
const cfg = readFileSync('/root/.prdmaker/config.yaml', 'utf8');
const key = cfg.match(/api_key:\s*(\S+)/)[1];
const base = cfg.match(/base_url:\s*(\S+)/)[1].replace(/\/+$/, '');
const auth = 'Bearer ' + key;
const model = process.argv[2] || 'oa/gemini-3.8-flash-high';

const one = async (label, maxTokens, content) => {
  const t0 = Date.now();
  const secs = () => ((Date.now() - t0) / 1000).toFixed(1) + 's';
  try {
    const r = await fetch(base + '/chat/completions', {
      method: 'POST',
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content }], temperature: 0.2, max_tokens: maxTokens })
    });
    const t = await r.text();
    if (r.status !== 200) return console.log(label.padEnd(12), r.status, secs(), (t.match(/reset after \d+s|connect timeout|concurrent_limit|provider_request_failed|model_not_available|invalid[^"]*/) || [t.slice(0, 80)])[0]);
    let n = '-';
    try { const j = JSON.parse(t); n = j.choices?.[0]?.message?.content?.length ?? '-'; } catch {}
    console.log(label.padEnd(12), '200', secs(), 'len=' + n);
  } catch (e) { console.log(label.padEnd(12), 'ERR', secs(), e.message.slice(0, 70)); }
};

console.log('model:', model);
await one('kecil', 16, 'Balas satu kata: ok');
await new Promise(r => setTimeout(r, 3000));
await one('sedang', 7000, 'Tulis JSON {"features":[{"module":"Arsip","description":"Mengelola surat masuk dan keluar untuk lima petugas kantor dengan validasi server dan pesan kesalahan jelas","userStories":["Sebagai petugas saya ingin mencatat surat"],"acceptanceCriteria":["Berhasil dalam 2 detik","Tanpa hak ditolak 403"],"edgeCases":["Input kosong ditolak"]}]} dan sebutkan 4 modul lain: Pencarian, Akun, Log, Design System.');