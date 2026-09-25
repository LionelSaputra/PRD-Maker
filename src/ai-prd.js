import fs from 'fs';
import os from 'os';
import { join } from 'path';
import { designTemplatePromptBlock } from './design-templates.js';

// Konfigurasi penyedia AI. Dulu nilai-nilai ini di-hardcode ke satu server
// tertentu, sehingga repo tidak bisa dijalankan di mesin lain. Sekarang dibaca
// dari environment lebih dulu, baru jatuh ke berkas konfigurasi lokal.
const DEFAULT_BASE_URL = 'http://127.0.0.1:20127/v1';
const DEFAULT_MODEL = 'oa/gemini-3.8-flash-high';
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
    defaultModel: process.env.PRDMAKER_MODEL || fromFile.defaultModel || DEFAULT_MODEL
  };
}

export async function fetchAvailableModels() {
  const routerCfg = getRouterConfig();
  if (!routerCfg || !routerCfg.apiKey) return ['oa/gemini-3.8-flash-high'];

  try {
    const res = await fetch(`${routerCfg.baseUrl}/models`, {
      headers: { 'Authorization': `Bearer ${routerCfg.apiKey}` }
    });
    if (!res.ok) return ['oa/gemini-3.8-flash-high'];
    const data = await res.json();
    const all = (data.data || []).map(m => m.id);
    // Filter model aktif saja untuk mencegah error 403 / plan limit
    const supported = all.filter(m => m.includes('gemini-3.8') || m.includes('deepseek-v4'));
    return supported.length > 0 ? supported : ['oa/gemini-3.8-flash-high'];
  } catch (err) {
    console.error('Failed to fetch models:', err.message);
    return ['oa/gemini-3.8-flash-high'];
  }
}

function parseRouterResponse(rawHttpText) {
  const cleaned = rawHttpText.split(/\ndata:\s*\[DONE\]/i)[0].trim();
  const firstOpen = cleaned.indexOf('{');
  const lastClose = cleaned.lastIndexOf('}');
  if (firstOpen !== -1 && lastClose !== -1 && lastClose > firstOpen) {
    return JSON.parse(cleaned.substring(firstOpen, lastClose + 1));
  }
  return JSON.parse(cleaned);
}

