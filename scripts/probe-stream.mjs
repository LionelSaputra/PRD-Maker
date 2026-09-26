// Uji hipotesis akar masalah luna: "reset after 30s" = router memutus koneksi
// IDLE. Non-stream tidak mengirim byte sampai generasi selesai; luna lambat
// (identitas 55s), jadi koneksi idle >30s -> reset. Stream mengalirkan token
// terus -> koneksi tidak pernah idle. Bandingkan tahap STACK luna non-stream
// vs stream, back-to-back, dengan prompt asli dari src/ai-prd.js.
import { readFileSync } from 'node:fs';

const cfg = readFileSync('/root/.prdmaker/config.yaml', 'utf8');
const key = cfg.match(/api_key:\s*(\S+)/)[1];
const base = cfg.match(/base_url:\s*(\S+)/)[1].replace(/\/+$/, '');
const auth = 'Bearer ' + key;
const src = readFileSync(new URL('../src/ai-prd.js', import.meta.url), 'utf8');
const CORE_SYS = src.match(/const PRD_CORE_SYSTEM_PROMPT = `([\s\S]*?)`;/)[1];

const model = process.argv[2] || 'oa/gpt-6-luna';
const decided = { projectName: 'Arsip Kantor', tagline: 'Cari surat kantor.', summary: 'Sistem arsip surat masuk untuk 5 petugas, 500 surat/bulan. Di luar lingkup: unggah berkas.' };
const prompt = `Project Name: Arsip Kantor
Ide Aplikasi: Aplikasi arsip surat masuk untuk 5 petugas di kantor dengan 500 surat per bulan. Petugas mencatat dan mencari surat; admin mengelola akun.

Keputusan produk yang sudah ditetapkan (jangan mengulang field ini):
${JSON.stringify(decided)}

Susun techStack dan architectureOverview sekarang.`;

async function call(label, stream) {
  const t0 = Date.now();
  const secs = () => ((Date.now() - t0) / 1000).toFixed(0) + 's';
  let firstByte = null, chunks = 0, content = '';
  try {
    const r = await fetch(base + '/chat/completions', {
      method: 'POST',
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'system', content: `${CORE_SYS}\n\n[ref:${label}-${Date.now().toString(36)}]` }, { role: 'user', content: prompt }],
        temperature: 0.2, max_tokens: 7000,
        response_format: { type: 'json_object' },
        ...(stream ? { stream: true } : {})
      })
    });
    if (r.status !== 200) {
      const t = await r.text();
      return console.log(label.padEnd(14), r.status, secs(), (t.match(/reset after \d+s|connect timeout|concurrent_limit|provider_request_failed|model_not_available/) || [t.slice(0, 60)])[0]);
    }
    if (stream) {
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (firstByte === null) firstByte = ((Date.now() - t0) / 1000).toFixed(1) + 's';
        chunks++;
        buf += dec.decode(value, { stream: true });
        for (const line of buf.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') continue;
          try { content += JSON.parse(payload).choices?.[0]?.delta?.content ?? ''; } catch {}
        }
        buf = buf.slice(buf.lastIndexOf('\n') + 1);
      }
    } else {
      const j = await r.json();
      firstByte = secs();
      content = j.choices?.[0]?.message?.content ?? '';
    }
    let ok = 'POTONG', keys = '';
    try { const o = JSON.parse(content.slice(content.indexOf('{'), content.lastIndexOf('}') + 1)); ok = (o.techStack && o.architectureOverview) ? 'OK' : 'KURANG'; keys = Object.keys(o).join(','); } catch {}
    console.log(label.padEnd(14), '200', secs(), 'firstByte=' + firstByte, 'chunks=' + chunks, ok, 'keys=' + keys, 'len=' + content.length);
  } catch (e) { console.log(label.padEnd(14), 'ERR', secs(), e.message.slice(0, 60)); }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
console.log('model:', model, '— tahap STACK (yang gagal non-stream di live run)');
await call('NONSTREAM', false); await sleep(4000);
await call('STREAM', true); await sleep(4000);
await call('NONSTREAM-2', false); await sleep(4000);
await call('STREAM-2', true);
