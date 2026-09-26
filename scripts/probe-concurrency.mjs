// Membedakan dua penyebab 502 pada oa/qwen3.8-max:
// (a) model/upstream lambat untuk panggilan panjang, atau
// (b) router kehabisan slot konkuren (batas 4 user bersamaan).
//
// Uji: panggilan KECIL vs BESAR, lalu burst paralel kecil untuk melihat apakah
// 429 concurrent_limit muncul. Burst dibatasi 3 request supaya tidak mengunci
// sesi lain yang sedang memakai router.
import { readFileSync } from 'node:fs';

const cfg = readFileSync('/root/.prdmaker/config.yaml', 'utf8');
const key = cfg.match(/api_key:\s*(\S+)/)[1];
const base = cfg.match(/base_url:\s*(\S+)/)[1].replace(/\/+$/, '');
const src = readFileSync(new URL('../src/ai-prd.js', import.meta.url), 'utf8');
const constant = (name) => src.match(new RegExp(`const ${name} = \`([\\s\\S]*?)\`;`))[1];

const call = async (label, model, sys, user, maxTokens) => {
  const t0 = Date.now();
  const secs = () => ((Date.now() - t0) / 1000).toFixed(1) + 's';
  try {
    const r = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'system', content: `${sys}\n\n[ref:${label}-${Date.now().toString(36)}]` }, { role: 'user', content: user }],
        temperature: 0.2, max_tokens: maxTokens, response_format: { type: 'json_object' }
      })
    });
    const text = await r.text();
    if (r.status !== 200) {
      const code = (text.match(/"code":"([^"]+)"/) || [])[1] || '';
      const kind = (text.match(/(fetch connect timeout|concurrent_limit|reset after \d+s)/) || [])[1] || '';
      return { label, status: r.status, secs: secs(), code, kind, raw: text.slice(0, 150) };
    }
    const cut = text.search(/\r?\n?data:\s*\[DONE\]/);
    const j = JSON.parse(text.slice(0, cut < 0 ? undefined : cut));
    const c = j.choices?.[0]?.message?.content ?? '';
    let keys = 'UNPARSED';
    try { keys = Object.keys(JSON.parse(c.slice(c.indexOf('{'), c.lastIndexOf('}') + 1))).join(','); } catch {}
    return { label, status: 200, secs: secs(), keys, completion: j.usage?.completion_tokens ?? '-' };
  } catch (e) {
    return { label, status: 'ERR', secs: secs(), raw: e.message.slice(0, 80) };
  }
};

const show = (r) => console.log(JSON.stringify(r));

const TINY_SYS = 'Keluarkan HANYA JSON: {"ok": true}';
const BIG_SYS = constant('PRD_CORE_SYSTEM_PROMPT');
const BIG_USER = `Project Name: Arsip Kantor
Ide Aplikasi: Aplikasi arsip surat masuk untuk 5 petugas di kantor dengan 500 surat per bulan.
Keputusan produk: aplikasi web dengan antarmuka. Di luar lingkup: unggah berkas.

Susun techStack dan architectureOverview sekarang.`;

console.log('--- 1) panggilan KECIL (max_tokens 40): model hidup atau tidak?');
show(await call('tiny-qwen', 'oa/qwen3.8-max', TINY_SYS, 'sekarang', 40));
await new Promise(r => setTimeout(r, 3000));
show(await call('tiny-bunny', 'oa/space-bunny-free', TINY_SYS, 'sekarang', 40));

console.log('\n--- 2) burst 3 paralel ke qwen3.8-max: muncul 429 concurrent_limit?');
const burst = await Promise.all([
  call('burst-a', 'oa/qwen3.8-max', TINY_SYS, 'a', 40),
  call('burst-b', 'oa/qwen3.8-max', TINY_SYS, 'b', 40),
  call('burst-c', 'oa/qwen3.8-max', TINY_SYS, 'c', 40)
]);
burst.forEach(show);

console.log('\n--- 3) panggilan BESAR (prompt PRD asli, max_tokens 7000)');
await new Promise(r => setTimeout(r, 4000));
show(await call('big-qwen', 'oa/qwen3.8-max', BIG_SYS, BIG_USER, 7000));