function extractJSON(raw) {
  if (!raw) return '{}';
  let str = raw.trim();
  str = str.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  
  const firstOpen = str.indexOf('{');
  const lastClose = str.lastIndexOf('}');
  if (firstOpen !== -1 && lastClose !== -1 && lastClose > firstOpen) {
    return str.substring(firstOpen, lastClose + 1);
  }
  return str;
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

export async function generateClarifications(userIdea, name, model) {
  const routerCfg = getRouterConfig();
  const chosenModel = model || routerCfg?.defaultModel || 'oa/gemini-3.8-flash-high';

  if (routerCfg && routerCfg.apiKey) {
    try {
      console.log(`[AI-CLARIFY] Requesting to model: ${chosenModel}...`);
      const res = await fetch(`${routerCfg.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${routerCfg.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: chosenModel,
          messages: [
            { role: 'system', content: CLARIFY_SYSTEM_PROMPT },
            { role: 'user', content: `Nama Project: ${name || 'Belum ada'}\nIde: ${userIdea}` }
          ],
          temperature: 0.2
        })
      });

      const rawText = await res.text();
      if (!res.ok) throw new Error(`Router HTTP ${res.status}: ${rawText}`);

      const routerJson = parseRouterResponse(rawText);
      const rawContent = routerJson.choices?.[0]?.message?.content || '{}';
      return JSON.parse(extractJSON(rawContent));
    } catch (err) {
      console.error('[AI-CLARIFY] Error:', err.message);
    }
  }

  // Fallback
  return {
    projectSuggestion: name || "My Project",
    briefAnalysis: "Ide project membutuhkan klarifikasi arsitektur & model bisnis.",
    questions: [
      {
        id: "q1",
        question: "Model bisnis dan target pengguna aplikasi?",
        options: ["B2C (Platform langsung ke pengguna akhir)", "B2B (Pengguna internal / enterprise)", "C2C / Marketplace antar pengguna"]
      },
      {
        id: "q2",
        question: "Metode autentikasi dan akses?",
        options: ["Email & Password + JWT", "OAuth (Google / GitHub)", "Passwordless / Magic Link OTP"]
      },
      {
        id: "q3",
        question: "Skema pembayaran / monetisasi utama?",
        options: ["Payment Gateway Otomatis (Midtrans / Xendit)", "Manual Transfer Bank / Bukti Bayar", "Gratis / Freemium tanpa pembayaran awal"]
      }
    ]
  };
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
   Untuk SETIAP integrasi atau API eksternal: kamu WAJIB sedangun task khusus untuk mengimplementasikannya, task khusus untuk menerima webhook-nya kalau ada, dan task khusus untuk menguji alurnya dari ujung ke ujung (termasuk simulasi sandbox/notifikasi palsu).
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
  "summary": "Latar belakang, problem statement, siapa penggunanya, dan solusi sistem (2-3 paragraf, paragraf terakhir wajib diawali 'Asumsi:')",
  "techStack": ["Teknologi lengkap dengan alasan singkat kenapa dipilih untuk aplikasi INI"],
  "architectureOverview": "Wajib diawali 'Keputusan teknologi:' berisi alasan stack + teknologi yang ditolak dan alasannya, lalu lanjut penjelasan arsitektur: alur data, state management, strategi autentikasi, penanganan berkas, integrasi eksternal, dan kesiapan deploy",
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
`;

const STOPWORDS = new Set([
  'dan', 'atau', 'yang', 'untuk', 'dengan', 'pada', 'dari', 'ke', 'di', 'the',
  'api', 'dan', 'serta', 'agar', 'bisa', 'dapat', 'saya', 'user', 'modul', 'fitur',
  'sistem', 'aplikasi', 'halaman', 'data', 'baru', 'ini', 'itu', 'juga', 'akan'
]);

function keywords(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 3 && !STOPWORDS.has(w));
}

// Petunjuk kata kunci untuk sebuah fitur: dipakai untuk menebak apakah sudah
// ada task yang mengerjakannya. Tiap entri: [nama, kata-kunci-pemicu].
const FEATURE_HINTS = [
  ['pembayaran', ['payment', 'bayar', 'qris', 'midtrans', 'xendit', 'stripe', 'checkout', 'invoice', 'refund']],
  ['webhook', ['webhook', 'callback', 'notifikasi-pihak-ketiga', 'signature']],
  ['notifikasi', ['notifikasi', 'notification', 'push', 'email', 'whatsapp', 'telegram', 'sms']],
  ['ekspor/impor', ['export', 'ekspor', 'import', 'impor', 'excel', 'csv', 'pdf', 'cetak']],
  ['unggah berkas', ['upload', 'unggah', 'berkas', 'file', 'storage', 's3', 'media', 'gambar', 'foto']],
  ['autentikasi', ['auth', 'login', 'autentikasi', 'jwt', 'session', 'sesi', 'rbac', 'role', 'peran', 'hak-akses']],
  ['realtime', ['realtime', 'websocket', 'socket', 'sse', 'live', 'langsung']],
  ['laporan/analitik', ['laporan', 'report', 'analitik', 'analytics', 'dashboard', 'statistik', 'omset', 'laba']],
  ['pencarian', ['search', 'pencarian', 'filter', 'cari']],
  ['peta/lokasi', ['peta', 'maps', 'lokasi', 'geolocation', 'gps']],
  ['pembayaran-berlangganan', ['subscription', 'langganan', 'billing', 'plan']],
];

function isFeatureCovered(feature, taskText) {
  const haystack = keywords(taskText).join(' ');
  const modWords = keywords(feature.module);
  if (modWords.length > 0 && modWords.filter(w => haystack.includes(w)).length >= Math.ceil(modWords.length * 0.6)) {
    return true;
  }
  // Cek apakah fitur menyebut kata kunci domain tertentu, dan task juga.
  const featText = `${feature.module || ''} ${feature.description || ''} ${(feature.acceptanceCriteria || []).join(' ')}`.toLowerCase();
  for (const [, triggers] of FEATURE_HINTS) {
    const featHas = triggers.some(t => featText.includes(t));
    if (!featHas) continue;
    const taskHas = triggers.some(t => haystack.includes(t.replace(/-/g, ' ')) || haystack.includes(t));
    if (!taskHas) return false; // fitur butuh hal ini, tapi tidak ada task yang menyentuhnya
  }
  return true;
}

// Validator: menolak PRD yang tidak lengkap. Dipakai untuk memicu retry sekali,
// supaya "tidak ada fitur yang miss" jadi jaminan, bukan harapan.
export function validatePRD(prd) {
  const problems = [];
  if (!prd || typeof prd !== 'object') return ['output bukan objek JSON'];
  const tasks = Array.isArray(prd.tasks) ? prd.tasks : [];
  const features = Array.isArray(prd.features) ? prd.features : [];

  if (!Array.isArray(prd.techStack) || prd.techStack.length === 0) {
    problems.push('techStack kosong');
  }
  if (tasks.length < 6) {
    problems.push(`jumlah task terlalu sedikit (${tasks.length}, minimal 6)`);
  }
  if (features.length === 0) {
    problems.push('tidak ada modul fitur');
  }
  if (!prd.architectureOverview || String(prd.architectureOverview).trim().length < 50) {
    problems.push('architectureOverview kosong/terlalu pendek');
  } else if (!/keputusan teknologi/i.test(prd.architectureOverview)) {
    problems.push('architectureOverview tidak diawali alasan "Keputusan teknologi:"');
  }
  if (!prd.summary || !/asumsi/i.test(prd.summary)) {
    problems.push('summary tidak memuat bagian "Asumsi:"');
  }
  if (!prd.summary || !/skala\s*:/i.test(prd.summary)) {
    problems.push('summary tidak menyebut pilihan "Skala:" (kecil/sedang/besar/sangat besar)');
  }

  const taskText = tasks.map(t => `${t.title || ''} ${t.spec || ''} ${t.module || ''}`).join(' ').toLowerCase();

  // Setiap task WAJIB punya field module, dan nama modul harus cocok dengan fitur.
  const featureModules = features.filter(f => f && f.module).map(f => f.module);
  const taskModules = tasks.map(t => (t && t.module ? String(t.module).trim() : ''));
  tasks.forEach((t, i) => {
    if (!t || !t.module || !String(t.module).trim()) {
      problems.push(`task "${(t && t.title) || '#' + (i + 1)}" tidak mengisi field "module"`);
    }
  });

  // Setiap modul fitur wajib punya minimal satu task dengan nama modul sama persis.
  for (const mod of featureModules) {
    const hasExact = taskModules.some(tm => tm.toLowerCase() === mod.toLowerCase());
    if (!hasExact) {
      problems.push(`modul "${mod}" tidak punya task dengan field "module" yang sama persis`);
    }
  }

  for (const f of features) {
    if (!f || !f.module) {
      problems.push('ada fitur tanpa nama modul');
      continue;
    }
    if (!isFeatureCovered(f, taskText)) {
      problems.push(`fitur "${f.module}" tidak punya task implementasi yang jelas`);
    }
  }

  // Design system: kalau aplikasi punya antarmuka, wajib ada modul design system
  // yang isinya nilai konkret, bukan kata sifat.
  const hasUI = featureModules.some(m => /ui|antarmuka|halaman|tampilan|portal|dashboard|frontend|layar/i.test(m));
  if (hasUI) {
    const dsFeature = features.find(f => f && f.module && /design system|desain antarmuka|sistem desain|design token/i.test(f.module));
    if (!dsFeature) {
      problems.push('tidak ada modul "Design System" padahal aplikasi punya antarmuka');
    } else {
      const dsText = JSON.stringify(dsFeature);
      const hexes = dsText.match(/#[0-9a-fA-F]{6}/g) || [];
      if (hexes.length < 6) {
        problems.push(`modul Design System hanya memuat ${hexes.length} warna HEX (butuh minimal 6, disalin dari template)`);
      }
      if (!/reading this as|template|presisi|hangat|kepercayaan|data|utilitas|ekspresif/i.test(dsText)) {
        problems.push('modul Design System tidak menyebut template yang dipilih + alasan');
      }
      if (!/reduced-motion|150|200|250|ms\b/i.test(dsText)) {
        problems.push('modul Design System tidak memuat aturan motion (duration/reduced-motion)');
      }
      // Larangan anti-generik di teks desain.
      if (/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(dsText)) {
        problems.push('modul Design System memakai emoji (dilarang sebagai ikon)');
      }
      if (/\u2014|\u2013/.test(dsText)) {
        problems.push('modul Design System memakai tanda pisah panjang (em-dash/en-dash)');
      }
      if (/\d+\s*(?:px|rem)[^.]*?space/i.test(dsText) === false && !/\b(?:4|8|12|16|24|32|48)\s*px\b/.test(dsText)) {
        problems.push('modul Design System tidak menyebut skala spacing dalam px');
      }
    }
  }

  // Endpoint penting tanpa task.
  const endpoints = Array.isArray(prd.apiEndpoints) ? prd.apiEndpoints : [];
  for (const ep of endpoints) {
    const pathWords = keywords((ep.path || '').replace(/[:/{]/g, ' '));
    if (pathWords.length === 0) continue;
    // Endpoint webhook wajib punya task webhook.
    if (/webhook|callback/i.test(ep.path || '') && !/webhook|callback/i.test(taskText)) {
      problems.push(`endpoint "${ep.method} ${ep.path}" (webhook) tidak punya task penerimaan`);
    }
  }

  return problems;
}

const VALIDATION_RETRY_INSTRUCTION = `

=== PERBAIKAN WAJIB (percobaan sebelumnya DITOLAK) ===
PRD sebelumnya gagal pemeriksaan otomatis karena masalah berikut:
{{PROBLEMS}}

Perbaiki SEMUA masalah di atas. Pastikan untuk SETIAP modul pada "features" ada minimal satu task di "tasks" yang menyebut modul tersebut (isi field "module" pada task dengan nama modul yang sama persis). Setiap integrasi pihak ketiga dan webhook wajib punya task sendiri. Keluarkan JSON lengkap yang sudah diperbaiki.`;

async function callRouter(routerCfg, chosenModel, systemPrompt, userPrompt) {
  const res = await fetch(`${routerCfg.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${routerCfg.apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: chosenModel,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.2
    })
  });
  const rawText = await res.text();
  if (!res.ok) throw new Error(`Router HTTP ${res.status}: ${rawText}`);
  const routerJson = parseRouterResponse(rawText);
  const rawContent = routerJson.choices?.[0]?.message?.content || '{}';
  return JSON.parse(extractJSON(rawContent));
}

export async function generatePRDFromPrompt(userIdea, name, clarifications = [], model) {
  const routerCfg = getRouterConfig();
  const chosenModel = model || routerCfg?.defaultModel || 'oa/gemini-3.8-flash-high';

  let userPrompt = `Project Name: ${name || 'Auto-detect'}\nIde Aplikasi: ${userIdea}\n`;
  if (clarifications && clarifications.length > 0) {
    userPrompt += `\nHASIL KLARIFIKASI & KEPUTUSAN PENGGUNA:\n`;
    clarifications.forEach((c, idx) => {
      userPrompt += `${idx + 1}. Tanya: ${c.question}\n   Keputusan: ${c.answer}\n`;
    });
  }
  userPrompt += `\nBuat PRD dan task breakdown teknis yang sangat mendalam dan lengkap sekarang.`;

  if (routerCfg && routerCfg.apiKey) {
    try {
      console.log(`[AI-PRD] Requesting PRD to OpenAgentic Router (${chosenModel})...`);
      let parsed = await callRouter(routerCfg, chosenModel, DEEP_PRD_SYSTEM_PROMPT, userPrompt);
      let problems = validatePRD(parsed);

      if (problems.length > 0) {
        console.warn(`[AI-PRD] Percobaan 1 ditolak validator: ${problems.join('; ')}`);
        console.log('[AI-PRD] Mengulang sekali dengan instruksi perbaikan...');
        try {
          const retryPrompt = userPrompt + VALIDATION_RETRY_INSTRUCTION.replace('{{PROBLEMS}}', problems.map(p => `- ${p}`).join('\n'));
          const retryParsed = await callRouter(routerCfg, chosenModel, DEEP_PRD_SYSTEM_PROMPT, retryPrompt);
          const retryProblems = validatePRD(retryParsed);
          if (retryProblems.length === 0) {
            parsed = retryParsed;
            problems = [];
            console.log('[AI-PRD] Percobaan 2 lolos validasi.');
          } else {
            console.warn(`[AI-PRD] Percobaan 2 masih bermasalah: ${retryProblems.join('; ')}`);
            problems = retryProblems;
            parsed = retryParsed; // pakai yang terbaru, tapi tetap laporkan
          }
        } catch (retryErr) {
          console.error('[AI-PRD] Percobaan 2 gagal:', retryErr.message);
        }
      }

      if (problems.length > 0) {
        // Jangan simpan PRD cacat diam-diam: user harus tahu apa yang kurang.
        const err = new Error(
          'PRD tersusun tetapi TIDAK lolos pemeriksaan kelengkapan, jadi tidak disimpan. ' +
          'Yang kurang: ' + problems.join('; ') + '. Coba lagi, atau ganti model di pemilih model.'
        );
        err.validationProblems = problems;
        throw err;
      }

      console.log(`[AI-PRD] PRD lolos validasi: ${parsed.tasks?.length || 0} task, ${parsed.features?.length || 0} modul.`);
      return parsed;
    } catch (err) {
      console.error('[AI-PRD] Gagal generate via router:', err.message);
      if (err.validationProblems) throw err; // error validasi diteruskan apa adanya
    }
  }

  // Router offline / gagal. Jangan pernah mengembalikan PRD template palsu:
  // pengguna akan menyangka PRD-nya valid padahal isinya karangan.
  throw new Error(
    'Gagal menyusun PRD: layanan AI (router) tidak bisa dihubungi atau mengembalikan jawaban yang tidak valid.' +
    ' PRD tidak dibuat. Periksa koneksi router dan API key (PRDMAKER_API_KEY / PRDMAKER_BASE_URL), lalu coba lagi.'
  );
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
      "spec": "Spesifikasi implementasi teknis untuk AI Coding Agent"
    }
  ]
}
`;

export async function appendFeatureChange(workspace, existingTasks = [], changeRequest, model) {
  const routerCfg = getRouterConfig();
  const chosenModel = model || routerCfg?.defaultModel || 'oa/gemini-3.8-flash-high';

  const contextPrompt = `
PROJECT NAME: ${workspace.name}
SUMMARY LAMA: ${workspace.summary}
TECH STACK: ${workspace.tech_stack}
TASK YANG SUDAH ADA (${existingTasks.length} task):
${existingTasks.map(t => `- [${t.status}] ${t.id}: ${t.title}`).join('\n')}

PERMINTAAN PERUBAHAN / PENAMBAHAN FITUR DARI PENGGUNA:
"${changeRequest}"

Tugas: Buatkan penambahan fitur dan task eksekusi lanjutan untuk memenuhi permintaan perubahan tersebut.
`;

  if (routerCfg && routerCfg.apiKey) {
    try {
      console.log(`[AI-APPEND] Processing change request via ${chosenModel}...`);
      const res = await fetch(`${routerCfg.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${routerCfg.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: chosenModel,
          messages: [
            { role: 'system', content: APPEND_CHANGE_SYSTEM_PROMPT },
            { role: 'user', content: contextPrompt }
          ],
          temperature: 0.2
        })
      });

      const rawText = await res.text();
      if (!res.ok) throw new Error(`Router HTTP ${res.status}: ${rawText}`);

      const routerJson = parseRouterResponse(rawText);
      const rawContent = routerJson.choices?.[0]?.message?.content || '{}';
      return JSON.parse(extractJSON(rawContent));
    } catch (err) {
      console.error('[AI-APPEND] Error:', err.message);
    }
  }

  // Router offline / gagal. Jangan mengembalikan "task" tempelan yang isinya
  // cuma mengulang permintaan pengguna tanpa spesifikasi nyata.
  throw new Error(
    'Gagal memperbarui PRD: layanan AI (router) tidak bisa dihubungi atau mengembalikan jawaban yang tidak valid.' +
    ' Tidak ada task yang ditambahkan. Periksa koneksi router dan API key, lalu coba lagi.'
  );
}
