// Ukur: apakah tahap tasks dipecah per-modul membuat tiap panggilan cukup
// pendek untuk selamat dari batas upstream OpenAgentic (~249s, 502 di
// generasi panjang). Bandingkan tasks-utuh vs tasks-per-modul, plus streaming.
import { readFileSync } from 'node:fs';

const cfg = readFileSync('/root/.prdmaker/config.yaml', 'utf8');
const key = cfg.match(/api_key:\s*(\S+)/)[1];
const base = cfg.match(/base_url:\s*(\S+)/)[1].replace(/\/+$/, '');
const src = readFileSync(new URL('../src/ai-prd.js', import.meta.url), 'utf8');
const C = (n) => src.match(new RegExp(`const ${n} = \`([\\s\\S]*?)\`;`))[1];

const model = process.argv[2] || 'oa/gpt-6-luna';
const TASKS_SYS = C('PRD_TASKS_SYSTEM_PROMPT');
const { skeleton } = await import('../tests/fixtures/prd.js');

// Kerangka uji: pakai fixture lalu perbesar agar mendekati PRD nyata
// (5 modul dengan acceptanceCriteria + edgeCases lengkap).
const modules = [
  'Autentikasi dan Sesi', 'Manajemen Surat', 'Pencarian Surat',
  'Manajemen Akun Petugas', 'Design System'
];
const sk = {
  ...skeleton,
  features: modules.map((m) => ({
    module: m,
    description: `Modul ${m} untuk aplikasi arsip surat 5 petugas, 500 surat per bulan.`,
    userStories: ['Sebagai petugas, saya ingin X sehingga Y.'],
    acceptanceCriteria: [
      'Aksi berhasil memberi hasil yang terlihat dalam 2 detik.',
      'Aksi gagal oleh petugas biasa ditolak dengan 403 dan tidak menampilkan data apa pun.',
      'Nomor surat duplikat ditolak dengan 409 dan pesan kesalahan yang jelas.'
    ],
    edgeCases: ['Sesi kedaluwarsa di tengah pengisian formulir: submit ditolak dan data tidak hilang.']
  })),
  databaseSchema: [
    { table: 'users', description: 'akun petugas dan admin', fields: ['id TEXT PRIMARY KEY', 'username TEXT UNIQUE NOT NULL', 'password_hash TEXT NOT NULL', 'role TEXT NOT NULL'] },
    { table: 'sessions', description: 'sesi login', fields: ['id TEXT PRIMARY KEY', 'user_id TEXT NOT NULL', 'expires_at INTEGER NOT NULL'] },
    { table: 'surat', description: 'metadata surat', fields: ['id TEXT PRIMARY KEY', 'nomor TEXT UNIQUE NOT NULL', 'judul TEXT NOT NULL', 'tanggal TEXT NOT NULL'] }
  ],
  apiEndpoints: [
    { method: 'POST', path: '/api/v1/login', description: 'login petugas/admin', payload: '{}', response: '{}' },
    { method: 'GET', path: '/api/v1/surat', description: 'daftar + cari surat', payload: '', response: '{}' },
    { method: 'POST', path: '/api/v1/surat', description: 'tambah surat', payload: '{}', response: '{}' }
  ]
};

const ctx = `Ide: aplikasi arsip surat untuk 5 petugas, 500 surat per bulan.\nKerangka PRD tahap 1:\n${JSON.stringify(sk)}\n\n`;

const call = async (label, userPrompt, stream = false) => {
  const t0 = Date.now();
  const secs = () => ((Date.now() - t0) / 1000).toFixed(0) + 's';
  try {
    const r = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'system', content: `${TASKS_SYS}\n\n[ref:${label}-${Date.now().toString(36)}]` }, { role: 'user', content: userPrompt }],
        temperature: 0.2, max_tokens: 7000, response_format: { type: 'json_object' }, stream
      })
    });
    const text = await r.text();
    if (r.status !== 200) {
      const kind = (text.match(/(fetch connect timeout|concurrent_limit|reset after \d+s)/) || [])[1] || '';
      return console.log(label.padEnd(26), r.status, secs(), kind, text.slice(0, 90));
    }
    let content = '', completion = '-';
    if (stream) {
      for (const line of text.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const p = line.slice(5).trim();
        if (p === '[DONE]') continue;
        try { const j = JSON.parse(p); content += j.choices?.[0]?.delta?.content ?? ''; if (j.usage?.completion_tokens) completion = j.usage.completion_tokens; } catch {}
      }
    } else {
      const cut = text.search(/\r?\n?data:\s*\[DONE\]/);
      const j = JSON.parse(text.slice(0, cut < 0 ? undefined : cut));
      content = j.choices?.[0]?.message?.content ?? '';
      completion = j.usage?.completion_tokens ?? '-';
    }
    let n = 'POTONG';
    try { n = (JSON.parse(content.slice(content.indexOf('{'), content.lastIndexOf('}') + 1)).tasks || []).length; } catch {}
    console.log(label.padEnd(26), '200', secs(), 'completion=' + completion, 'tasks=' + n, stream ? '(stream)' : '');
  } catch (e) {
    console.log(label.padEnd(26), 'ERR', secs(), e.message.slice(0, 60));
  }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('model:', model);
console.log('--- A) tasks UTUH (semua modul sekaligus), 2x');
await call('utuh-1', ctx + `Daftar nama modul: ${modules.join(', ')}\n\nSusun tasks sekarang.`);
await sleep(3000);
await call('utuh-2', ctx + `Daftar nama modul: ${modules.join(', ')}\n\nSusun tasks sekarang.`);

console.log('\n--- B) tasks PER-MODUL (satu modul tiap panggilan), 3 modul');
for (const m of modules.slice(0, 3)) {
  await sleep(3000);
  await call('modul:' + m.slice(0, 14), ctx +
    `Daftar nama modul: ${m}\n\nSusun tasks HANYA untuk modul "${m}" sekarang. ` +
    `Jangan menulis task untuk modul lain. Field "module" pada setiap task HARUS persis "${m}".`);
}

console.log('\n--- C) tasks utuh dengan STREAMING (apakah streaming selamat lebih lama)');
await sleep(3000);
await call('utuh-stream', ctx + `Daftar nama modul: ${modules.join(', ')}\n\nSusun tasks sekarang.`, true);
