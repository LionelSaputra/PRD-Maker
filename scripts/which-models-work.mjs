// Cari model yang BENAR-BENAR bisa dipakai di plan ini: /v1/models menawarkan
// 41 model, tapi banyak yang 403 model_not_available. Kirim satu permintaan
// kecil per model dan catat status + error code.
import { readFileSync } from 'node:fs';

const cfg = readFileSync('/root/.prdmaker/config.yaml', 'utf8');
const key = cfg.match(/api_key:\s*(\S+)/)[1];
const base = cfg.match(/base_url:\s*(\S+)/)[1].replace(/\/+$/, '');

const r = await fetch(`${base}/models`, { headers: { Authorization: `Bearer ${key}` } });
const list = (await r.json()).data.map(m => m.id).filter(id => !/image|embed|audio|whisper|tts/i.test(id));

const probe = async (id) => {
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: id, messages: [{ role: 'user', content: 'Balas satu kata: siap' }], max_tokens: 16 })
    });
    const t = await res.text();
    if (res.ok) return 'OK';
    const code = (t.match(/"code":"([^"]+)"/) || [])[1] || 'HTTP ' + res.status;
    return code;
  } catch (e) { return 'FETCH ' + e.message.slice(0, 30); }
};

// Batasi konkurensi supaya tidak kena limit 1-request-per-key.
const results = [];
for (const id of list) {
  const status = await probe(id);
  results.push({ id, status });
  console.log(status === 'OK' ? 'OK  ' : '--  ', id, status === 'OK' ? '' : status);
}
console.log('\n=== bisa dipakai (' + results.filter(r => r.status === 'OK').length + '/' + results.length + ') ===');
console.log(results.filter(r => r.status === 'OK').map(r => r.id).join('\n'));
