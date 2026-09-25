// Ukur threshold 502: kirim system prompt inti teknis PERSIS seperti aplikasi
// kirimkan, lalu versi yang dipangkas, lalu versi minimal, satu per satu.
import { readFileSync } from 'node:fs';
import { designTemplatePromptBlock, designDirectionPromptBlock } from '../src/design-templates.js';
import { getDesignGuidance } from '../src/design-guidance.js';

const key = readFileSync(process.env.HOME + '/.prdmaker/config.yaml', 'utf8').match(/api_key:\s*(\S+)/)[1];
const src = readFileSync(new URL('../src/ai-prd.js', import.meta.url), 'utf8');
const grab = (name) => {
  const i = src.indexOf('const ' + name + ' = `');
  const j = src.indexOf('`;', i);
  return src.slice(i, j)
    .replace('${designTemplatePromptBlock()}', designTemplatePromptBlock())
    .replace('${getDesignGuidance()}', getDesignGuidance());
};
const core = grab('PRD_SKELETON_SYSTEM_PROMPT');
const user = 'Project Name: Sistem Kutipan Renovasi\nIde: kutipan harga renovasi untuk kontraktor kecil, 3 pengguna, SQLite, PDF, audit harga. Bukan landing page.\n' +
  designDirectionPromptBlock('utility-function') + '\n';

async function ask(label, system) {
  const t0 = Date.now();
  const res = await fetch('http://127.0.0.1:20127/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'oa/space-bunny-free', temperature: 0.2, max_tokens: 16000,
      response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }]
    })
  });
  const raw = await res.text();
  let keys = [];
  const m = raw.match(/"content":"((?:[^"\\]|\\.)*)"/);
  if (m) {
    try { keys = Object.keys(JSON.parse(JSON.parse('"' + m[1] + '"'))); } catch { keys = ['PARSE_FAIL']; }
  }
  console.log(JSON.stringify({ label, sysChars: system.length, userChars: user.length, http: res.status, secs: +((Date.now() - t0) / 1000).toFixed(1), keys }));
}

await ask('1 inti penuh', core);
await ask('2 inti tanpa daftar template', core.replace(designTemplatePromptBlock(), ''));
await ask('3 inti tanpa guidance', core.replace(getDesignGuidance(), ''));
