// Uji apakah oa/qwen3.8-max bisa dipakai untuk PRD: apakah 502 di tahap inti
// bersifat sementara, dan apakah streaming bertahan dari batas router.
import { readFileSync } from 'node:fs';

const cfg = readFileSync('/root/.prdmaker/config.yaml', 'utf8');
const key = cfg.match(/api_key:\s*(\S+)/)[1];
const base = cfg.match(/base_url:\s*(\S+)/)[1].replace(/\/+$/, '');
const src = readFileSync(new URL('../src/ai-prd.js', import.meta.url), 'utf8');
const constant = (name) => src.match(new RegExp(`const ${name} = \`([\\s\\S]*?)\`;`))[1];

const decided = { projectName: 'Arsip Kantor', tagline: 'Cari surat kantor.', summary: 'Sistem arsip surat masuk untuk 5 petugas. Di luar lingkup: unggah berkas.' };
const userBase = `Project Name: Arsip Kantor\nIde Aplikasi: Aplikasi arsip surat masuk untuk 5 petugas di kantor dengan 500 surat per bulan.\n`;
const decidedText = '\nKeputusan produk yang sudah ditetapkan (jangan mengulang field ini):\n' + JSON.stringify(decided) + '\n';
const sys = constant('PRD_CORE_SYSTEM_PROMPT');
const user = userBase + decidedText + '\nSusun techStack dan architectureOverview sekarang.';

const keysOf = (content) => {
  try {
    const slice = content.slice(content.indexOf('{'), content.lastIndexOf('}') + 1);
    return Object.keys(JSON.parse(slice)).join(',');
  } catch { return 'UNPARSED'; }
};

const once = async (label, stream) => {
  const t0 = Date.now();
  const secs = () => ((Date.now() - t0) / 1000).toFixed(0) + 's';
  try {
    const r = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'oa/qwen3.8-max',
        messages: [{ role: 'system', content: `${sys}\n\n[ref:${label}-${Date.now().toString(36)}]` }, { role: 'user', content: user }],
        temperature: 0.2, max_tokens: 7000, response_format: { type: 'json_object' }, stream
      })
    });
    if (r.status !== 200) {
      const t = await r.text();
      return console.log(label, 'HTTP', r.status, secs(), '|', t.slice(0, 130));
    }
    const text = await r.text();
    if (!stream) {
      const cut = text.search(/\r?\n?data:\s*\[DONE\]/);
      const j = JSON.parse(text.slice(0, cut < 0 ? undefined : cut));
      const c = j.choices?.[0]?.message?.content ?? '';
      return console.log(label, 'HTTP200', secs(), 'finish=' + j.choices?.[0]?.finish_reason,
        'completion=' + (j.usage?.completion_tokens ?? '-'), 'keys=' + keysOf(c));
    }
    let content = '';
    for (const line of text.split('\n')) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') continue;
      try { content += JSON.parse(payload).choices?.[0]?.delta?.content ?? ''; } catch {}
    }
    console.log(label, 'HTTP200 STREAM', secs(), 'chunks=' + (text.match(/^data:/gm) || []).length,
      'len=' + content.length, 'keys=' + keysOf(content));
  } catch (e) {
    console.log(label, 'ERR', secs(), e.message.slice(0, 90));
  }
};

await once('nonstream-1', false);
await new Promise(r => setTimeout(r, 4000));
await once('nonstream-2', false);
await new Promise(r => setTimeout(r, 4000));
await once('stream-1', true);
