// Uji model kandidat dengan system prompt ASLI dari src/ai-prd.js.
// Tujuan: cari model sehat untuk peran pembuat PRD, karena space-bunny-free
// sering 502/503 di tahap 2.
import { readFileSync } from 'node:fs';

const cfg = readFileSync('/root/.prdmaker/config.yaml', 'utf8');
const key = cfg.match(/api_key:\s*(\S+)/)[1];
const base = cfg.match(/base_url:\s*(\S+)/)[1].replace(/\/+$/, '');
const src = readFileSync(new URL('../src/ai-prd.js', import.meta.url), 'utf8');
const constant = (name) => src.match(new RegExp(`const ${name} = \`([\\s\\S]*?)\`;`))[1];

const model = process.argv[2] || 'oa/deepseek-v4.1-flash-free';
const decided = { projectName: 'Arsip Kantor', tagline: 'Cari surat kantor.', summary: 'Sistem arsip surat masuk untuk 5 petugas.' };
const userBase = `Project Name: Arsip Kantor
Ide Aplikasi: Aplikasi arsip surat masuk untuk 5 petugas di kantor dengan 500 surat per bulan.
HASIL KLARIFIKASI & KEPUTUSAN PENGGUNA:
1. Tanya: Siapa pengguna? Keputusan: Lima petugas administrasi
`;
const decidedText = '\nKeputusan produk yang sudah ditetapkan (jangan mengulang field ini):\n' + JSON.stringify(decided) + '\n';

const runs = [
  ['identitas', constant('PRD_IDENTITY_SYSTEM_PROMPT'), userBase + '\nTulis identitas produk (projectName, tagline, summary) sekarang.', ['projectName', 'tagline', 'summary']],
  ['inti', constant('PRD_CORE_SYSTEM_PROMPT'), userBase + decidedText + '\nSusun techStack dan architectureOverview sekarang.', ['techStack', 'architectureOverview']],
  ['rincian', constant('PRD_DETAIL_SYSTEM_PROMPT'), userBase + decidedText +
    `\nStack yang ditetapkan (techStack): ${JSON.stringify(['Node.js 22 LTS'])}\n` +
    'Susun features, databaseSchema, dan apiEndpoints sekarang.', ['features', 'databaseSchema', 'apiEndpoints']],
  ['tasks', constant('PRD_TASKS_SYSTEM_PROMPT'), `Ide: arsip surat untuk 5 petugas\nKerangka PRD tahap 1:\n${JSON.stringify(decided)}\n\nDaftar nama modul: Arsip, Design System\n\nSusun tasks sekarang.`, ['tasks']]
];

for (const [tag, sys, user, need] of runs) {
  const t0 = Date.now();
  let r, t;
  try {
    r = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'system', content: `${sys}\n\n[ref:${tag}-${Date.now().toString(36)}]` }, { role: 'user', content: user }],
        temperature: 0.2, max_tokens: 16000, response_format: { type: 'json_object' }
      })
    });
    t = await r.text();
  } catch (e) { console.log(tag, 'FETCH-FAIL', e.message); continue; }
  let j = {};
  try { j = JSON.parse(t.slice(0, t.search(/\r?\n?data:\s*\[DONE\]/) < 0 ? undefined : t.search(/\r?\n?data:\s*\[DONE\]/))); }
  catch (e) { console.log(tag, r.status, 'parse-fail', e.message, 'body=' + t.slice(0, 160)); continue; }
  const c = j.choices?.[0]?.message?.content ?? '';
  let keys = null;
  try { keys = Object.keys(JSON.parse(c.slice(c.indexOf('{'), c.lastIndexOf('}') + 1))); } catch {}
  const missing = keys ? need.filter(k => !keys.includes(k)) : need;
  const note = keys ? '' : ' | RAW=' + JSON.stringify(c.slice(0, 120));
  console.log(tag, r.status, `${((Date.now() - t0) / 1000).toFixed(1)}s`,
    'finish=' + j.choices?.[0]?.finish_reason, 'keys=' + (keys ? keys.join(',') : 'UNPARSED'),
    missing.length ? 'MISSING:' + missing.join(',') : 'OK', j.error?.message ?? '', note);
}