import fs from 'fs';
import os from 'os';
import { join } from 'path';
import { designTemplatePromptBlock, designDirectionPromptBlock } from './design-templates.js';
import { getDesignGuidance } from './design-guidance.js';

// Konfigurasi penyedia AI. Dulu nilai-nilai ini di-hardcode ke satu server
// tertentu, sehingga repo tidak bisa dijalankan di mesin lain. Sekarang dibaca
// dari environment lebih dulu, baru jatuh ke berkas konfigurasi lokal.
const DEFAULT_BASE_URL = 'http://127.0.0.1:20127/v1';
const DEFAULT_CONFIG_PATH = join(os.homedir(), '.prdmaker', 'config.yaml');

function readConfigFile() {
  const path = process.env.PRDMAKER_CONFIG || DEFAULT_CONFIG_PATH;
  try {
    if (!fs.existsSync(path)) return {};
    const content = fs.readFileSync(path, 'utf8');
    const keyMatch = content.match(/^\s*api_key:\s*['"]?([^\s'"]+)/m);
    const urlMatch = content.match(/^\s*base_?url:\s*['"]?([^\s'"]+)/m);
    const modelMatch = content.match(/^\s*(?:default_)?model:\s*['"]?([^\s'"]+)/m);
    return {
      apiKey: keyMatch ? keyMatch[1] : null,
      baseUrl: urlMatch ? urlMatch[1] : null,
      defaultModel: modelMatch ? modelMatch[1] : null
    };
  } catch (err) {
    console.warn('Failed to read AI config file:', err.message);
    return {};
  }
}

function getRouterConfig() {
  const fromFile = readConfigFile();
  return {
    baseUrl: process.env.PRDMAKER_BASE_URL || fromFile.baseUrl || DEFAULT_BASE_URL,
    apiKey: process.env.PRDMAKER_API_KEY || fromFile.apiKey || null,
    defaultModel: process.env.PRDMAKER_MODEL || fromFile.defaultModel || null
  };
}

// Rantai model untuk pembuatan PRD. Terukur pada plan free: hanya 6 dari 41
// model di /v1/models yang benar-benar bisa dipanggil (sisanya 403
// model_not_available), dan dari enam itu hanya tiga yang lolos format JSON
// untuk SELURUH tahap PRD. Urutan ini bukan preferensi, tapi hasil pengukuran
// `scripts/probe-model.mjs` + `scripts/which-models-work.mjs`.
// Kalau model yang dipilih pengguna gagal, generate memakai model berikutnya.
// ponytail: perbarui daftar ini kalau plan berubah; jangan tambah model tanpa
// menjalankan probe-model.mjs lebih dulu.
export const PRD_MODEL_CHAIN = Object.freeze([
  'oa/space-bunny-free',
  'oa/mimo-v2.6-flash',
  'oa/deepseek-v4.1-flash-free'
]);

// Model yang dipilih pengguna dicoba lebih dulu, lalu rantai di atas sebagai
// cadangan (tanpa duplikat). Pengguna tetap boleh memilih model lain; rantai
// hanya menyelamatkan generate yang gagal.
export function prdModelCandidates(chosen) {
  const list = [chosen, ...PRD_MODEL_CHAIN].filter(Boolean);
  return [...new Set(list)];
}

export async function fetchAvailableModels() {
  const cfg = getRouterConfig();
  if (!cfg.apiKey) return cfg.defaultModel ? [cfg.defaultModel] : [];
  try {
    const res = await fetch(`${cfg.baseUrl}/models`, {
      headers: { Authorization: `Bearer ${cfg.apiKey}` }, signal: AbortSignal.timeout(10000)
    });
    if (!res.ok) return [];
    const data = await res.json();
    const all = (Array.isArray(data.data) ? data.data : [])
      .filter(m => m && typeof m.id === 'string' && m.id.trim())
      // Discovery bukan jaminan kuota, tetapi model teks yang diiklankan
      // harus tetap bisa dipilih (termasuk oa/gpt-6-astra).
      .filter(m => !/image|embedding|rerank|whisper|tts|video|audio/i.test(m.id))
      .map(m => m.id);
    return all.length ? [...new Set(all)] : (cfg.defaultModel ? [cfg.defaultModel] : []);
  } catch { return cfg.defaultModel ? [cfg.defaultModel] : []; }
}

// Router kadang menjawab dengan JSON biasa, kadang dengan format SSE
// ("data: {...}\n\ndata: [DONE]"). Versi lama memotong di penanda [DONE] pertama
// lalu mengambil dari "{" pertama sampai "}" terakhir, sehingga kalau ada lebih
// dari satu penanda, potongannya justru menyeberangi blok JSON lain dan rusak
// ("Extra data" / "Unexpected token #"). Sekarang blok SSE diurai satu per satu
// dan objek yang benar-benar berisi choices yang dipakai.
function parseRouterResponse(rawHttpText) {
  const raw = String(rawHttpText || '').trim();

  // Coba JSON utuh dulu (respons non-streaming biasa).
  try {
    const direct = JSON.parse(raw);
    if (direct && typeof direct === 'object') return direct;
  } catch { /* lanjut ke jalur SSE */ }

  // Jalur SSE: ambil setiap baris "data: ..." yang bukan [DONE].
  const candidates = [];
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^data:\s*(.+)$/i);
    if (!m) continue;
    const payload = m[1].trim();
    if (!payload || /^\[DONE\]$/i.test(payload)) continue;
    try {
      candidates.push(JSON.parse(payload));
    } catch { /* blok parsial, lewati */ }
  }
  // Pilih kandidat terakhir yang punya choices (paling lengkap).
  const withChoices = candidates.filter(c => c && c.choices);
  if (withChoices.length > 0) return withChoices[withChoices.length - 1];

  // Fallback terakhir: potong dari "{" pertama, tapi hanya kalau seimbang.
  const firstOpen = raw.indexOf('{');
  if (firstOpen !== -1) {
    let depth = 0, inStr = false, esc = false;
    for (let i = firstOpen; i < raw.length; i++) {
      const ch = raw[i];
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          try { return JSON.parse(raw.substring(firstOpen, i + 1)); } catch { /* coba lagi */ }
        }
      }
    }
  }

  throw new Error('Router mengembalikan format yang tidak dikenali');
}

// Terjemahkan error router mentah menjadi pesan yang bisa ditindaklanjuti
// pengguna. Sebelumnya semua kegagalan tampil sebagai "router tidak bisa
// dihubungi", padahal penyebab paling sering adalah kuota model habis.
function routerErrorMessage(raw, action) {
  const text = String(raw || '');
  // Status HTTP yang sudah dinormalisasi harus dideteksi lebih dulu.
  // Fetch Error lokal boleh dipetakan ke koneksi; teks filter/validator
  // tidak boleh berubah kategori karena kata "timeout"/"error" di dalamnya.
  const hasHttpStatus = /HTTP\s+\d{3}/i.test(text);
  if (hasHttpStatus && /concurrent_limit|Batas request bersamaan/i.test(text)) {
    return `Gagal ${action}: ada permintaan lain yang masih berjalan. Tunggu sebentar, lalu coba lagi.`;
  }
  if (hasHttpStatus && /429|free_shared_pool_exhausted|Kuota gratis/i.test(text)) {
    return `Gagal ${action}: kuota model AI yang dipilih sudah habis. ` +
      'Pilih model lain di pemilih model (di atas tombol Susun PRD), lalu coba lagi. ' +
      'Model gratis biasanya pulih besok pukul 00:00 WIB.';
  }
  if (hasHttpStatus && /500|502|503|504|provider_request_failed/i.test(text)) {
    return `Gagal ${action}: layanan AI sedang bermasalah dan belum merespons tepat waktu. ` +
      'Coba lagi sebentar lagi, atau pilih model lain di pemilih model.';
  }
  if (hasHttpStatus && /403|model_not_available|tidak tersedia di plan/i.test(text)) {
    return `Gagal ${action}: model yang dipilih tidak tersedia di langganan Anda. ` +
      'Pilih model lain di pemilih model, lalu coba lagi.';
  }
  if (hasHttpStatus && /402|insufficient|billing|saldo/i.test(text)) {
    return `Gagal ${action}: saldo atau tagihan penyedia AI bermasalah. ` +
      'Periksa langganan router, lalu coba lagi.';
  }
  if (text === 'provider_connection_failed') {
    return `Gagal ${action}: layanan AI tidak merespons tepat waktu (koneksi ke penyedia model bermasalah). ` +
      'Coba lagi sebentar lagi, atau pilih model lain di pemilih model.';
  }
  if (text === 'output_truncated') {
    return `Gagal ${action}: jawaban model terlalu panjang dan terpotong, jadi tidak bisa disimpan. ` +
      'Coba lagi, atau pilih model lain di pemilih model yang lebih hemat context.';
  }
  if (/is not valid JSON|Unexpected token|Expected property name|teks biasa, bukan JSON/i.test(text)) {
    return `Gagal ${action}: model ini menjawab dengan teks biasa, bukan format JSON yang dibutuhkan, ` +
      'sehingga hasilnya tidak bisa dibaca. Ini kelemahan model, bukan kesalahan Anda: ' +
      'pilih model lain di pemilih model, lalu coba lagi.';
  }
  if (/content kosong|tidak mengembalikan isi jawaban/i.test(text)) {
    return `Gagal ${action}: model tidak mengirim isi jawaban sama sekali. Coba lagi, atau pilih model lain di pemilih model.`;
  }
  if (/tidak menghasilkan .* setelah dua percobaan/i.test(text)) {
    return `Gagal ${action}: model ini menjawab dengan bentuk yang salah tahap dan tidak menghasilkan bagian yang dibutuhkan. ` +
      'Ini kelemahan model, bukan kesalahan Anda: pilih model lain di pemilih model, lalu coba lagi.';
  }
  if (/format yang tidak dikenali/i.test(text)) {
    return `Gagal ${action}: balasan dari layanan AI tidak bisa dibaca (format tidak dikenal). Coba lagi, atau pilih model lain.`;
  }
  return `Gagal ${action}: layanan AI mengembalikan jawaban yang tidak valid. Coba lagi, atau ganti model di pemilih model.`;
}

// Ambil objek JSON pertama yang kurung kurawalnya berimbang, dengan sadar
// string supaya "}" di dalam teks tidak dihitung sebagai penutup.
export function firstBalancedObject(text, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.substring(start, i + 1);
    }
  }
  return null;
}

// Escape karakter kontrol mentah (newline, tab, CR) yang muncul DI DALAM
// string JSON. Di luar string karakter itu memang format, jadi harus
// dibiarkan agar struktur JSON tetap sah.
export function escapeRawControlChars(json) {
  let out = '';
  let inString = false;
  let escaped = false;
  for (const ch of String(json)) {
    if (escaped) { out += ch; escaped = false; continue; }
    if (ch === '\\') { out += ch; escaped = true; continue; }
    if (ch === '"') { inString = !inString; out += ch; continue; }
    if (inString) {
      if (ch === '\n') { out += '\\n'; continue; }
      if (ch === '\r') { out += '\\r'; continue; }
      if (ch === '\t') { out += '\\t'; continue; }
    }
    out += ch;
  }
  return out;
}

