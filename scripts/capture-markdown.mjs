// Tangkap output MARKDOWN penuh dari model yang mengabaikan JSON mode,
// supaya parser fallback dibuat dari bentuk nyata, bukan tebakan.
import { readFileSync, writeFileSync } from 'node:fs';

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
  ['identitas', constant('PRD_IDENTITY_SYSTEM_PROMPT'), userBase + '\nTulis identitas produk (projectName, tagline, summary) sekarang.'],
  ['inti', constant('PRD_CORE_SYSTEM_PROMPT'), userBase + decidedText + '\nSusun techStack dan architectureOverview sekarang.'],
  ['rincian', constant('PRD_DETAIL_SYSTEM_PROMPT'), userBase + decidedText +
    `\nStack yang ditetapkan (techStack): ${JSON.stringify(['Node.js 22 LTS'])}\n` +
    'Susun features, databaseSchema, dan apiEndpoints sekarang.'],
  ['tasks', constant('PRD_TASKS_SYSTEM_PROMPT'), `Ide: arsip surat untuk 5 petugas\nKerangka PRD tahap 1:\n${JSON.stringify(decided)}\n\nDaftar nama modul: Arsip, Design System\n\nSusun tasks sekarang.`]
];

const chunks = [];
for (const [tag, sys, user] of runs) {
  const r = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'system', content: `${sys}\n\n[ref:${tag}-${Date.now().toString(36)}]` }, { role: 'user', content: user }],
      temperature: 0.2, max_tokens: 16000, response_format: { type: 'json_object' }
    })
  });
  const t = await r.text();
  const cut = t.search(/\r?\n?data:\s*\[DONE\]/);
  const j = JSON.parse(t.slice(0, cut < 0 ? undefined : cut));
  const c = j.choices?.[0]?.message?.content ?? '';
  chunks.push(`===== ${tag} (status ${r.status}, finish ${j.choices?.[0]?.finish_reason}, ${c.length} chars) =====\n${c}`);
}
writeFileSync('/tmp/model-raw.md', chunks.join('\n\n'));
console.log('ditulis /tmp/model-raw.md', chunks.map(c => c.split('\n')[0]).join('\n'));