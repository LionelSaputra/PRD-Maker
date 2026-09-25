// Kirim system prompt ASLI dari src/ai-prd.js ke router untuk memastikan
// apakah router mengabaikannya saat prompt panjang.
import { readFileSync } from 'node:fs';

const cfg = readFileSync('/root/.prdmaker/config.yaml', 'utf8');
const key = cfg.match(/api_key:\s*(\S+)/)[1];
const base = cfg.match(/base_url:\s*(\S+)/)[1].replace(/\/+$/, '');

// Ambil konstanta template literal langsung dari sumber.
const src = readFileSync(new URL('../src/ai-prd.js', import.meta.url), 'utf8');
const constant = (name) => {
  const m = src.match(new RegExp(`const ${name} = \`([\\s\\S]*?)\`;`));
  if (!m) throw new Error('konstanta tidak ditemukan: ' + name);
  return m[1];
};

const decided = { projectName: 'Arsip Kantor', tagline: 'Cari surat kantor.', summary: 'Sistem arsip surat masuk untuk 5 petugas.' };
const userBase = `Project Name: Arsip Kantor
Ide Aplikasi: Aplikasi arsip surat masuk untuk 5 petugas di kantor dengan 500 surat per bulan.
HASIL KLARIFIKASI & KEPUTUSAN PENGGUNA:
1. Tanya: Siapa pengguna? Keputusan: Lima petugas administrasi
`;
const decidedText = '\nKeputusan produk yang sudah ditetapkan (jangan mengulang field ini):\n' +
  JSON.stringify(decided) + '\n';

const runs = [
  ['identitas', constant('PRD_IDENTITY_SYSTEM_PROMPT'), userBase + '\nTulis identitas produk (projectName, tagline, summary) sekarang.'],
  ['inti', constant('PRD_CORE_SYSTEM_PROMPT'), userBase + decidedText + '\nSusun techStack dan architectureOverview sekarang.'],
  ['rincian', constant('PRD_DETAIL_SYSTEM_PROMPT'), userBase + decidedText +
    `\nStack yang ditetapkan (techStack): ${JSON.stringify(['Node.js 22 LTS'])}\n` +
    'Susun features, databaseSchema, dan apiEndpoints sekarang.']
];

for (const [tag, sys, user] of runs) {
  const t0 = Date.now();
  const r = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'oa/space-bunny-free',
      messages: [
        { role: 'system', content: `${sys}\n\n[ref:${tag}-${Date.now().toString(36)}]` },
        { role: 'user', content: user }
      ],
      temperature: 0.2,
      max_tokens: 16000,
      response_format: { type: 'json_object' }
    })
  });
  const t = await r.text();
  let j = {};
  try { j = JSON.parse(t.slice(0, t.search(/\r?\n?data:\s*\[DONE\]/))); } catch (e) {
    console.log(tag, r.status, 'parse-fail', e.message, 'len=' + t.length, t.slice(-100)); continue;
  }
  const c = j.choices?.[0]?.message?.content ?? '';
  let keys = 'UNPARSED';
  try { keys = Object.keys(JSON.parse(c.slice(c.indexOf('{'), c.lastIndexOf('}') + 1))); } catch {}
  console.log(tag, r.status, `${((Date.now() - t0) / 1000).toFixed(1)}s`, 'sysLen=' + sys.length,
    'finish=' + j.choices?.[0]?.finish_reason, keys,
    'cached=' + (j.usage?.prompt_tokens_details?.cached_tokens ?? '-'), j.error?.message ?? '');
}
