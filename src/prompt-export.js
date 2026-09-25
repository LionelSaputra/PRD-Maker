import { getDesignGuidance } from './design-guidance.js';

const list = (value) => {
  if (Array.isArray(value)) return value;
  try { const parsed = JSON.parse(value || '[]'); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
};
const clean = value => String(value ?? '').replace(/tok_[a-f0-9]{32}/gi, '[WORKSPACE_TOKEN_REDACTED]');
const shortId = (ws, task) => String(task.id || '').replace(`${ws.id}_`, '');
const json = value => clean(JSON.stringify(value, null, 2));

function context(ws) {
  // Explicit allowlist: never serialize the workspace record with its token.
  return `# PRD — ${clean(ws.name || ws.projectName)}

## Ringkasan & batas lingkup
${clean(ws.summary)}

## Stack
${json(list(ws.tech_stack || ws.techStack))}

## Arsitektur
${clean(ws.architecture || ws.architectureOverview)}

## Modul & acceptance criteria
${json(list(ws.features || ws.features_json))}

## Skema data
${json(list(ws.databaseSchema || ws.db_schema_json))}

## Kontrak API
${json(list(ws.apiEndpoints || ws.api_endpoints_json))}`;
}

const execution = `## Kontrak eksekusi
- Audit repository dan baca instruksi proyek sebelum mengedit. Pertahankan perubahan pengguna; jangan menimpa atau melakukan reset destruktif.
- Implementasikan kebutuhan PRD, bukan template generik. Jangan menambah stack/integrasi/fitur di luar lingkup. Jika ada keputusan berisiko yang belum jelas, tanyakan; tandai asumsi lainnya.
- Kerjakan task berurutan sesuai dependensi. Verifikasi prasyarat di kode, jangan menganggap status tracker sebagai bukti implementasi.
- Gunakan environment variables untuk secret dan .env.example tanpa nilai rahasia. Jangan menaruh API key di frontend, log, source, atau prompt. Deployment memakai HTTPS, validasi input dan otorisasi server-side sesuai ancaman aplikasi.
- Tiap task selesai harus punya bukti test/build atau langkah reproduksi dan hasil aktual. Jangan mengklaim test/deploy sukses jika belum dijalankan. Sertakan file berubah, hasil pengujian dan keterbatasan.
- Tidak memerlukan token workspace atau instalasi skill tambahan untuk memakai prompt ini. Integrasi CLI tracker bersifat opsional dan kredensial diberikan terpisah.`;

export function buildArchitecturePrompt(ws, tasks = []) {
  return `Implementasikan proyek berikut di repository yang tersedia. Mulai dengan audit singkat lalu kerjakan task pertama yang prasyaratnya terpenuhi; jangan hanya menjawab "siap".

${context(ws)}

## Rencana implementasi lengkap
${tasks.map(t => `### ${clean(shortId(ws,t))} — ${clean(t.title)}\nStatus tracker: ${clean(t.status || 'todo')}\n${clean(t.spec)}`).join('\n\n')}

${execution}

${getDesignGuidance()}
`;
}

export function buildTaskPrompt(ws, tasks = [], taskId) {
  const task = tasks.find(t => t.id === taskId || shortId(ws,t) === taskId);
  if (!task) throw Object.assign(new Error('Task not found'), { statusCode: 404 });
  return `Kerjakan HANYA task target di bawah. Prompt ini memuat konteks sendiri; tidak perlu percakapan sebelumnya.

${context(ws)}

## Peta task & dependensi
${tasks.map(t => `- ${clean(shortId(ws,t))}: ${clean(t.title)} [${clean(t.status || 'todo')}]`).join('\n')}

## TASK TARGET: ${clean(shortId(ws,task))} — ${clean(task.title)}
${clean(task.spec)}

Jika prasyarat belum diimplementasikan, jelaskan penghambat sebelum mengubah lingkup. Jangan mengerjakan seluruh task lain tanpa persetujuan.

${execution}

${getDesignGuidance()}
`;
}
