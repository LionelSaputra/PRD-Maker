// Cek cepat kesehatan 3 model kandidat saat ini (panggilan kecil, 1 kata).
import { readFileSync } from 'node:fs';
const cfg = readFileSync('/root/.prdmaker/config.yaml', 'utf8');
const key = cfg.match(/api_key:\s*(\S+)/)[1];
const base = cfg.match(/base_url:\s*(\S+)/)[1].replace(/\/+$/, '');
const auth = 'Bearer ' + key;
for (const m of ['oa/gpt-6-luna', 'oa/space-bunny-free', 'oa/mimo-v2.6-flash', 'oa/deepseek-v4.1-flash-free']) {
  const t0 = Date.now();
  try {
    const r = await fetch(base + '/chat/completions', {
      method: 'POST',
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: m, messages: [{ role: 'user', content: 'Balas satu kata: ok' }], max_tokens: 16 })
    });
    const txt = await r.text();
    const why = r.status === 200 ? 'OK' : (txt.match(/reset after \d+s|connect timeout|concurrent_limit|provider_request_failed|model_not_available/) || [txt.slice(0, 60)])[0];
    console.log(m.padEnd(28), r.status, ((Date.now() - t0) / 1000).toFixed(1) + 's', why);
  } catch (e) { console.log(m.padEnd(28), 'ERR', ((Date.now() - t0) / 1000).toFixed(1) + 's', e.message.slice(0, 50)); }
  await new Promise(r => setTimeout(r, 2500));
}
