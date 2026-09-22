import fs from 'fs';
import os from 'os';
import { join } from 'path';

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
Tugasmu: Menganalisis ide aplikasi dari pengguna dan membuat 3-4 pertanyaan klarifikasi tentang alur kerja produk dan fitur penting yang relevan dengan domain aplikasi tersebut.

PANDUAN GAYA BAHASA (BEGINNER-FRIENDLY):
1. Gunakan Bahasa Indonesia yang santai, jelas, dan manusiawi. HINDARI jargon teknis rumit yang bikin pusing (seperti "CCXT unified API", "HMAC SHA512", "IndexedDB", "Idempotency", dll).
2. Jika ada istilah teknis yang harus disebut, jelaskan fungsinya secara sederhana dalam tanda kurung.
   - Contoh jelek: "Apakah butuh IndexedDB offline persistence?"
   - Contoh bagus: "Apakah aplikasi kasir harus tetap bisa dipakai transaksi saat internet mati/offline?"
3. Pilihan jawaban (options) harus mendeskripsikan keuntungan/efek nyata yang mudah dipahami orang awam.
   - Contoh opsi bagus: "Otomatis kirim ke WhatsApp pembeli (praktis tanpa kertas)", "Cetak kertas struk fisik via printer kasir", "Keduanya bisa dipilih".
4. Opsi pertama selalu berikan tanda "(Rekomendasi Terbaik/Paling Praktis)".

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
Kamu adalah Principal Software Architect & Head of Product (FAANG-grade).
Tugasmu: Menerima ide produk dan hasil klarifikasi tanya-jawab dari user, lalu menyusun Product Requirements Document (PRD) yang SANGAT DETAIL, komprehensif, teknis, dan siap dieksekusi langkah demi langkah oleh AI Coding Agent (Cursor, Claude Code, Cline, dll).

Kamu WAJIB mengembalikan output HANYA berupa JSON murni yang valid tanpa teks pembuka/penutup atau markdown wrappers.

Struktur JSON:
{
  "projectName": "Nama Resmi & Keren Aplikasi",
  "tagline": "Satu kalimat value proposition",
  "summary": "Penjelasan detail latar belakang, problem statement, dan solusi sistem (2-3 paragraf)",
  "techStack": ["Daftar teknologi lengkap beserta alasannya"],
  "architectureOverview": "Penjelasan rinci arsitektur sistem: routing, data flow, state management, dan strategi autentikasi/keamanan",
  "features": [
    {
      "module": "Nama Modul",
      "description": "Deskripsi fungsional lengkap",
      "userStories": ["Sebagai [role], saya ingin [tindakan] sehingga [manfaat]"],
      "acceptanceCriteria": ["Kriteria penerimaan spesifik yang dapat diuji"],
      "edgeCases": ["Kasus ekstrim / error handling yang harus ditangani"]
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
      "description": "Fungsi endpoint",
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
      "spec": "Spesifikasi implementasi sangat detail untuk AI Coding Agent: nama file path yang harus dibuat/diedit, dependensi yang perlu diinstall, logic yang wajib ada, error handling, dan verifikasi test manual/command curl yang harus dieksekusi."
    }
  ]
}

PANDUAN PEMBUATAN TASK:
- Pecah minimal 6 sampai 10 task teknis terurut.
- Sesuaikan PRD secara presisi dengan keputusan/jawaban klarifikasi yang dipilih pengguna.
`;

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

  if (routerCfg && routerCfg.apiKey) {
    try {
      console.log(`[AI-PRD] Requesting PRD to OpenAgentic Router (${chosenModel})...`);
      const res = await fetch(`${routerCfg.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${routerCfg.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: chosenModel,
          messages: [
            { role: 'system', content: DEEP_PRD_SYSTEM_PROMPT },
            { role: 'user', content: `${userPrompt}\nBuat PRD dan task breakdown teknis yang sangat mendalam dan lengkap sekarang.` }
          ],
          temperature: 0.2
        })
      });

      const rawText = await res.text();
      if (!res.ok) throw new Error(`Router HTTP ${res.status}: ${rawText}`);

      const routerJson = parseRouterResponse(rawText);
      const rawContent = routerJson.choices?.[0]?.message?.content || '{}';
      
      const cleanJsonString = extractJSON(rawContent);
      const parsed = JSON.parse(cleanJsonString);
      console.log(`[AI-PRD] Successfully generated PRD with ${parsed.tasks?.length || 0} tasks using [${chosenModel}]!`);
      return parsed;
    } catch (err) {
      console.error('[AI-PRD] Failed to generate via OpenAgentic Router:', err.message);
    }
  }

  // Fallback jika router offline
  const cleanName = name || (userIdea.length > 20 ? userIdea.substring(0, 20) + "..." : userIdea);
  return {
    projectName: cleanName,
    tagline: `Solusi modern untuk ${cleanName}`,
    summary: `Project spec & breakdown untuk: "${userIdea}"`,
    techStack: ["Node.js", "SQLite", "TailwindCSS"],
    architectureOverview: "Arsitektur client-server dengan API RESTful dan database SQLite.",
    features: [
      {
        module: "Core",
        description: "Fitur utama dari aplikasi",
        userStories: ["Sebagai pengguna, saya ingin menggunakan aplikasi dengan lancar"],
        acceptanceCriteria: ["Aplikasi merespons < 200ms"],
        edgeCases: ["Koneksi putus"]
      }
    ],
    tasks: [
      {
        id: "TASK-01",
        title: "Setup Inisialisasi Project & Core Storage",
        spec: `Buat struktur folder project dan database schema untuk ide: ${userIdea}.`
      },
      {
        id: "TASK-02",
        title: "Implementasi REST API & Business Logic",
        spec: "Buat endpoint API CRUD utama untuk mengolah data sesuai kebutuhan fitur utama."
      },
      {
        id: "TASK-03",
        title: "Desain Dashboard UI & User Experience",
        spec: "Buat halaman antarmuka web yang responsif dengan status indikator."
      },
      {
        id: "TASK-04",
        title: "Integrasi Testing & Auto Verification",
        spec: "Tuliskan test automation/script verifikasi untuk memastikan semua fungsi berjalan."
      }
    ]
  };
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

  // Fallback
  return {
    changeSummary: `Penambahan fitur: "${changeRequest}"`,
    newTasks: [
      {
        id: "TASK-APPEND-01",
        title: `Implementasi Fitur Tambahan: ${changeRequest.substring(0, 30)}`,
        spec: `Integrasikan perubahan berikut ke dalam sistem: ${changeRequest}`
      }
    ]
  };
}