export function extractJSON(raw) {
  if (!raw) return '{}';
  let str = raw.trim();
  str = str.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

  const firstOpen = str.indexOf('{');
  if (firstOpen !== -1) {
    // Ambil objek BERIMBANG pertama, bukan dari "{" pertama sampai "}"
    // terakhir. Model kadang mengeluarkan dua objek JSON berurutan, dan
    // potongan first..last justru menyeberangi keduanya lalu gagal parse.
    const balanced = firstBalancedObject(str, firstOpen);
    if (balanced) return escapeRawControlChars(balanced);
  }
  const lastClose = str.lastIndexOf('}');
  if (firstOpen !== -1 && lastClose !== -1 && lastClose > firstOpen) {
    const slice = str.substring(firstOpen, lastClose + 1);
    // Model gratis kadang menulis baris baru/tab MENTAH di dalam string JSON
    // ("... satu proses\n  node:http ..."), sehingga JSON.parse menolak dengan
    // "Bad control character in string literal". Isinya benar, hanya
    // encoding-nya cacat: escape di dalam string, sisanya dibiarkan.
    return escapeRawControlChars(slice);
  }

  // Jalur terakhir: sebagian model (mis. oa/deepseek-v4.1-flash-free) menjawab
  // dengan heading Markdown, bukan JSON, padahal JSON mode diminta. Hanya satu
  // bentuk yang ditangani — daftar task Markdown — karena itu satu-satunya
  // tahap yang terukur jatuh ke prose. Bentuk lain tetap dilaporkan gagal
  // supaya tidak ada penguraian tegas yang menyamar jadi data.
  // ponytail: tambah bentuk lain hanya kalau ada contoh keluaran nyata.
  const tasks = parseMarkdownTasks(str);
  if (tasks.length) return JSON.stringify({ tasks });

  return str;
}

