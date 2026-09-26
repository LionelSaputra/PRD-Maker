// Ukur tahap rincian pada plafon 7000: seberapa sering terpotong, dan berapa
// completion_tokens yang benar-benar dibutuhkan. Kalau sering terpotong, tahap
// ini harus dipecah (features terpisah dari databaseSchema+apiEndpoints).
import { readFileSync } from 'node:fs';

const cfg = readFileSync('/root/.prdmaker/config.yaml', 'utf8');
const key = cfg.match(/api_key:\s*(\S+)/)[1];
const base = cfg.match(/base_url:\s*(\S+)/)[1].replace(/\/+$/, '');
const src = readFileSync(new URL('../src/ai-prd.js', import.meta.url), 'utf8');
const C = (n) => src.match(new RegExp(`const ${n} = \`([\\s\\S]*?)\`;`))[1];

const idea = 'Project Name: Arsip Kantor\nIde Aplikasi: Aplikasi arsip surat masuk untuk 5 petugas, 500 surat/bulan. Login petugas+admin, tanpa upload berkas.\n';
const decided = '\nKeputusan produk: aplikasi web dengan antarmuka, 5 petugas, 500 surat/bulan. Di luar lingkup: unggah berkas, pembayaran, realtime.\n';

const runs = [
  ['rincian-utuh (7000)', C('PRD_DETAIL_SYSTEM_PROMPT'), idea + decided + '\nStack: Node.js, SQLite\nSusun features, databaseSchema, apiEndpoints sekarang.', 7000],
  ['fitur-saja (7000)', C('PRD_DETAIL_SYSTEM_PROMPT'), idea + decided + '\nStack: Node.js, SQLite\nSusun HANYA features (array) sekarang. Jangan tulis databaseSchema atau apiEndpoints.', 7000],
  ['db+api-saja (7000)', C('PRD_DETAIL_SYSTEM_PROMPT'), idea + decided + '\nStack: Node.js, SQLite\nSusun HANYA databaseSchema dan apiEndpoints sekarang. Jangan tulis features.', 7000],
];

for (const [label, sys, user, mt] of runs) {
  const hasil = [];
  for (let i = 0; i < 2; i++) {
    let out = '';
    try {
      const t0 = Date.now();
      const r = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'oa/space-bunny-free',
          messages: [{ role: 'system', content: `${sys}\n\n[ref:${label}-${i}-${Date.now().toString(36)}]` }, { role: 'user', content: user }],
          temperature: 0.2, max_tokens: mt, response_format: { type: 'json_object' }
        })
      });
      const t = await r.text();
      const cut = t.search(/\r?\n?data:\s*\[DONE\]/);
      const j = JSON.parse(t.slice(0, cut < 0 ? undefined : cut));
      const secs = ((Date.now() - t0) / 1000).toFixed(0);
      if (r.status !== 200) { out = `HTTP${r.status}/${secs}s`; }
      else {
        const c = j.choices?.[0]?.message?.content ?? '';
        const fr = j.choices?.[0]?.finish_reason;
        const ct = j.usage?.completion_tokens ?? '-';
        let keys = 'POTONG';
        try { keys = Object.keys(JSON.parse(c.slice(c.indexOf('{'), c.lastIndexOf('}') + 1))).join('+'); } catch {}
        out = `${fr}/${ct}tok/${secs}s ${keys}`;
      }
    } catch (e) { out = 'ERR:' + e.message.slice(0, 30); }
    hasil.push(out);
    await new Promise(r => setTimeout(r, 3000));
  }
  console.log(label.padEnd(24), hasil.join('  ||  '));
}