// "### T1.1 — Judul" atau "### TASK-01 — Judul" + bullet di bawahnya menjadi
// satu task. Prioritas tidak ditebak; spec tetap memuat teks aslinya.
function parseMarkdownTasks(text) {
  const headings = [...text.matchAll(/^#{2,4}\s+((?:TASK|T)[-\w.]*)\s*[—–:-]?\s*(.*)$/gm)];
  const tasks = [];
  // Modul diambil HANYA dari heading level 2 (##), karena heading task
  // ("### T1.1 — ...") juga berlevel 3 dan sempat tertangkap sebagai modul.
  const moduleOf = (before) => {
    const mods = [...before.matchAll(/^##\s+(?!\d*\.?\d*\s*[—–-])?(?:Modul\s*[:\d]*\s*)?([A-Z][^\n#]{2,40})$/gm)];
    return mods.length ? mods[mods.length - 1][1].trim() : 'Umum';
  };
  for (let i = 0; i < headings.length; i++) {
    const h = headings[i];
    const bodyStart = h.index + h[0].length;
    const bodyEnd = i + 1 < headings.length ? headings[i + 1].index : text.length;
    const body = text.slice(bodyStart, bodyEnd).trim();
    const bullets = [...body.matchAll(/^[-*]\s+(.+)$/gm)].map(m => m[1].trim());
    const id = h[1].toUpperCase().replace(/\s+/g, '');
    if (!/^(?:TASK|T)[-\w.]*\d/.test(id)) continue;
    tasks.push({
      id,
      title: h[2].trim() || id,
      module: moduleOf(text.slice(0, h.index)),
      priority: /HIGH/i.test(body) ? 'HIGH' : /LOW/i.test(body) ? 'LOW' : 'MEDIUM',
      spec: [h[2].trim(), ...bullets].filter(Boolean).join('\n')
    });
  }
  return tasks;
}

// Buang pecahan huruf asing (CJK/Cyrillic/Arab) yang menyelip di kalimat
// Indonesia. Spasi dirapikan supaya kalimat tetap enak dibaca.
export function stripForeignFragments(text) {
  return String(text)
    .replace(/[\u0400-\u04FF\u0600-\u06FF\u3040-\u30FF\u4E00-\u9FFF]+/g, '')
    // Tanda baca yang tertinggal setelah pecahan dibuang double.
    .replace(/[ \t]{2,}/g, ' ')
    // "surat,/kategori" -> pecahan dibuang menyisakan koma menggantung.
    .replace(/,\s*\/\s*/g, ', ')
    .replace(/\s+([,.;:)])/g, '$1')
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function normalizePRDFields(prd) {
  if (!prd || typeof prd !== 'object') return prd;
  const out = { ...prd };
  // Model gratis kadang menyelipkan pecahan huruf asing di tengah kalimat
  // ("(jenis surat,死的/kategori, tujuan)"). Itu cacat token, bukan cacat isi,
  // jadi dibersihkan di tempat — jauh lebih baik daripada membuang PRD utuh
  // yang isinya sudah benar hanya karena dua kata bocor.
  // ponytail: hanya buang pecahan yang tidak menempel pada kata Indonesia.
  if (typeof out.summary === 'string') out.summary = stripForeignFragments(out.summary);
  if (typeof out.architectureOverview === 'string') out.architectureOverview = stripForeignFragments(out.architectureOverview);
  // Model kadang mengganti nama kunci (name/title alih-alih module, id task
  // alih-alih spec). Bentuknya ekuivalen, jadi diterima — tapi nilainya tetap
  // harus lolos validator. Terukur: 8 fitur ditolak hanya karena memakai
  // "name" untuk modul dan "id" untuk identitas.
  if (Array.isArray(out.features)) {
    out.features = out.features.map((f) => {
      if (!f || typeof f !== 'object') return f;
      const module = f.module || f.name || f.title || f.modul;
      // Model juga menyingkat nama kunci: "acceptance" alih-alih
      // "acceptanceCriteria". Tanpa ini fitur yang isinya lengkap dianggap
      // tidak punya kriteria dan PRD ditolak.
      const criteria = f.acceptanceCriteria || f.acceptance || f.criteria;
      const next = module ? { ...f, module } : { ...f };
      if (!next.acceptanceCriteria && Array.isArray(criteria)) next.acceptanceCriteria = criteria;
      return next;
    });
  }
  if (Array.isArray(out.tasks)) {
    out.tasks = out.tasks.map((t, i) => {
      if (!t || typeof t !== 'object') return t;
      const module = t.module || t.name || t.modul;
      const next = module && !t.module ? { ...t, module } : { ...t };
      // Task butuh field "spec"; model kadang memakai "description".
      if (!String(next.spec || '').trim() && typeof next.description === 'string') next.spec = next.description;
      // ID kanonik TASK-01. Model kadang menulis "T-1", "T1", atau angka saja;
      // bentuknya ekuivalen, dan validator menuntut pola TASK-\d{2,}.
      const raw = String(next.id || '').trim();
      const digits = raw.match(/(\d+)\s*$/)?.[1];
      if (digits) next.id = `TASK-${digits.padStart(2, '0')}`;
      else if (!raw) next.id = `TASK-${String(i + 1).padStart(2, '0')}`;
      return next;
    });
  }
  return out;
}

// Ringkasan syarat modul Design System untuk prompt tahap rincian. Kontrak
// penuh (getDesignGuidance) terlalu panjang untuk tahap ini dan pernah memicu
// keluaran terpotong; yang dibutuhkan hanya syarat yang diperiksa validator.
export function getDesignSystemRequirement() {
  return `
SYARAT MODUL "Design System" (diperiksa otomatis):
Untuk produk yang punya antarmuka, features WAJIB memuat satu modul bernama persis "Design System". Modul itu harus berisi:
- token warna bernama dengan nilai nyata (minimal 3 nilai HEX/OKLCH: latar, permukaan, aksen),
- token tipografi: sebut keluarga font, ukuran, bobot, dan line-height secara eksplisit,
- spacing dan radius konkret dalam px/rem,
- strategi border atau bayangan,
- bukti aksesibilitas: kontras (minimal 4.5:1), focus ring, label programatik, alt text,
- state UI: sebut state memuat/skeleton, kosong, dan gagal beserta tampilannya.
Untuk CLI/bot/library tanpa antarmuka, modul ini DILARANG ada.`;
}

const CLARIFY_SYSTEM_PROMPT = `
Kamu adalah Product Manager ramah yang ahli menyederhanakan konsep teknis untuk pengguna awam/pemula (Beginner-Friendly).
Tugasmu: Menganalisis ide aplikasi dari pengguna dan membuat 4-5 pertanyaan klarifikasi tentang alur kerja produk, skala pemakaian, dan fitur penting yang relevan dengan domain aplikasi tersebut.

PANDUAN GAYA BAHASA (BEGINNER-FRIENDLY):
1. Gunakan Bahasa Indonesia yang santai, jelas, dan manusiawi. HINDARI jargon teknis rumit yang bikin pusing (seperti "CCXT unified API", "HMAC SHA512", "IndexedDB", "Idempotency", "horizontal scaling", dll).
2. Jika ada istilah teknis yang harus disebut, jelaskan fungsinya secara sederhana dalam tanda kurung.
   - Contoh jelek: "Apakah butuh IndexedDB offline persistence?"
   - Contoh bagus: "Apakah aplikasi kasir harus tetap bisa dipakai transaksi saat internet mati/offline?"
3. Pilihan jawaban (options) harus mendeskripsikan keuntungan/efek nyata yang mudah dipahami orang awam.
   - Contoh opsi bagus: "Otomatis kirim ke WhatsApp pembeli (praktis tanpa kertas)", "Cetak kertas struk fisik via printer kasir", "Keduanya bisa dipilih".
4. Opsi pertama selalu berikan tanda "(Rekomendasi Terbaik/Paling Praktis)".
5. DILARANG bertanya soal merek teknologi/framework (JANGAN tanya "mau pakai Next.js atau Laravel?"). Tanyakan KEBUTUHANNYA, biar arsitek yang memilih teknologi.

SALAH SATU PERTANYAAN WAJIB soal SKALA PEMAKAIAN (ukuran & jumlah data), karena ini menentukan arsitektur:
- Tanyakan perkiraan jumlah pengguna aktif dan volume data/transaksi per bulan dengan pilihan yang membedakan skala, contoh opsi: "Kecil: 1-20 orang, cocok untuk toko/kelas/keluarga", "Sedang: 20-500 orang, satu usaha yang sedang tumbuh", "Besar: 500-10.000+ orang, banyak cabang/lokasi", "Sangat besar: 10.000+ orang, butuh arsitektur yang bisa dibagi ke banyak server".
- Sesuaikan pilihan dengan jenis aplikasi (mis. bot/alat pribadi cukup "1 orang/pribadi" dan "dipakai beberapa teman").

Buat total 4-5 pertanyaan: 1 soal skala, sisanya soal alur kerja & fitur paling menentukan.

Format output WAJIB berupa JSON murni tanpa markdown wrapper:
{
  "projectSuggestion": "Nama aplikasi yang mudah diingat & relevan",
  "briefAnalysis": "1 kalimat penjelasan sederhana tentang fokus utama aplikasi ini",
  "questions": [
    {
      "id": "q1",
      "question": "Pertanyaan dalam bahasa sederhana yang mudah dimengerti...",
      "options": [
        "Pilihan A (Rekomendasi - alasan simpel)",
        "Pilihan B",
        "Pilihan C"
      ]
    }
  ]
}
`;

function selectedModel(routerCfg, requested) {
  const chosen = requested || routerCfg?.defaultModel;
  if (!chosen) throw new Error('Belum ada model yang dipilih dan config default tidak tersedia.');
  return chosen;
}

export async function generateClarifications(userIdea, name, model) {
  const routerCfg = getRouterConfig();
  const chosenModel = selectedModel(routerCfg, model);
  let lastRouterError = '';

  if (routerCfg && routerCfg.apiKey) {
    try {
      console.log(`[AI-CLARIFY] Requesting to model: ${chosenModel}...`);
      const result = await callRouter(
        routerCfg, chosenModel, CLARIFY_SYSTEM_PROMPT,
        `Nama Project: ${name || 'Belum ada'}\nIde: ${userIdea}`
      );
      if (!result || !Array.isArray(result.questions) || result.questions.length < 3 || result.questions.length > 6 ||
          result.questions.some(q => !q || typeof q.question !== 'string' || !q.question.trim() || !Array.isArray(q.options) || q.options.length < 2 || q.options.some(o => typeof o !== 'string' || !o.trim()))) {
        throw new Error('Format pertanyaan klarifikasi tidak valid');
      }
      return result;
    } catch (err) {
      lastRouterError = err.message;
      console.error('[AI-CLARIFY] Error:', err.message);
    }
  }

  // Router gagal (kuota habis, model tidak tersedia, dsb). Jangan mengembalikan
  // 3 pertanyaan template yang sama untuk semua ide: pengguna akan menyangka itu
  // hasil analisis AI, padahal generik dan tidak menyentuh skala aplikasinya.
  throw new Error(routerErrorMessage(lastRouterError, 'menyusun pertanyaan klarifikasi'));
}

const DEEP_PRD_SYSTEM_PROMPT = `
Kamu adalah Principal Software Architect & Head of Product yang sudah membangun produk nyata sampai produksi.
Tugasmu: Menerima ide produk dan hasil tanya-jawab klarifikasi, lalu menyusun Product Requirements Document (PRD) yang SANGAT DETAIL, komprehensif, dan siap dieksekusi langkah demi langkah oleh AI Coding Agent (Cursor, the assistant, Cline, Codex, dll).

GAYA BAHASA:
- Jelaskan dengan bahasa Indonesia yang jelas dan mudah dipahami, tetapi tegas dan spesifik. Hindari jargon yang tidak dijelaskan.
- Kalau terpaksa memakai istilah teknis, tulis fungsinya dalam tanda kurung dengan bahasa awam.
- Dilarang menulis kalimat kosong/marketing tanpa isi ("solusi modern", "aplikasi yang powerful", "seamless experience"). Setiap kalimat harus membawa informasi teknis nyata.

ATURAN PALING PENTING (DILARANG DILANGGAR):

1. PILIH TEKNOLOGI BERDASARKAN KEBUTUHAN, BUKAN KEBIASAAN.
   Sebelum menulis techStack, tentukan dulu sifat aplikasinya: apakah butuh realtime, apakah jalan di HP/desktop/web, apakah butuh offline, apakah datanya relasional atau dokumen, berapa perkiraan jumlah pengguna dan data.
   DILARANG menjawab "Next.js + Prisma + PostgreSQL + NextAuth" hanya karena itu stack yang biasa kamu pakai. Kalau kebutuhan memang cocok dengan itu, baru boleh dipakai, dan wajib ada alasan yang menyebut kebutuhan spesifik aplikasi ini.
   Tulis alasan pemilihan DAN teknologi yang KAMU TOLAK beserta alasannya di AWAL "architectureOverview" (lihat aturan penulisan architectureOverview di bawah). Minimal satu keputusan teknologi harus dibahas alternatifnya secara eksplisit (dipakai vs ditolak).

2. SETIAP FITUR YANG KAMU TULIS WAJIB SELESAI SAMPAI JADI (NO DANGLING FEATURE).
   Fitur belum dianggap lengkap kalau masih ada salah satu dari ini yang belum punya task implementasi:
   - integrasi pihak ketiga (payment gateway, WhatsApp, Telegram, email, OCR, peta, storage/file upload, dsb)
   - penerimaan webhook / callback dari layanan luar
   - ekspor / impor file (Excel, CSV, PDF)
   - notifikasi (push, WhatsApp, email, realtime)
   - autentikasi, hak akses per role, dan proteksi route
   - unggah berkas & penyimpanan media
   - pencetakan (struk, invoice, label)
   - penanganan pembayaran / uang / refund
   - halaman/komponen UI yang dipakai user untuk fitur itu
   Untuk SETIAP integrasi atau API eksternal: kamu WAJIB menulis SATU task khusus untuk mengimplementasikannya, task khusus untuk menerima webhook-nya kalau ada, dan task khusus untuk menguji alurnya dari ujung ke ujung (termasuk simulasi sandbox/notifikasi palsu).
   Sebelum menutup JSON, cek ulang: fitur -> endpoint -> task harus saling menutup. Tidak boleh ada fitur atau endpoint yang tidak punya task.

3. SATU TASK = SATU PEKERJAAN YANG BISA DIBUKTIKAN SELESAI.
   Setiap task wajib punya: file path yang dibuat/diubah, dependensi yang di-install, logic yang harus ada, penanganan error, dan CARA MEMBUKTIKANNYA (perintah curl / perintah test / langkah manual yang hasilnya bisa dilihat).
   Task tidak boleh hanya berisi "buat API CRUD" atau "buat halaman UI" tanpa rincian. Kalau task terlalu besar, pecah.

4. PEMBAGIAN PEKERJAAN YANG WAJAR (MINIMAL 8 TASK, MAKSIMAL 15):
   - 1 task pondasi: setup project, skema database, konfigurasi environment, koneksi.
   - 1 task autentikasi + hak akses jika aplikasinya punya user lebih dari satu.
   - 1 task backend untuk setiap modul fitur (endpoint + validasi input + aturan bisnis).
   - 1 task UI untuk setiap layar utama yang user pakai.
   - 1 task khusus untuk SETIAP integrasi eksternal + webhook-nya.
   - 1 task pengujian alur utama dari ujung ke ujung (end-to-end) sebelum task terakhir.
   - 1 task terakhir: pengerasan produksi (validasi environment, penanganan error, kesiapan deploy).
   Urutkan task sesuai urutan pengerjaan yang benar (pondasi dulu, UI belakangan, integrasi sesuai kebutuhan).

5. JANGAN MENGARANG. Kalau informasi kurang, pakai asumsi yang paling wajar dan TULIS asumsinya secara eksplisit di dalam paragraf terakhir "summary" (lihat aturan penulisan summary di bawah). Dilarang menulis fitur, tabel, atau angka yang tidak bisa diturunkan dari ide + klarifikasi + asumsi tersebut.

6. KONSISTENSI NAMA: nama tabel, field, endpoint, nama modul, dan nama task harus saling merujuk dengan sebutan yang sama persis di seluruh dokumen.

7. SESUAIKAN ARSITEKTUR DENGAN SKALA (WAJIB DIBACA DARI JAWABAN KLARIFIKASI).
   Tentukan dulu skala aplikasi dari jawaban pengguna (jumlah pengguna + volume data/transaksi), lalu pilih pendekatan yang WAJAR untuk skala itu, dan tulis pilihan skala ini di awal paragraf terakhir "summary" dengan format: "Skala: <kecil/sedang/besar/sangat besar> - <alasan singkat>."
   - KECIL (1-20 pengguna): boleh yang paling sederhana. Monolith, satu database, satu server, tanpa cache, tanpa queue. DILARANG menambah Redis, message queue, microservice, atau load balancer hanya supaya terlihat canggih.
   - SEDANG (20-500): boleh tambah index database yang tepat, pemisahan job latar belakang sederhana, dan backup terjadwal. Belum perlu microservice.
   - BESAR (500-10.000+): sebutkan strategi index, caching untuk data yang sering dibaca, pemisahan baca/tulis bila perlu, dan batas rate limit.
   - SANGAT BESAR (10.000+): sebutkan pemisahan layanan, replikasi/pembagian database, antrean pesan, dan rencana pemantauan.
   Larangan penting: DILARANG menambahkan teknologi kerumitan tinggi yang tidak diminta skala pengguna. Kelebihan teknologi untuk aplikasi kecil adalah cacat, bukan nilai tambah. Kalau ragu, pilih yang lebih sederhana dan sebutkan di asumsi.

8. DESIGN SYSTEM WAJIB (supaya tampilannya tidak generik/buatan AI).
   Bagian ini HANYA berlaku kalau aplikasinya punya antarmuka (web/desktop/mobile). Kalau aplikasinya tidak punya UI (mis. bot, pustaka, API saja), tulis "Tidak berlaku (tanpa antarmuka)" pada poin design dan lewati.
   Sisipkan SATU modul fitur tambahan berisi design system. WAJIB memilih SATU template dari daftar di bawah dan MENYALIN nilainya (jangan mengarang palet baru). Sebutkan template yang dipilih + alasannya di awal deskripsi modul.
   Isi modul design system WAJIB memuat:
   - Nama template yang dipilih + alasan singkat ("Reading this as: ...").
   - Palet warna: SALIN nilai HEX template (latar, permukaan, garis, teks utama, teks sekunder, aksen, warna status hijau/kuning/merah) untuk mode terang DAN gelap bila relevan.
   - Tipografi: nama font nyata dari template + skala ukuran konkret (px) + aturan bobot. Maksimal 2 keluarga font.
   - Spacing: skala kelipatan konkret dari template + radius sudut.
   - Kedalaman: strategi bayangan/garis dari template.
   - Komponen wajib: bentuk tombol utama/secondary, input, kartu, tabel, badge status, keadaan kosong (bentuk, ukuran, warna dari palet di atas).
   - Token CSS konkret (nama variabel + nilainya) supaya agen tidak menebak.
   - Aturan motion: duration, properti yang dianimasikan, dan prefers-reduced-motion.
   Modul design system ini WAJIB punya minimal satu task implementasi (buat berkas token/theme + komponen dasar), dan task tersebut disebut pada bagian tasks.

9. AKUNTABILITAS TASK TERHADAP MODUL (WAJIB).
   Setiap objek pada "tasks" WAJIB mengisi field "module" dengan nama modul yang PERSIS SAMA seperti pada "features". Ini diperiksa otomatis: kalau ada modul di "features" yang tidak punya satu pun task, atau ada task tanpa "module", PRD ditolak.

ATURAN PENULISAN BIDANG TEKS BESAR (WAJIB):
- "summary": 2-3 paragraf. Paragraf terakhir WAJIB diawali label "Asumsi:" dan menyebutkan asumsi serta hal yang belum pasti secara jujur. Kalau tidak ada asumsi, tulis "Asumsi: tidak ada, semua keputusan sudah jelas dari klarifikasi."
- "architectureOverview": paragraf pertama WAJIB diawali label "Keputusan teknologi:" dan menjelaskan alasan pemilihan stack untuk aplikasi INI, termasuk minimal satu teknologi yang ditolak beserta alasannya. Setelah itu baru jelaskan alur data, state management, autentikasi, penanganan berkas, integrasi eksternal, dan kesiapan deploy.
Jangan menambahkan bidang JSON di luar struktur yang ditentukan; semua alasan dan asumsi cukup ditulis di dalam summary dan architectureOverview seperti aturan di atas.

Kamu WAJIB mengembalikan output HANYA berupa JSON murni yang valid tanpa teks pembuka/penutup atau markdown wrappers.

Struktur JSON:
{
  "projectName": "Nama Resmi Aplikasi",
  "tagline": "Satu kalimat value proposition",
  "summary": "Latar belakang, problem statement, pengguna, dan solusi sistem (2-3 paragraf; asumsi, skala, dan batas lingkup ditulis natural)",
  "techStack": ["Teknologi lengkap dengan alasan singkat kenapa dipilih untuk aplikasi INI"],
  "architectureOverview": "Alasan pemilihan stack + minimal satu alternatif yang ditolak, lalu alur data, state management, autentikasi, penanganan berkas, integrasi, keamanan, deploy, backup, dan risiko yang relevan",
  "features": [
    {
      "module": "Nama Modul",
      "description": "Deskripsi fungsional lengkap",
      "userStories": ["Sebagai [role], saya ingin [tindakan] sehingga [manfaat]"],
      "acceptanceCriteria": ["Kriteria penerimaan spesifik yang bisa diuji, bukan kalimat umum"],
      "edgeCases": ["Kasus ekstrem / error yang harus ditangani"]
    }
  ],
  "databaseSchema": [
    {
      "table": "nama_tabel",
      "description": "Fungsi tabel",
      "fields": ["id TEXT PRIMARY KEY", "created_at TIMESTAMP", "..."]
    }
  ],
  "apiEndpoints": [
    {
      "method": "GET | POST | PATCH | DELETE",
      "path": "/api/v1/...",
      "description": "Fungsi endpoint + siapa yang boleh mengaksesnya",
      "payload": "{ ... }",
      "response": "{ ... }"
    }
  ],
  "tasks": [
    {
      "id": "TASK-01",
      "title": "Judul task spesifik & actionable",
      "module": "Nama Modul",
      "priority": "HIGH | MEDIUM | LOW",
      "spec": "Spesifikasi implementasi sangat detail untuk AI Coding Agent: file path yang dibuat/diedit, dependensi yang diinstall, logic yang wajib ada (termasuk penanganan error), dan cara membuktikan task ini berhasil (perintah curl/test atau langkah manual)."
    }
  ]
}

Sesuaikan seluruh PRD dengan keputusan yang dipilih pengguna di klarifikasi. Kalau jawaban pengguna bertentangan dengan kebiasaan teknologi biasanya, IKUTI pengguna.
${designTemplatePromptBlock()}
${getDesignGuidance()}
`;

// Tahap 1 dipecah menjadi tiga panggilan (identitas, stack+arsitektur, rincian)
// karena model gratis berhenti di tengah JSON saat diminta semua field sekali
// (terukur: 200 OK tapi hanya sebagian kunci yang kembali). Masing-masing
// panggilan kecil, jadi model menyelesaikan semuanya.
// ponytail: gabung lagi bila model yang dipakai sudah mengembalikan seluruh
// kunci pada satu panggilan gabungan di bawah 5000 completion token.
const PRD_IDENTITY_SYSTEM_PROMPT = `
Kamu Principal Software Architect & Head of Product. Tulis identitas produk dalam Bahasa Indonesia yang tegas, tanpa marketing. Hindari jargon tanpa penjelasan fungsi dalam kurung.

Keluarkan HANYA JSON dengan tepat tiga kunci:
{
  "projectName": "Nama Resmi Aplikasi",
  "tagline": "Satu kalimat value proposition",
  "summary": "Latar belakang, problem, pengguna, solusi (2-3 paragraf)"
}

Isi summary dengan: tujuan, pengguna utama, metrik terukur (atau usulan), asumsi, ukuran/skala sebagai kalimat natural ("tiga pengguna", bukan hanya label), dan hal yang sengaja di luar lingkup.
WAJIB mengakhiri summary dengan kalimat yang diawali PERSIS frasa "Di luar lingkup:" lalu daftar hal yang sengaja tidak dikerjakan. Contoh: "Di luar lingkup: unggah berkas, pembayaran, dan notifikasi realtime." Ini diperiksa otomatis; tanpa frasa itu PRD ditolak.
Deteksi CLI/bot/API/library tanpa UI dari brief dan nyatakan itu. Jangan mengarang metrik, dependency, atau integrasi luar kebutuhan.

Jangan menulis field lain. Jangan menulis catatan, rencana, atau markdown. Langsung JSON dan tutup dengan }.
`;

// Tahap 1b: stack + arsitektur. Dipecah dari 1c karena model gratis berhenti
// setelah ~2 kunci saat diminta 5 kunci sekaligus (terukur: 200 OK tapi hanya
// techStack + architectureOverview, features/db/api tidak pernah datang).
const PRD_CORE_SYSTEM_PROMPT = `
Kamu Principal Software Architect & Lead Engineer. Bahasa Indonesia tegas, tanpa marketing.

PILIH TEKNOLOGI dari kebutuhan, bukan dari kebiasaan. Deteksi CLI/bot/API/library tanpa UI dari brief; jangan menambahkan frontend, login, atau Design System untuk kasus itu. Pilih stack berdasarkan realtime/offline, perangkat, data, konkurensi, dan skala. Skala dari klarifikasi harus terlihat sebagai ukuran natural. Kelebihan teknologi untuk aplikasi kecil adalah cacat.

Keluarkan HANYA JSON dengan tepat dua kunci:
{
  "techStack": ["Teknologi + alasan singkat untuk aplikasi INI"],
  "architectureOverview": "Alasan pilihan stack dan minimal satu alternatif yang ditolak, lalu alur data, autentikasi dan otorisasi server-side, penanganan berkas, keamanan (secret hanya di environment server-side, HTTPS untuk deployment web), backup/restore, serta risiko dan tradeoff yang relevan untuk aplikasi ini"
}

architectureOverview ditulis 2-4 paragraf. Jangan tulis field lain. Jangan menulis catatan atau rencana. Langsung JSON dan tutup dengan }.
`;

// Tahap 1c: fitur saja. Terpecah dari skema DB/API karena gabungan ketiganya
// kadang butuh >7000 completion token dan terpotong, sementara plafon di atas
// 8000 membuat router menjawab 502 (terukur: features saja ~2400 token,
// db+api saja ~4300 token, gabungan 5400-7000+ token).
const PRD_FEATURES_SYSTEM_PROMPT = `
Kamu Principal Software Architect yang menulis spesifikasi fitur. Bahasa Indonesia tegas, tanpa marketing.

Setiap fitur punya minimal 2 acceptanceCriteria yang bisa diuji, termasuk alur gagal atau edge case. Nama modul harus konsisten dengan stack yang ditetapkan. Jangan menambah fitur di luar keputusan pengguna.

Keluarkan HANYA JSON dengan tepat satu kunci:
{
  "features": [
    {
      "module": "Nama Modul",
      "description": "Deskripsi fungsional lengkap",
      "userStories": ["Sebagai [role], saya ingin [tindakan] sehingga [manfaat]"],
      "acceptanceCriteria": ["Kriteria spesifik yang bisa diuji, minimal 2 per modul termasuk alur gagal atau edge case"],
      "edgeCases": ["Kasus ekstrem / error"]
    }
  ]
}

3-6 modul fitur. Jangan menulis kunci lain. Jangan berhenti sebelum JSON ditutup. Keluaran terpotong = gagal.
`;

// Tahap 1d: skema data + kontrak API saja.
const PRD_DB_API_SYSTEM_PROMPT = `
Kamu Principal Software Architect yang menulis skema data dan kontrak API. Bahasa Indonesia tegas.

Setiap tabel memiliki fields konkret (tipe, constraint, relasi). Setiap endpoint menyebut input, output, autentikasi/otorisasi dan status error pada description. Nama tabel dan endpoint harus mendukung daftar modul fitur yang diberikan.

Keluarkan HANYA JSON dengan tepat dua kunci:
{
  "databaseSchema": [{ "table": "nama_tabel", "description": "Fungsi tabel", "fields": ["id TEXT PRIMARY KEY", "..."] }],
  "apiEndpoints": [{ "method": "GET | POST | PATCH | DELETE", "path": "/api/v1/...", "description": "Fungsi + siapa boleh akses + status error", "payload": "{ ... }", "response": "{ ... }" }]
}

Untuk CLI/bot statis/library yang memang tanpa data atau API, tulis "Tidak berlaku (tanpa antarmuka)" dan biarkan array kosong. Jangan menulis kunci lain. Jangan berhenti sebelum JSON ditutup. Keluaran terpotong = gagal.
`;
// Tahap 2 dari generate 2-tahap: terima skeleton tahap 1, keluarkan HANYA tasks.
const PRD_TASKS_SYSTEM_PROMPT = `
Kamu adalah Lead Engineer. Tugasmu: dari kerangka PRD (JSON) + ide + klarifikasi di bawah, susun daftar task eksekusi untuk AI Coding Agent. Keluarkan HANYA {"tasks": [...]}.

ATURAN:
1. COVERAGE EKSPLISIT: setiap modul features wajib punya task dengan field module persis sama. Setiap integrasi, webhook/callback, ekspor/impor, notifikasi, auth/RBAC, upload, cetak, pembayaran/refund, dan UI yang benar-benar ada wajib punya task implementasi; bila ada webhook, buat task penerimaan terpisah; integrasi juga wajib punya verifikasi sandbox/alur sukses dan gagal. Bot/CLI/API/library tanpa UI tidak boleh mendapat task frontend, login, atau design system.
2. SATU TASK = SATU PEKERJAAN TERBUKTI. Task boleh digabung bila terkait kuat, tetapi setiap task harus punya file path konkret, logic + error handling, dan bukti. Jangan memakai task generik seperti "buat backend" atau "testing".
3. UKURAN SESUAI SKALA. Jangan memaksa 8-15 task: gunakan jumlah secukupnya. Project kecil boleh 3-5 task; project besar dipecah per endpoint, layar, integrasi, atau lapisan. Tetap sertakan pondasi, tiap coverage wajib, E2E alur utama, dan production readiness bila relevan.
4. module tiap task WAJIB nama modul dari features. Tabel dan endpoint harus muncul persis dalam spec task penanggung jawab.
5. spec WAJIB memakai TEMPLATE berikut PERSIS (label dalam huruf tebal, urutan sama). Salin tujuh baris ini; jangan meringkas atau menghilangkan label:
   Tujuan: <apa yang dicapai>
   File: <path konkret, mis. src/db.js>
   Dependensi: <TASK-xx atau "tidak ada">
   Implementasi: <langkah logis>
   Error/edge case: <penanganan gagal>
   Kriteria selesai: <cara tahu sudah selesai>
   Verifikasi: <perintah atau langkah uji>
   ID unik TASK-01, TASK-02, dst (huruf besar, dua digit). Dependensi hanya boleh menunjuk task sebelumnya.
6. Salin keputusan keamanan, a11y, desain, dan out-of-scope dari kerangka ke langkah kerja serta bukti. Untuk UI buktikan keyboard/focus/reader, kontras, failure/empty state, responsif, dan reduced-motion. Jangan menambah motion, dependency, atau fitur yang tidak diperlukan.

Keluarkan HANYA JSON murni tanpa markdown:
{
  "tasks": [
    {
      "id": "TASK-01",
      "title": "Judul task spesifik & actionable",
      "module": "Nama Modul (persis dari daftar)",
      "priority": "HIGH | MEDIUM | LOW",
      "spec": "File path, dependensi, logic + error handling, cara membuktikan selesai."
    }
  ]
}
`;

function hasUIRequirement(prd) {
  const core = [prd.summary, prd.architectureOverview, ...(Array.isArray(prd.techStack) ? prd.techStack : [])].join(' ');
  // Penolakan UI hanya berlaku untuk bentuk produknya, bukan untuk framework.
  // "tidak ada frontend framework" pada aplikasi web TETAP butuh antarmuka.
  const negative = /(?:tanpa|tidak ada|tidak memakai|non)\s+(?:UI|antarmuka|frontend|web|browser)|(?:without|no)\s+(?:UI|interface|frontend|web)/gi;
  for (const match of core.matchAll(negative)) {
    const after = core.slice(match.index + match[0].length, match.index + match[0].length + 24);
    if (/^\s*(?:framework|javascript|js\b|library|build|bundler|toolchain|template|component)/i.test(after)) continue;
    // "tanpa UI" sering dipakai sebagai LABEL untuk keadaan khusus
    // ("mode cetak (tanpa UI): tabel untuk desktop"), bukan pernyataan bahwa
    // produknya tidak punya antarmuka. Terukur: kalimat seperti itu membuat
    // aplikasi web ditolak sebagai produk non-UI, lalu Design System dibuang.
    // "..., bukan CLI, bot, atau API tanpa UI" adalah KONTRAS: kalimat itu
    // justru menegaskan produknya ber-antarmuka. Terukur: satu kalimat seperti
    // itu membuat aplikasi web ditolak sebagai produk non-UI.
    const before = core.slice(Math.max(0, match.index - 70), match.index);
    if (/\b(?:bukan|bukanlah|not)\b[^.]{0,70}$/i.test(before)) continue;
    if (/\(\s*$|:\s*$|,\s*$|(?:kecuali|mis\.|misalnya|contoh|khusus|hanya untuk|saat|ketika|mode|versi)\b[^.]{0,20}$/i.test(before)) continue;
    return false;
  }
  return /antarmuka|\bUI\b|frontend|web app|website|browser|desktop app|sistem desain|design system|Next\.js|React Native|\breact\b|\bvue\b|\bsvelte\b|tailwind/i.test(core);
}

// Model gratis kadang mengeluarkan potongan kalimat dalam huruf lain (Cyrillic,
// CJK, Arab) atau mengulang token. Teks seperti itu tidak layak masuk PRD, jadi
// harus diperbaiki, bukan disimpan diam-diam.
function corruptedText(text) {
  const value = String(text || '');
  if (/[\u0400-\u04FF\u4E00-\u9FFF\u0600-\u06FF\u3040-\u30FF]/.test(value)) return true;
  // Korupsi nyata: token pendek diulang TANPA pemisah ("UEUEUEUEUEUE").
  if (/(\w{2,4})\1{3,}/.test(value)) return true;
  // Kata yang sama dipisah spasi/koma ("petugas, petugas", "backup 'backup")
  // adalah bahasa Indonesia biasa, bukan korupsi. Hanya rentetan panjang
  // yang mencurigakan: kata sama muncul 4+ kali berurutan.
  return /\b(\w{5,})\b(?:[^\w]{0,3}\1\b){3,}/i.test(value);
}

function hasScaleEvidence(prd) {
  const text = [prd.summary, prd.architectureOverview].join(' ');
  return /\b(?:kecil|sedang|besar|sangat besar|small|medium|large)\b/i.test(text) ||
    /(?:\d+|[satu dua tiga empat lima enam tujuh delapan sembilan sepuluh]+)\s*(?:pengguna|user|transaksi|permintaan|request|surat|record|data)/i.test(text);
}

function hasOutOfScopeEvidence(prd) {
  const text = [prd.summary, prd.architectureOverview].join(' ');
  return /di luar (?:lingkup|aplikasi|scope)|tidak termasuk|tidak dikecualikan|bukan bagian|tanpa fitur|beyond scope|out[ -]of[ -]scope|excluded|exclude|does not include|tidak mencakup|\b(?:tidak|bukan)\b[^.]{0,80}\b(?:dalam|ke)\s+lingkup/i.test(text);
}

function hasSecurityEvidence(prd) {
  const text = [prd.summary, prd.architectureOverview, ...(Array.isArray(prd.techStack) ? prd.techStack : [])].join(' ');
  return /validasi|validation|sanitize|otorisasi|authorization|auth|rbac|secret|rahasia|credential|https|tls|rate limit|input|jaringan|server.side/i.test(text);
}

function hasFilePath(spec) {
  return /\b(?:file|path)\s*:\s*[^\n]*(?:^|[\s`])[\w.-]+(?:\/[\w.-]+)+\.(?:js|ts|tsx|jsx|py|go|rs|java|kt|sql|css|html|json|yaml|yml|md|sh)\b|(?:^|[\s`])[\w.-]+(?:\/[\w.-]+)+\.(?:js|ts|tsx|jsx|py|go|rs|java|kt|sql|css|html|json|yaml|yml|md|sh)\b/i.test(spec);
}

function hasDependencyValue(spec) {
  const line = spec.match(/(?:Dependensi|Prasyarat|dependsOn)\s*:\s*([^\n]*)/i)?.[1] || '';
  return /\bTASK-\d+\b/i.test(line) || /(?:tidak ada|none|nol|tanpa dependensi)/i.test(line);
}

function hasDoneEvidence(spec) {
  return /kriteria\s+selesai|definisi\s+selesai|definition\s+of\s+done|acceptance\s+criteria|syarat\s+selesai/i.test(spec);
}

function hasSemanticFailure(text) {
  return /gagal|error|invalid|tidak valid|kosong|null|unknown|tidak dikenal|ditolak|terhenti|timeout|limit|penuh|duplikat|tidak sah|terlarang|edge|batas|fallback|rollback|recover|pulih|overflow|terpotong|terhalang|tidak dapat dikembalikan/i.test(text)
    // Kode status error juga bukti alur gagal ("Petugas ... mendapat 403").
    || /\b(?:4\d{2}|5\d{2})\b/.test(text)
    // Pola negatif: "tidak bisa dipakai ulang", "tidak boleh diakses".
    || /\btidak\s+(?:bisa|dapat|boleh|akan|pernah|berhasil)\b/i.test(text);
}
function taskDependencies(spec) {
  const line = spec.match(/(?:Dependensi|Prasyarat|dependsOn)\s*:\s*([^\n]+)/i)?.[1] || '';
  return [...line.matchAll(/\bTASK-\d+\b/gi)].map(match => match[0].toUpperCase());
}

function requiredFeatureCapabilities(feature) {
  const text = `${feature.module || ''} ${feature.description || ''} ${(feature.acceptanceCriteria || []).join(' ')}`.toLowerCase();
  const rules = [
    [/webhook|callback/, /webhook|callback/],
    [/payment|bayar|qris|midtrans|xendit|stripe|refund|pembayaran/, /payment|bayar|qris|midtrans|xendit|stripe|refund|pembayaran/],
    [/upload|unggah|storage|berkas|file|gambar|media/, /upload|unggah|storage|berkas|file|gambar|media/],
    [/ekspor|export|impor|import|cetak|print/, /ekspor|export|impor|import|cetak|print/],
    [/notifikasi|notification|push|whatsapp|telegram|email|sms/, /notifikasi|notification|push|whatsapp|telegram|email|sms/],
    [/rbac|role|hak akses|multi user|multi-user/, /rbac|role|hak akses|multi user|multi-user/]
  ];
  return rules.filter(([featurePattern]) => featurePattern.test(text));
}

// Validator: menolak PRD yang tidak lengkap. Pemeriksaan memakai makna dan
// relasi antar-field, bukan label prosa tertentu, agar variasi ejaan model
// tidak memicu penolakan palsu.
export function validatePRD(prd, stage = 'full') {
  const problems = [];
  const skeletonStage = stage === 'skeleton';
  if (!prd || typeof prd !== 'object') return ['output bukan objek JSON'];

  const features = Array.isArray(prd.features) ? prd.features : [];
  const tasks = skeletonStage ? [] : (Array.isArray(prd.tasks) ? prd.tasks : []);
  const techStack = Array.isArray(prd.techStack) ? prd.techStack : [];
  const summary = String(prd.summary || '').trim();
  const architecture = String(prd.architectureOverview || '').trim();
  const name = String(prd.projectName || prd.name || '').trim();

  if (!techStack.length || techStack.some(item => typeof item !== 'string' || !item.trim())) problems.push('techStack kosong atau tidak valid');
  if (!name) problems.push('nama proyek kosong');
  if (!features.length) problems.push('tidak ada modul fitur');
  if (summary.length < 80) problems.push('summary kosong/terlalu pendek');
  if (architecture.length < 80) problems.push('architectureOverview kosong/terlalu pendek');
  if (corruptedText(summary) || corruptedText(architecture)) problems.push('teks terputus atau rusak (huruf asing/huruf berulang) di summary atau architectureOverview');
  if (!hasScaleEvidence(prd)) problems.push('summary/architecture tidak menjelaskan skala atau volume');
  if (!hasOutOfScopeEvidence(prd)) problems.push('ringkasan tidak menjelaskan batas lingkup');
  if (!hasSecurityEvidence(prd)) problems.push('arsitektur tidak memuat kontrol keamanan atau validasi input yang relevan');
  if (architecture && !/(?:karena|alasan|reason|reasoning|memilih|dipilih|menggunakan|digunakan|pakai|choose|chosen|select|selected|because)\b/i.test(architecture)) problems.push('architectureOverview tidak menjelaskan alasan pilihan teknologi');
  if (architecture && !/(?:ditolak|tidak dipilih|dihindari|bukan|alternatif|rejected|avoid|avoided|instead)\b/i.test(architecture)) problems.push('architectureOverview tidak menjelaskan alternatif yang ditolak');

  if (features.some(feature => !feature || typeof feature !== 'object')) return [...problems, 'task/fitur harus berupa objek, bukan null'];
  const featureModules = [];
  for (const feature of features) {
    if (typeof feature.module !== 'string' || !feature.module.trim() || !String(feature.description || '').trim() || !Array.isArray(feature.acceptanceCriteria) || feature.acceptanceCriteria.length < 2 || feature.acceptanceCriteria.some(criterion => typeof criterion !== 'string' || !criterion.trim())) {
      problems.push('fitur harus berisi module, description dan minimal 2 acceptanceCriteria');
      continue;
    }
    if (!hasSemanticFailure(feature.acceptanceCriteria.join(' ') + ' ' + String(feature.edgeCases || ''))) {
      problems.push(`fitur "${feature.module}" perlu acceptanceCriteria atau edgeCases untuk alur gagal`);
    }
    if (featureModules.some(module => module.toLowerCase() === feature.module.trim().toLowerCase())) problems.push(`modul fitur duplikat: ${feature.module}`);
    else featureModules.push(feature.module.trim());
  }

  if (!Array.isArray(prd.databaseSchema) || !Array.isArray(prd.apiEndpoints)) {
    problems.push('databaseSchema/apiEndpoints harus array (boleh kosong jika tidak berlaku)');
    return problems;
  }
  for (const table of prd.databaseSchema) {
    if (!table || typeof table.table !== 'string' || !table.table.trim() || !Array.isArray(table.fields) || !table.fields.length || table.fields.some(field => typeof field !== 'string' || !field.trim())) {
      problems.push('tabel harus memiliki nama dan fields konkret');
    }
  }
  for (const endpoint of prd.apiEndpoints) {
    if (!endpoint || !/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(endpoint.method || '') || !String(endpoint.path || '').startsWith('/') || !String(endpoint.description || '').trim()) {
      problems.push('endpoint harus memiliki method, path dan kontrak description');
    }
  }

  const hasUI = hasUIRequirement(prd);
  const designFeature = features.find(feature => /design system|desain antarmuka|sistem desain|design token/i.test(feature.module || ''));
  if (hasUI && !designFeature) problems.push('tidak ada modul Design System padahal aplikasi punya antarmuka');
  if (!hasUI && designFeature) problems.push('Design System tidak boleh ditambahkan pada produk tanpa antarmuka');
  if (hasUI && designFeature) {
    const text = JSON.stringify(designFeature);
    const colorCount = (text.match(/#[0-9a-f]{3,8}\b|oklch\s*\(/gi) || []).length;
    if (colorCount < 3) problems.push('Design System belum memberi token warna konkret');
    if (!/font|tipografi|typography|line.height|ukuran huruf|jenis huruf|bobot/i.test(text)) problems.push('Design System belum memberi token typography');
    if (!/spacing|space|gap|padding|\d+(?:px|rem)/i.test(text)) problems.push('Design System belum memberi spacing konkret');
    if (!/radius|border|shadow|bayangan|sudut/i.test(text)) problems.push('Design System belum memberi bentuk atau treatment konkret');
    if (!/keyboard|tab order|focus|screen reader|reader|kontras|contrast|wcag|alt text|label|pembaca layar|terprogram/i.test(text)) problems.push('Design System belum memuat bukti aksesibilitas');
    // Istilah Indonesia juga sah: model menulis "memuat", "kosong", "gagal".
    if (!/loading|error|empty|keadaan kosong|kesalahan|memuat|kosong|gagal|muat ulang|tidak ada data|skeleton/i.test(text)) problems.push('Design System belum memuat state UI penting');
    if (/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(text)) problems.push('Design System memakai emoji sebagai ikon');
  }

  if (skeletonStage) return problems;

  if (!Array.isArray(prd.tasks)) {
    problems.push('tasks harus berupa array');
    return problems;
  }
  if (!tasks.length) {
    problems.push('tidak ada task implementasi');
    return problems;
  }
  if (tasks.some(task => !task || typeof task !== 'object')) return [...problems, 'task harus berupa objek, bukan null'];

  const ids = new Set();
  const taskModules = [];
  tasks.forEach((task, index) => {
    const id = typeof task.id === 'string' ? task.id.trim() : '';
    const title = String(task.title || '').trim();
    const module = typeof task.module === 'string' ? task.module.trim() : '';
    const spec = String(task.spec || '').trim();
    if (!/^TASK-\d{2,}$/.test(id) || ids.has(id)) problems.push(`ID task ${id || index + 1} tidak valid atau duplikat`);
    if (!title || title.length < 8) problems.push(`task ${id || index + 1} tidak punya judul yang bisa langsung dikerjakan`);
    if (!module) problems.push(`task ${id || index + 1} tidak mengisi field "module"`);
    if (!spec || spec.length < 120) problems.push(`spec task ${id || index + 1} kosong/terlalu pendek`);
    if (spec && !hasFilePath(spec)) problems.push(`task ${id || index + 1} tidak menyebut file path konkret`);
    if (spec && !hasDependencyValue(spec)) problems.push(`task ${id || index + 1} tidak mengisi dependensi secara eksplisit`);
    if (spec && !hasDoneEvidence(spec)) problems.push(`task ${id || index + 1} tidak punya kriteria selesai/definisi done`);
    if (spec && !/verifikasi|pengujian|test|uji|curl|mandatory|bukti/i.test(spec)) problems.push(`task ${id || index + 1} tidak punya cara verifikasi`);
    if (spec && !/error|gagal|edge|failure|fallback|validasi|exception/i.test(spec)) problems.push(`task ${id || index + 1} tidak menjelaskan penanganan error/edge case`);
    if (id) ids.add(id);
    if (module) taskModules.push(module);
    for (const dependency of taskDependencies(spec)) {
      if (dependency === id || !ids.has(dependency)) problems.push(`dependensi ${dependency} pada ${id || index + 1} belum ada atau melingkar`);
    }
  });

  for (const module of featureModules) {
    if (!taskModules.some(taskModule => taskModule.toLowerCase() === module.toLowerCase())) problems.push(`modul "${module}" tidak punya task dengan field "module" yang sama persis`);
  }
  for (const module of taskModules) {
    if (!featureModules.some(featureModule => featureModule.toLowerCase() === module.toLowerCase())) problems.push(`task memakai module "${module}" yang tidak ada di features`);
  }
  for (const feature of features) {
    if (!feature?.module) continue;
    const assigned = tasks.filter(task => String(task.module || '').trim().toLowerCase() === String(feature.module).trim().toLowerCase()).map(task => `${task.title || ''} ${task.spec || ''}`).join(' ').toLowerCase();
    for (const [, taskPattern] of requiredFeatureCapabilities(feature)) {
      if (!taskPattern.test(assigned)) problems.push(`fitur "${feature.module}" tidak punya task untuk kemampuan yang disebut`);
    }
  }
  for (const table of prd.databaseSchema) {
    if (!tasks.some(task => String(task.spec || '').includes(table.table))) problems.push(`tabel ${table.table} belum tercakup task`);
  }
  for (const endpoint of prd.apiEndpoints) {
    if (!tasks.some(task => String(task.spec || '').includes(endpoint.path) && new RegExp(`\\b${endpoint.method}\\b`, 'i').test(task.spec))) problems.push(`endpoint ${endpoint.method} ${endpoint.path} belum tercakup task`);
    if (/webhook|callback/i.test(endpoint.path) && !tasks.some(task => /webhook|callback/i.test(task.spec || ''))) problems.push(`endpoint ${endpoint.method} ${endpoint.path} tidak punya task penerimaan`);
  }
  return problems;
}

const VALIDATION_RETRY_INSTRUCTION = `

=== PERBAIKAN WAJIB (percobaan sebelumnya DITOLAK) ===
PRD sebelumnya gagal pemeriksaan otomatis karena masalah berikut:
{{PROBLEMS}}

Perbaiki SEMUA masalah di atas. Pastikan untuk SETIAP modul pada "features" ada minimal satu task di "tasks" yang menyebut modul tersebut (isi field "module" pada task dengan nama modul yang sama persis). Setiap integrasi pihak ketiga dan webhook wajib punya task sendiri. Keluarkan JSON lengkap yang sudah diperbaiki.`;

async function callRouter(routerCfg, chosenModel, systemPrompt, userPrompt, attempt = 1, busyIdx = 0, omitJsonMode = false) {
  // Batas 420 dtk per panggilan. Tahap 1 menulis PRD penuh (ringkasan,
  // arsitektur, DB, endpoint) dan free model butuh 150-300 dtk; batas lama
  // membuat panggilan yang normal terbaca sebagai "koneksi gagal".
  // ponytail: turunkan ke 180 dtk setelah semua model lolos <120 dtk.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 420000);
  let res;
  // Router FREE melakukan cache prompt: dua panggilan dengan system prompt
  // mirip dijawab ulang dari cache, sehingga panggilan "inti teknis" menerima
  // jawaban "identitas" (kunci projectName/tagline/summary). Nonce pendek per
  // panggilan memutus cache tanpa mengubah isi prompt.
  // ponytail: hapus kalau router berhenti melakukan cache.
  const callId = `req-${chosenModel}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
  const payload = {
    model: chosenModel,
    messages: [
      { role: 'system', content: `${systemPrompt}\n\n[ref:${callId}]` },
      { role: 'user', content: userPrompt }
    ],
    temperature: 0.2,
    // 7000 token, bukan 16000. Terukur pada prompt nyata (3 percobaan tiap
    // nilai): 3000 dan 5000 SELALU terpotong, 6000 hanya 1/3 berhasil, 7000
    // berhasil 3/3, sedangkan 8000-32000 dijawab router dengan 502 dan badan
    // kosong. Batas eksplisit tetap perlu supaya router tidak memotong
    // diam-diam, tapi nilai besar justru mematikan panggilan.
    max_tokens: 7000
  };
  // Minta JSON mode bila mendukung. Model gratis yang tidak mendukungnya
  // diulang sekali tanpa field ini, lalu tetap divalidasi secara lokal.
  if (!omitJsonMode) payload.response_format = { type: 'json_object' };
  try {
    res = await fetch(`${routerCfg.baseUrl}/chat/completions`, {
      signal: controller.signal,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${routerCfg.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });
    var rawText = await res.text();
  } catch (fetchErr) {
    // Jangan meneruskan pesan fetch mentah: bisa memuat URL internal atau detail provider.
    if (process.env.PRDMAKER_DEBUG_RAW) {
      fs.appendFileSync(process.env.PRDMAKER_DEBUG_RAW, `\n[fetchErr attempt=${attempt}] ${fetchErr.name}: ${fetchErr.message} cause=${fetchErr.cause?.code || fetchErr.cause?.message || '-'}\n`);
    }
    if (attempt === 1) {
      console.warn('[AI] Koneksi ke router gagal, mengulang sekali...');
      await new Promise(r => setTimeout(r, 2000));
      return await callRouter(routerCfg, chosenModel, systemPrompt, userPrompt, attempt + 1, busyIdx, omitJsonMode);
    }
    throw Object.assign(new Error('provider_connection_failed'), { cause: fetchErr });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    if (!omitJsonMode && res.status === 400 && /response_format|json[_ -]?mode|unsupported.*param|unknown.*param/i.test(rawText)) {
      console.warn('[AI] Model tidak mendukung JSON mode, mengulang tanpa response_format...');
      return await callRouter(routerCfg, chosenModel, systemPrompt, userPrompt, attempt, busyIdx, true);
    }
    // Error sementara dari penyedia (502/504/timeout upstream): tunggu lalu
    // coba lagi. Free model sering 502 beruntun saat dua panggilan besar
    // beruntun, jadi tiga percobaan dengan jeda memanjang.
    // ponytail: turunkan ke 1x retry setelah model target stabil <1%.
    if (attempt <= 3 && ([500, 502, 503, 504].includes(res.status) || /connect timeout|Timeout|ETIMEDOUT/i.test(rawText))) {
      const backoffMs = 3000 * attempt;
      console.warn(`[AI] Router HTTP ${res.status} (sementara), mengulang ${attempt}/3 setelah jeda...`);
      await new Promise(r => setTimeout(r, backoffMs));
      return await callRouter(routerCfg, chosenModel, systemPrompt, userPrompt, attempt + 1, busyIdx, omitJsonMode);
    }
    // Antrean penuh (limit 1 request bersamaan per key): ini BUKAN kegagalan,
    // hanya slot sibuk. Satu key dipakai beberapa klien (UI, CLI, live test),
    // jadi tunggutotal harus melebihi durasi satu permintaan terpanjang.
    // ponytail: 6x coba (10..120 dtk); turunkan lagi bila key dipakai 1 klien.
    if (/concurrent_limit|Batas request bersamaan/i.test(rawText) && busyIdx < 6) {
      const waitMs = [10000, 20000, 40000, 60000, 90000, 120000][busyIdx];
      console.warn(`[AI] Slot router sibuk, tunggu ${waitMs / 1000} dtk lalu coba lagi (${busyIdx + 1}/6)...`);
      await new Promise(r => setTimeout(r, waitMs));
      return await callRouter(routerCfg, chosenModel, systemPrompt, userPrompt, attempt, busyIdx + 1, omitJsonMode);
    }
    throw new Error(`Router HTTP ${res.status}: ${/concurrent_limit|Batas request bersamaan/i.test(rawText) ? 'concurrent_limit' : 'provider_request_failed'}`);
  }
  const routerJson = parseRouterResponse(rawText);
  const choice = routerJson.choices?.[0];
  const rawContent = choice?.message?.content;
  if (!rawContent || typeof rawContent !== 'string') {
    throw new Error('Model tidak mengembalikan isi jawaban (content kosong)');
  }
  // Potongan keluaran = batas token, bukan kesalahan isi. Kembalikan error
  // khusus supaya pemanggil memperpanjang anggaran, bukan menyalahkan model.
  if (choice?.finish_reason === 'length') {
    throw Object.assign(new Error('output_truncated'), { rawContent });
  }
  const jsonText = extractJSON(rawContent);
  if (process.env.PRDMAKER_DEBUG_RAW) {
    fs.appendFileSync(process.env.PRDMAKER_DEBUG_RAW,
      `\n===== ${chosenModel} ${new Date().toISOString()} finish=${choice?.finish_reason} usage=${JSON.stringify(routerJson.usage || null)} =====\n${rawContent}\n`);
  }
  try {
    return JSON.parse(jsonText);
  } catch {
    // Model menjawab dengan prosa/markdown, bukan JSON. Coba sekali lagi dengan
    // peringatan tegas: sebagian model butuh ini.
    if (attempt === 1) {
      console.warn('[AI] Jawaban bukan JSON, mengulang sekali dengan instruksi tegas...');
      const strict = userPrompt + `

=== PERINGATAN FORMAT (WAJIB) ===
Jawaban sebelumnya ditolak karena berisi teks/markdown, bukan JSON. Jangan menulis judul, penjelasan, atau kalimat apa pun di luar JSON. Jangan memakai pagar kode \`\`\`. Karakter pertama jawabanmu HARUS "{" dan karakter terakhir HARUS "}". Keluarkan JSON lengkap sekarang.`;
      return await callRouter(routerCfg, chosenModel, systemPrompt, strict, attempt + 1, busyIdx, omitJsonMode);
    }
    throw new Error('Model menjawab dengan teks biasa, bukan JSON. Jawaban tidak bisa dibaca.');
  }
}

export async function generatePRDFromPrompt(userIdea, name, clarifications = [], model, designDirection) {
  const routerCfg = getRouterConfig();
  // Model yang dipakai per panggilan. Bisa berganti saat generate memakai model
  // cadangan dari PRD_MODEL_CHAIN, jadi disimpan sebagai let, bukan const.
  let chosenModel = selectedModel(routerCfg, model);
  if (!routerCfg.apiKey) {
    throw new Error('Layanan AI belum dikonfigurasi. Setel API key dan default model lewat konfigurasi aplikasi.');
  }
  const directionBlock = designDirectionPromptBlock(designDirection);
  // Tahap 2 hanya perlu kontrak aksesibilitas-craft, bukan daftar 7 template:
  // arah visual sudah diputuskan di tahap 1.
  const tasksSystemPrompt = PRD_TASKS_SYSTEM_PROMPT.replace(designTemplatePromptBlock(), '') + '\n' + getDesignGuidance();

  const basePrompt = `Project Name: ${name || 'Auto-detect'}\nIde Aplikasi: ${userIdea}\n`;
  const clarificationText = clarifications.map((c, idx) => `${idx + 1}. Tanya: ${c.question}\n   Keputusan: ${c.answer}`).join('\n');
  const userPrompt = basePrompt + (clarificationText ? `\nHASIL KLARIFIKASI & KEPUTUSAN PENGGUNA:\n${clarificationText}\n` : '') + `\n${directionBlock}\n`;
  let lastRouterError = '';

  function validationError(stage, problems) {
    const err = new Error(
      `PRD tersusun tetapi TIDAK lolos pemeriksaan ${stage}, jadi tidak disimpan. ` +
      `Yang kurang: ${problems.join('; ')}.`
    );
    err.validationProblems = problems;
    err.validationStage = stage;
    return err;
  }

  // Keluaran terpotong (finish_reason=length) bukan kesalahan model, tapi
  // anggaran token. Satu percobaan ulang dengan instrksi memendekkan.
  async function callWithTruncationRetry(system, prompt, compactHint = '') {
    try {
      return await callRouter(routerCfg, chosenModel, system, prompt);
    } catch (err) {
      if (err.message !== 'output_truncated') throw err;
      console.warn('[AI-PRD] Keluaran terpotong, mengulang dengan instruksi lebih padat...');
      // Hint pemadatan per tahap: instruksi lama menyebut summary/architecture
      // di semua tahap, sehingga retry tasks tidak pernah lebih pendek dan
      // terpotong lagi (terukur di live run).
      const hint = compactHint ||
        'Ringkas: architectureOverview maksimal 250 kata, summary maksimal 180 kata, features 3-6 modul.';
      return await callRouter(routerCfg, chosenModel, system,
        prompt + `\n\nPENTING: jawaban sebelumnya terpotong karena terlalu panjang. ${hint} ` +
        'Tetap keluarkan SEMUA field sampai JSON penutup.');
    }
  }

  // Router gratis kadang menjawab tahap dengan bentuk tahap sebelumnya: kunci
  // yang diminta tidak muncul padahal panggilannya sukses. Karena itu tiap
  // tahap memeriksa kuncinya sendiri dan mengulang sekali kalau bentuknya salah.
  // ponytail: hapus kalau router berhenti mengembalikan bentuk tahap lain.
  // Hasil tahap yang SUDAH lolos pemeriksaan kuncinya. Terukur: luna
  // menyelesaikan identitas+stack+fitur dalam 51 detik, lalu 502 di tahap
  // skema; tanpa cache fallback mengulang dari nol sehingga satu generate
  // terasa 4+ menit padahal sebagian besar kerjanya sudah benar.
  // Kontinuitas antar model aman karena tiap prompt membawa keputusan tahap
  // sebelumnya sebagai teks (decidedText + techStack), bukan mengandalkan
  // ingatan model.
  const stageCache = new Map();

  async function callStage(label, system, prompt, requiredKeys, compactHint = '') {
    if (stageCache.has(label)) {
      console.log(`[AI-PRD] Tahap ${label} memakai hasil yang sudah berhasil dari model sebelumnya.`);
      return stageCache.get(label);
    }
    const attempt = async (suffix) => {
      const out = await callWithTruncationRetry(system, prompt + suffix, compactHint);
      const missing = requiredKeys.filter((k) => out?.[k] === undefined);
      if (missing.length) {
        console.warn(`[AI-PRD] Tahap ${label} tidak mengembalikan ${missing.join(', ')}; mengulang.`);
        return { out, missing };
      }
      return { out, missing: [] };
    };
    let { out, missing } = await attempt('');
    if (missing.length) ({ out, missing } = await attempt(`\nUlangi khusus tahap ${label}: keluarkan hanya ${requiredKeys.join(', ')}.`));
    if (missing.length) {
      const err = new Error(`Tahap ${label} tidak menghasilkan ${missing.join(', ')} setelah dua percobaan.`);
      err.code = 'stage_shape_missing';
      err.missing = missing;
      throw err;
    }
    stageCache.set(label, out);
    return out;
  }

  async function generateSkeleton() {
    // Empat panggilan fokus: identitas, stack+arsitektur, fitur, skema+API.
    // Dipisah karena model gratis self-stop setelah ~2 kunci saat diminta semua
    // field sekaligus, gabungan fitur+skema terpotong di plafon token, dan 502
    // kalau max_tokens dinaikkan di atas ~8000.
    console.log(`[AI-PRD] Tahap 1a/4 identitas via ${chosenModel}...`);
    const identity = normalizePRDFields(await callStage(
      'identitas',
      PRD_IDENTITY_SYSTEM_PROMPT,
      userPrompt + '\nTulis identitas produk (projectName, tagline, summary) sekarang.',
      ['projectName', 'tagline', 'summary']
    ));

    const decided = {
      projectName: identity.projectName,
      tagline: identity.tagline,
      summary: identity.summary
    };
    const decidedText = '\nKeputusan produk yang sudah ditetapkan (jangan mengulang field ini):\n' +
      JSON.stringify(decided) + '\n';

    console.log(`[AI-PRD] Tahap 1b/4 stack & arsitektur via ${chosenModel}...`);
    const core = normalizePRDFields(await callStage(
      'stack & arsitektur',
      // Kontrak desain + referensi arah hanya sekali, di panggilan yang menulis
      // arsitektur, bukan di tiap panggilan.
      PRD_CORE_SYSTEM_PROMPT + '\n' + designTemplatePromptBlock() + '\n' + getDesignGuidance(),
      userPrompt + decidedText + '\nSusun techStack dan architectureOverview sekarang.',
      ['techStack', 'architectureOverview']
    ));

    // Fitur dan skema/endpoint dipanggil TERPISAH. Gabungan ketiganya kadang
    // butuh >7000 completion token dan terpotong, sedangkan plafon di atas
    // 8000 membuat router menjawab 502 (terukur: features ~2400 token,
    // db+api ~4300 token, gabungan 5400-7000+ token).
    console.log(`[AI-PRD] Tahap 1c/4 fitur via ${chosenModel}...`);
    // Modul Design System dituntut validator pada features, jadi syaratnya
    // harus ada di prompt yang MENULIS features.
    const features = normalizePRDFields(await callStage(
      'fitur',
      PRD_FEATURES_SYSTEM_PROMPT + '\n' + getDesignSystemRequirement(),
      userPrompt + decidedText +
      `\nStack yang ditetapkan (techStack): ${JSON.stringify(core.techStack)}\n` +
      'Susun features sekarang.',
      ['features']
    ));

    console.log(`[AI-PRD] Tahap 1d/4 skema data & API via ${chosenModel}...`);
    const schema = normalizePRDFields(await callStage(
      'skema data & API',
      PRD_DB_API_SYSTEM_PROMPT,
      userPrompt + decidedText +
      `\nStack yang ditetapkan (techStack): ${JSON.stringify(core.techStack)}\n` +
      `Daftar modul fitur (skema dan endpoint harus mendukung semua modul ini): ${JSON.stringify((features.features || []).map(f => f && f.module))}\n` +
      'Susun databaseSchema dan apiEndpoints sekarang.',
      ['databaseSchema', 'apiEndpoints']
    ));

    const detail = { ...features, ...schema };

    let skeleton = { ...identity, ...core, ...detail };
    let problems = validatePRD(skeleton, 'skeleton');
    if (problems.length) {
      console.warn(`[AI-PRD] Tahap 1 ditolak validator: ${problems.join('; ')}`);
      // Perbaikan harus menulis ulang tahap yang bermasalah. Sebelumnya semua
      // masalah dilempar ke prompt rincian, sehingga summary/arsitektur yang
      // rusak mustahil diperbaiki dan PRD selalu gagal.
      const proseProblems = problems.filter(p => /summary|ringkasan|architectureOverview|arsitektur|techStack|skala|batas lingkup/i.test(p));
      const detailProblems = problems.filter(p => !proseProblems.includes(p));

      // Hasil perbaikan bisa LEBIH BURUK dari upaya pertama (terukur: upaya
      // pertama punya 6 acceptanceCriteria dan tabel 16 field, hasil perbaikan
      // malah kehilangan nama modul). Jadi tiap bagian dinilai ulang dan hanya
      // dipakai kalau benar-benar mengurangi jumlah masalah.
      const problemsFor = (candidate) => validatePRD(candidate, 'skeleton').length;

      let prose = { summary: identity.summary, projectName: identity.projectName, tagline: identity.tagline, techStack: core.techStack, architectureOverview: core.architectureOverview };
      if (proseProblems.length) {
        // Prompt perbaikan harus memuat ATURAN field yang diminta, bukan hanya
        // masalahnya. Sebelumnya dipakai PRD_IDENTITY_SYSTEM_PROMPT yang tidak
        // pernah meminta alasan/alternatif arsitektur, sehingga perbaikan tidak
        // pernah bisa memenuhi syarat dan putaran selalu gagal.
        const fixedProse = normalizePRDFields(await callStage(
          'perbaikan identitas & arsitektur',
          PRD_IDENTITY_SYSTEM_PROMPT + '\n' + PRD_CORE_SYSTEM_PROMPT,
          userPrompt + `\nTulis ulang summary, techStack, dan architectureOverview sampai benar. ` +
          'architectureOverview WAJIB menyebut alasan pemilihan stack dan minimal satu alternatif yang ditolak ' +
          '(pakai kata "dipilih"/"memilih" dan "ditolak"/"alternatif"). Ringkas dan bersih, tanpa huruf asing atau kata berulang. ' +
          `Masalah yang harus dibereskan: ${proseProblems.join('; ')}`,
          ['projectName', 'tagline', 'summary', 'techStack', 'architectureOverview']
        ));
        if (fixedProse && problemsFor({ ...identity, ...core, ...detail, ...fixedProse }) < problemsFor(skeleton)) {
          prose = fixedProse;
        } else {
          console.warn('[AI-PRD] Perbaikan prosa tidak memperbaiki; memakai hasil pertama.');
        }
      }

      let detailFixed = detail;
      if (detailProblems.length) {
        // Perbaikan diarahkan ke panggilan yang MENULIS bagian bermasalah:
        // masalah fitur ke prompt fitur, masalah skema/endpoint ke prompt
        // skema. Regenerasi gabungan dulu sering terpotong di plafon token.
        const featureProblems = detailProblems.filter(p => /fitur|Design System/i.test(p));
        const schemaProblems = detailProblems.filter(p => !featureProblems.includes(p));

        let candidate = { ...detail };
        if (featureProblems.length) {
          const fixedF = normalizePRDFields(await callWithTruncationRetry(
            PRD_FEATURES_SYSTEM_PROMPT + '\n' + getDesignSystemRequirement(),
            userPrompt + decidedText +
            `\nStack yang ditetapkan: ${JSON.stringify(prose.techStack)}\n` +
            `Perbaiki features berikut. Jangan mengubah identitas, arsitektur, skema, atau endpoint.\n` +
            `Masalah: ${featureProblems.join('; ')}`
          ));
          // Hasil perbaikan bisa LEBIH BURUK (fitur tanpa nama modul). Hanya
          // dipakai kalau benar-benar mengurangi jumlah masalah.
          const usable = Array.isArray(fixedF.features) && fixedF.features.length
            && fixedF.features.every(f => f && typeof f.module === 'string' && f.module.trim());
          if (usable && problemsFor({ ...identity, ...core, ...candidate, ...fixedF }) < problemsFor({ ...identity, ...core, ...candidate })) {
            candidate = { ...candidate, ...fixedF };
          } else {
            console.warn('[AI-PRD] Perbaikan fitur tidak memperbaiki; memakai hasil pertama.');
          }
        }
        if (schemaProblems.length) {
          const fixedS = normalizePRDFields(await callWithTruncationRetry(
            PRD_DB_API_SYSTEM_PROMPT,
            userPrompt + decidedText +
            `\nStack yang ditetapkan: ${JSON.stringify(prose.techStack)}\n` +
            `Daftar modul fitur: ${JSON.stringify((candidate.features || []).map(f => f && f.module))}\n` +
            `Perbaiki databaseSchema dan apiEndpoints berikut. Jangan mengubah fitur.\n` +
            `Masalah: ${schemaProblems.join('; ')}`
          ));
          if (problemsFor({ ...identity, ...core, ...candidate, ...fixedS }) < problemsFor({ ...identity, ...core, ...candidate })) {
            candidate = { ...candidate, ...fixedS };
          } else {
            console.warn('[AI-PRD] Perbaikan skema tidak memperbaiki; memakai hasil pertama.');
          }
        }
        detailFixed = candidate;
      }
      skeleton = { ...identity, ...prose, ...detailFixed };
      problems = validatePRD(skeleton, 'skeleton');
    }
    if (problems.length) throw validationError('kerangka PRD', problems);
    return skeleton;
  }

  async function generateTasks(skeleton) {
    const modules = skeleton.features.filter(Boolean).map(feature => feature.module).filter(Boolean);
    console.log(`[AI-PRD] Tahap 2/2 tasks via ${chosenModel}...`);
    const context = `Ide: ${userIdea}\nKerangka PRD tahap 1:\n${JSON.stringify(skeleton)}\n\n` +
      `Daftar nama modul (pakai persis untuk field "module"): ${modules.join(', ')}\n\n`;
    // Hint pemadatan khusus tasks: spec adalah bagian terpanjang dan yang
    // paling sering menembus plafon 7000 token.
    const tasksHint = 'Maksimal 7 task. Setiap spec maksimal 130 kata: tetap memuat ketujuh label ' +
      '(Tujuan, File, Dependensi, Implementasi, Error/edge case, Kriteria selesai, Verifikasi) ' +
      'tapi tiap label satu kalimat pendek. title maksimal 10 kata.';
    let tasksRes = await callWithTruncationRetry(
      tasksSystemPrompt,
      context + 'Susun tasks sekarang.',
      tasksHint
    );
    let parsed = normalizePRDFields({ ...skeleton, tasks: Array.isArray(tasksRes?.tasks) ? tasksRes.tasks : [] });
    let problems = validatePRD(parsed);
    if (problems.length) {
      console.warn(`[AI-PRD] Tahap 2 ditolak validator: ${problems.join('; ')}`);
      const retryRes = await callWithTruncationRetry(
        tasksSystemPrompt,
        context + `Perbaiki tasks. Jangan mengubah kerangka. Masalah: ${problems.join('; ')}`,
        tasksHint
      );
      // Perbaikan hanya dipakai kalau benar-benar mengurangi masalah. Model
      // kadang menjawab dengan skema lain (description/files/acceptanceCriteria
      // alih-alih spec), dan menimpanya membuat SEMUA task kehilangan spec.
      const candidate = normalizePRDFields({ ...skeleton, tasks: Array.isArray(retryRes?.tasks) ? retryRes.tasks : [] });
      const retryProblems = validatePRD(candidate);
      if (retryProblems.length < problems.length) {
        parsed = candidate;
        problems = retryProblems;
      } else {
        console.warn('[AI-PRD] Perbaikan tasks tidak memperbaiki; memakai hasil pertama.');
      }
    }
    if (problems.length) throw validationError('tasks', problems);
    console.log(`[AI-PRD] PRD lolos validasi: ${parsed.tasks.length} task, ${parsed.features.length} modul.`);
    return parsed;
  }

  // Coba model yang dipilih pengguna lebih dulu, lalu model cadangan dari
  // PRD_MODEL_CHAIN kalau gagal. Rantai ini terukur: plan free memblokir 35 dari
  // 41 model, dan model gratis yang tersisa kadang mengeluarkan teks korup atau
  // kena 502, sehingga satu percobaan per model terlalu rapuh.
  const candidates = prdModelCandidates(chosenModel);
  // Kegagalan dicatat per model. Yang dilaporkan ke pengguna adalah yang paling
  // informatif (kesalahan bentuk/validasi mengalahkan "koneksi gagal"), karena
  // model terakhir dalam rantai mungkin cuma kena 502 sesaat.
  const failures = [];
  // Kerangka yang SUDAH lolos validasi dipakai ulang bila kegagalan terjadi di
  // tahap tasks: model berikutnya hanya menulis tasks, bukan seluruh PRD.
  let skeletonDone = null;
  for (let i = 0; i < candidates.length; i++) {
    chosenModel = candidates[i];
    if (i > 0) console.log(`[AI-PRD] Mencoba model cadangan ${chosenModel} (${i + 1}/${candidates.length})...`);
    try {
      if (!skeletonDone) skeletonDone = await generateSkeleton();
      return await generateTasks(skeletonDone);
    } catch (err) {
      lastRouterError = err.message;
      failures.push(err);
      // Kegagalan ISI kerangka berarti konten tahap-tahap itu memang tidak
      // bisa dipakai, jadi cache dibuang supaya model berikutnya menulis
      // ulang. Kegagalan transport (502/429/timeout) atau bentuk salah tidak
      // menyalahkan tahap yang sudah benar: cache dipertahankan, dan model
      // berikutnya hanya mengulang tahap yang gagal.
      if (err.validationStage === 'kerangka PRD') {
        stageCache.clear();
        skeletonDone = null;
      }
      console.error(`[AI-PRD] Gagal via ${chosenModel}:`, err.message);
    }
  }
  const decisive = failures.find(e => e.validationProblems || /setelah dua percobaan|tidak menghasilkan/i.test(e.message));
  if (decisive) {
    console.error('[AI-PRD] Gagal semua model dalam rantai:', decisive.message);
    // validationError sudah menulis pesan Indonesia yang siap tampil; yang
    // mentah (kesalahan bentuk model) baru perlu diterjemahkan.
    if (decisive.validationProblems) throw decisive;
    throw new Error(routerErrorMessage(decisive.message, 'menyusun PRD'));
  }
  throw new Error(routerErrorMessage(lastRouterError, 'menyusun PRD'));
}

const APPEND_CHANGE_SYSTEM_PROMPT = `
Kamu adalah Head of Product & Lead Architect.
Tugasmu: Menerima permintaan perubahan / penambahan fitur baru di tengah jalan untuk project yang PRD-nya sudah ada.
Kamu harus menganalisa dampak perubahan tersebut terhadap aplikasi yang sedang dibangun, lalu merumuskan:
1. Ringkasan penyesuaian arsitektur (1-2 kalimat)
2. Fitur/Modul baru jika ada
3. Endpoint API baru jika ada
4. Tabel DB baru jika ada
5. Tambahan TASK Eksekusi Teknis baru terurut yang belum ada di task list sebelumnya.

Format output WAJIB berupa JSON murni tanpa markdown wrapper:
{
  "changeSummary": "Penjelasan singkat dampak perubahan ini terhadap sistem",
  "updatedSummary": "Summary project terbaru jika ada perubahan skala",
  "newFeatures": [
    {
      "module": "Nama Modul Baru",
      "description": "Deskripsi fitur",
      "acceptanceCriteria": ["Kriteria penerimaan"]
    }
  ],
  "newEndpoints": [
    {
      "method": "POST | GET | PATCH | DELETE",
      "path": "/api/v1/...",
      "description": "Fungsi endpoint baru"
    }
  ],
  "newDbTables": [
    {
      "table": "nama_tabel_baru",
      "description": "Fungsi tabel baru",
      "fields": ["id TEXT PRIMARY KEY", "..."]
    }
  ],
  "newTasks": [
    {
      "id": "TASK-NEW",
      "title": "Judul task tambahan spesifik",
      "module": "Nama Modul Baru",
      "spec": "Tujuan; File; Dependensi: TASK-xx atau tidak ada; Implementasi; Error/edge case; Kriteria selesai; Verifikasi."
    }
  ]
}
`;

export async function appendFeatureChange(workspace, existingTasks = [], changeRequest, model) {
  const routerCfg = getRouterConfig();
  const chosenModel = selectedModel(routerCfg, model);
  let lastRouterError = '';

  const contextPrompt = `
PROJECT NAME: ${workspace.name}
SUMMARY LAMA: ${workspace.summary}
TECH STACK: ${JSON.stringify(workspace.techStack || workspace.tech_stack)}
ARSITEKTUR: ${workspace.architectureOverview || workspace.architecture || ''}
FITUR: ${JSON.stringify(workspace.features || [])}
DATABASE: ${JSON.stringify(workspace.databaseSchema || [])}
ENDPOINT: ${JSON.stringify(workspace.apiEndpoints || [])}
TASK YANG SUDAH ADA (${existingTasks.length} task):
${existingTasks.map(t => `- [${t.status}] ${t.id}: ${t.title}`).join('\n')}

PERMINTAAN PERUBAHAN / PENAMBAHAN FITUR DARI PENGGUNA:
"${changeRequest}"

Tugas: Buatkan penambahan fitur dan task eksekusi lanjutan untuk memenuhi permintaan perubahan tersebut.
`;

  if (routerCfg && routerCfg.apiKey) {
    try {
      console.log(`[AI-APPEND] Processing change request via ${chosenModel}...`);
      const result = await callRouter(routerCfg, chosenModel,
        APPEND_CHANGE_SYSTEM_PROMPT + '\n' + getDesignGuidance() + '\nTask baru wajib spec konkret minimal 180 karakter berisi file path, Dependensi: TASK-xx (hanya task sebelumnya) atau tidak ada, error handling dan Verifikasi. Gunakan ID TASK-xx setelah ID maksimum yang sudah ada, jangan mengulang. newFeatures/newEndpoints/newDbTables hanya entri baru, jangan mengulang entri lama.', contextPrompt);
      const problems = [];
      if (!result || typeof result !== 'object') throw new Error('Format perubahan tidak valid');
      if (!result.changeSummary || !Array.isArray(result.newTasks) || !result.newTasks.length) problems.push('perubahan wajib memiliki ringkasan dan task');
      for (const key of ['newFeatures', 'newEndpoints', 'newDbTables']) if (!Array.isArray(result[key])) problems.push(`${key} harus array`);
      const ids = new Set(existingTasks.map(t => t.id));
      for (const t of result.newTasks || []) {
        const spec = String(t?.spec || '');
        const dependencies = taskDependencies(spec);
        if (!t || !/^TASK-\d{2,}$/.test(t.id || '') || ids.has(t.id) || !t.title || !t.module || spec.length < 180 || !hasFilePath(spec) || !hasDependencyValue(spec) || !hasDoneEvidence(spec) || !/verifikasi|test|uji|curl|bukti/i.test(spec)) problems.push('task baru tidak lengkap/ID duplikat');
        for (const dependency of dependencies) {
          if (dependency === t?.id) problems.push(`dependensi task baru ${dependency} menunjuk dirinya sendiri`);
          else if (!ids.has(dependency)) problems.push(`dependensi task baru ${dependency} belum ada`);
        }
        if (t) ids.add(t.id);
      }
      for (const [key, field, old] of [['newFeatures','module',workspace.features], ['newEndpoints','path',workspace.apiEndpoints], ['newDbTables','table',workspace.databaseSchema]]) {
        const seen = new Set((old || []).map(x => x[field]));
        for (const entry of Array.isArray(result[key]) ? result[key] : []) {
          const value = entry?.[field];
          if (!value || seen.has(value)) problems.push(`${key} memiliki entri kosong/duplikat`);
          seen.add(value);
        }
      }
      if (problems.length) throw Object.assign(new Error('PRD perubahan tidak lengkap: ' + problems.join('; ')), { validationProblems: problems });
      return result;
    } catch (err) {
      lastRouterError = err.message;
      if (err.validationProblems) throw err;
      console.error('[AI-APPEND] Error:', err.message);
    }
  }

  // Router offline / gagal. Jangan mengembalikan "task" tempelan yang isinya
  // cuma mengulang permintaan pengguna tanpa spesifikasi nyata.
  throw new Error(routerErrorMessage(lastRouterError, 'memperbarui PRD'));
}
