import assert from 'node:assert/strict';
import fs from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');

import {
  escapeRawControlChars,
  extractJSON,
  fetchAvailableModels,
  generateClarifications,
  generatePRDFromPrompt,
  normalizePRDFields,
  stripForeignFragments,
  validatePRD
} from '../src/ai-prd.js';
import { skeleton as uiSkeleton, tasks as uiTasks, clarification } from './fixtures/prd.js';

const originalFetch = globalThis.fetch;
const originalEnv = {
  key: process.env.PRDMAKER_API_KEY,
  base: process.env.PRDMAKER_BASE_URL,
  model: process.env.PRDMAKER_MODEL,
  config: process.env.PRDMAKER_CONFIG
};

function restoreEnv() {
  for (const [key, value] of [
    ['PRDMAKER_API_KEY', originalEnv.key],
    ['PRDMAKER_BASE_URL', originalEnv.base],
    ['PRDMAKER_MODEL', originalEnv.model],
    ['PRDMAKER_CONFIG', originalEnv.config]
  ]) value == null ? delete process.env[key] : process.env[key] = value;
}

function completion(content, finishReason = 'stop') {
  return new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify(content) }, finish_reason: finishReason }]
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function mockQueue(responses, models = [{ id: 'oa/gpt-6-astra' }, { id: 'oa/mimo-v2.6-flash' }]) {
  // Ratakan: beberapa helper (schemaOf) menyumbang lebih dari satu respons.
  // Tuple [payload, finishReason] TIDAK diratakan (itu satu respons ber-flag).
  responses = responses.flatMap(r => (Array.isArray(r) && !(r.length === 2 && typeof r[1] === 'string')) ? r : [r]);
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    if (url.endsWith('/models')) {
      return new Response(JSON.stringify({ data: models }), { status: 200 });
    }
    calls.push({ url, body: JSON.parse(options.body) });
    // Respons terakhir diulang: rantai fallback membuat jumlah panggilan
    // berbeda-beda, jadi antrean kaku akan rapuh. Mock berlaku seperti penyedia
    // yang selalu menjawab sama.
    const next = responses.length > 1 ? responses.shift() : responses[0];
    if (next === undefined) throw new Error('unexpected provider request');
    if (next instanceof Error) throw next;
    // Bentuk tuple [payload, finishReason] untuk menguji keluaran terpotong.
    if (Array.isArray(next) && next.length === 2 && typeof next[1] === 'string') {
      return completion(next[0], next[1]);
    }
    return completion(next);
  };
  return calls;
}

const validUI = { ...uiSkeleton, tasks: uiTasks };
const identityOf = (s) => ({ projectName: s.projectName, tagline: s.tagline, summary: s.summary });
const coreOf = (s) => ({ techStack: s.techStack, architectureOverview: s.architectureOverview });
// Tahap rinci = 3 panggilan fokus (fitur, skema data, kontrak API). Helper ini
// menyumbang ketiganya berurutan supaya antrean mock cocok dengan alur nyata.
const detailOf = (s) => [{ features: s.features }, { databaseSchema: s.databaseSchema }, { apiEndpoints: s.apiEndpoints }];
const featuresOf = (s) => ({ features: s.features });
const dbOf = (s) => ({ databaseSchema: s.databaseSchema });
const apiOf = (s) => ({ apiEndpoints: s.apiEndpoints });
// Tahap skema dipecah DB lalu API (lihat src/ai-prd.js): helper mengembalikan
// DUA respons berurutan sehingga antrean mock tetap cocok tanpa tiap test
// menyebut dua entri manual.
const schemaOf = (s) => [dbOf(s), apiOf(s)];

const coreText = (value) => JSON.stringify(value).toLowerCase();

try {
  await test('model discovery trusts provider list and admits advertised Astra', async () => {
    process.env.PRDMAKER_API_KEY = 'offline-test-key';
    process.env.PRDMAKER_BASE_URL = 'http://provider.invalid/v1';
    process.env.PRDMAKER_CONFIG = '/does/not/exist';
    const calls = mockQueue([], [
      { id: 'oa/gpt-6-astra' },
      { id: 'oa/mimo-v2.6-flash' },
      { id: 'ali-vision-image' },
      { id: 'oa/text-embedding' }
    ]);
    const models = await fetchAvailableModels();
    assert.deepEqual(models, ['oa/gpt-6-astra', 'oa/mimo-v2.6-flash']);
    assert.equal(calls.length, 0);
  });

  await test('provider default is used verbatim, never advertised as a hardcoded fallback', async () => {
    process.env.PRDMAKER_API_KEY = 'offline-test-key';
    process.env.PRDMAKER_BASE_URL = 'http://provider.invalid/v1';
    process.env.PRDMAKER_MODEL = 'oa/gpt-6-astra';
    process.env.PRDMAKER_CONFIG = '/does/not/exist';
    mockQueue([identityOf(uiSkeleton), coreOf(uiSkeleton), detailOf(uiSkeleton), { tasks: uiTasks }]);
    const result = await generatePRDFromPrompt('Arsip surat', 'Arsip Surat', [
      { question: 'Pengguna?', answer: 'Lima petugas' }
    ]);
    assert.equal(result.projectName, 'Arsip Surat');
  });

  await test('detail stage is split into three focused calls capped at 7000 tokens', async () => {
    // Regresi nyata: gabungan fitur+db+api butuh 5400-7000+ token dan terpotong
    // di plafon 7000; max_tokens 8000+ membuat router menjawab 502. Skema DB dan
    // kontrak API juga dipecah jadi dua panggilan: gabungan db+api (~4300 token)
    // terukur menggantung >249 detik lalu 502 di luna, sedangkan terpisah hanya
    // 11-112 detik. Jadi rinci = 3 panggilan fokus (fitur, db, api).
    process.env.PRDMAKER_API_KEY = 'offline-test-key';
    process.env.PRDMAKER_BASE_URL = 'http://provider.invalid/v1';
    process.env.PRDMAKER_MODEL = 'oa/gpt-6-astra';
    process.env.PRDMAKER_CONFIG = '/does/not/exist';
    const calls = mockQueue([identityOf(uiSkeleton), coreOf(uiSkeleton), featuresOf(uiSkeleton), schemaOf(uiSkeleton), { tasks: uiTasks }]);
    await generatePRDFromPrompt('Arsip surat', 'Arsip Surat', [], 'oa/gpt-6-astra');
    // 6 panggilan: identitas, stack, fitur, skema data, kontrak API, tasks.
    assert.equal(calls.length, 6);
    assert.ok(calls.every(c => c.body.max_tokens === 7000), 'plafon harus 7000, bukan 16000');
    // Tiap tahap rinci meminta tepat satu kunci (fitur / databaseSchema / apiEndpoints).
    assert.match(calls[2].body.messages[0].content, /tepat satu kunci/);
    assert.match(calls[3].body.messages[0].content, /databaseSchema/);
    assert.match(calls[4].body.messages[0].content, /apiEndpoints/);
    // Prompt skema & API menerima daftar modul supaya mendukung fitur.
    assert.match(calls[3].body.messages[1].content, /Daftar modul fitur/);
    assert.match(calls[4].body.messages[1].content, /Daftar modul fitur/);
  });

  await test('two-stage flow uses selected model only and validates before task stage', async () => {
    process.env.PRDMAKER_API_KEY = 'offline-test-key';
    process.env.PRDMAKER_BASE_URL = 'http://provider.invalid/v1';
    process.env.PRDMAKER_MODEL = 'oa/gpt-6-astra';
    process.env.PRDMAKER_CONFIG = '/does/not/exist';
    const calls = mockQueue([identityOf(uiSkeleton), coreOf(uiSkeleton), detailOf(uiSkeleton), { tasks: uiTasks }]);
    const result = await generatePRDFromPrompt('Arsip surat', 'Arsip Surat', [], 'oa/gpt-6-astra');
    assert.equal(result.tasks.length, uiTasks.length);
    assert.equal(result.projectName, 'Arsip Surat');
    // Tahap 1 dipecah empat panggilan (identitas, stack, fitur, skema); semua
    // tetap model yang dipilih.
    assert.deepEqual(calls.map(c => c.body.model), ['oa/gpt-6-astra', 'oa/gpt-6-astra', 'oa/gpt-6-astra', 'oa/gpt-6-astra', 'oa/gpt-6-astra', 'oa/gpt-6-astra']);
    assert.ok(calls.every(c => c.body.response_format.type === 'json_object'));
    assert.match(calls[0].body.messages[0].content, /projectName/);
    assert.doesNotMatch(calls[0].body.messages[0].content, /apiEndpoints/);
    assert.match(calls[1].body.messages[0].content, /architectureOverview/);
    // Fitur dan skema kini dipanggil terpisah karena gabungan terpotong di plafon token.
    assert.match(calls[2].body.messages[0].content, /features/);
    assert.match(calls[3].body.messages[0].content, /databaseSchema/);
    // Kontrak desain hanya sekali, di panggilan arsitektur.
    assert.equal((calls[1].body.messages[0].content.match(/KONTRAK DESAIN ANTI AI-SLOP/g) || []).length, 1);
    assert.doesNotMatch(calls[2].body.messages[0].content, /KONTRAK DESAIN ANTI AI-SLOP/);
    assert.match(calls[4].body.messages[0].content, /(?:CLI|bot|API|library).*(?:tanpa UI|tanpa antarmuka)/iu);
  });

  await test('task IDs written as T-1 or bare digits are normalised to TASK-01', () => {
    // Regresi nyata: model menulis ID "T-01".."T-12", dan validator menolak
    // semuanya dengan "ID task T-10 tidak valid atau duplikat".
    const norm = (ids) => normalizePRDFields({
      tasks: ids.map(id => ({ id, title: 'x', module: 'M', spec: 'Tujuan: a\nFile: b.js\nDependensi: tidak ada\nImplementasi: c\nError/edge case: d\nKriteria selesai: e\nVerifikasi: f' }))
    }).tasks.map(t => t.id);
    assert.deepEqual(norm(['T-1', 'T-2', 'T-10']), ['TASK-01', 'TASK-02', 'TASK-10']);
    assert.deepEqual(norm(['T1', 'T2']), ['TASK-01', 'TASK-02']);
    assert.deepEqual(norm(['TASK-03', 'TASK-04']), ['TASK-03', 'TASK-04']);
    // ID kosong diberi nomor urut, bukan dibiarkan.
    assert.deepEqual(normalizePRDFields({ tasks: [{ title: 'x', module: 'M' }] }).tasks.map(t => t.id), ['TASK-01']);
  });

  await test('abbreviated model field names are mapped, real values are not overwritten', () => {
    // Regresi nyata: fitur memakai "acceptance" alih-alih "acceptanceCriteria",
    // sehingga 7 fitur yang isinya lengkap dianggap tanpa kriteria.
    const f = normalizePRDFields({ features: [{ id: 'x', name: 'Autentikasi', description: 'd', acceptance: ['gagal 401', 'ok'] }] });
    assert.equal(f.features[0].module, 'Autentikasi');
    assert.deepEqual(f.features[0].acceptanceCriteria, ['gagal 401', 'ok']);
    // Task memakai "description" alih-alih "spec".
    const t = normalizePRDFields({ tasks: [{ id: 'TASK-01', name: 'Auth', description: 'Kerjakan X.' }] });
    assert.equal(t.tasks[0].module, 'Auth');
    assert.equal(t.tasks[0].spec, 'Kerjakan X.');
    // Nilai yang sudah benar tidak ditimpa.
    const kept = normalizePRDFields({ features: [{ module: 'A', acceptanceCriteria: ['x', 'y'], acceptance: ['z'] }] });
    assert.deepEqual(kept.features[0].acceptanceCriteria, ['x', 'y']);
    const keptTask = normalizePRDFields({ tasks: [{ id: 'T1', module: 'A', spec: 'asli', description: 'lain' }] });
    assert.equal(keptTask.tasks[0].spec, 'asli');
  });

  await test('extractJSON takes the first balanced object, not first-brace-to-last', () => {
    // Regresi nyata: model mengeluarkan dua objek JSON berurutan, dan potongan
    // "{" pertama sampai "}" terakhir menyeberangi keduanya lalu gagal parse.
    const two = '{"table": "users", "fields": ["a"]}\n{"table": "surat", "fields": ["b"]}';
    assert.deepEqual(JSON.parse(extractJSON(two)), { table: 'users', fields: ['a'] });
    // "}" di dalam string tidak boleh dihitung sebagai penutup objek.
    const braces = '{"summary": "pakai } sebagai penutup", "n": 1}';
    assert.equal(JSON.parse(extractJSON(braces)).n, 1);
    // &#123; bersarang tetap diambil utuh.
    const nested = 'teks pembuka {"a": {"b": [1, 2]}, "c": "x"} teks penutup';
    assert.deepEqual(JSON.parse(extractJSON(nested)), { a: { b: [1, 2] }, c: 'x' });
    // Kutip yang di-escape tidak membalik status string.
    const quoted = '{"a": "kata \\"kutip\\" di sini", "b": 2}';
    assert.equal(JSON.parse(extractJSON(quoted)).b, 2);
  });

  await test('normal prose repetition is not mistaken for token corruption', () => {
    // Regresi nyata: "petugas, petugas" dan "backup 'backup" adalah bahasa
    // Indonesia biasa, tapi regex lama menandainya rusak sehingga PRD lengkap
    // (6 modul, Design System ada) ditolak.
    const prd = { ...structuredClone(uiSkeleton) };
    prd.summary = uiSkeleton.summary + ' Dicatat oleh petugas, petugas lain memverifikasi.';
    prd.architectureOverview = uiSkeleton.architectureOverview + " Backup via sqlite3 arsip.db \".backup 'backup/arsip.db'\".";
    assert.ok(!validatePRD(prd, 'skeleton').some(p => /terputus atau rusak/i.test(p)), JSON.stringify(validatePRD(prd, 'skeleton')));
    // Korupsi nyata tetap terdeteksi.
    for (const bad of [' UEUEUEUEUEUEUE', ' yang做 hal sama', ' запuselageUEUEUEUEUEUE']) {
      const broken = { ...structuredClone(uiSkeleton), summary: uiSkeleton.summary + bad };
      assert.ok(validatePRD(broken, 'skeleton').some(p => /terputus atau rusak/i.test(p)), JSON.stringify(bad));
    }
  });

  await test('HTTP status codes and negative phrasing count as failure coverage', () => {
    // Regresi nyata: "Petugas yang mencoba menghapus mendapat 403" dan "Sesi
    // yang sudah logout tidak bisa dipakai ulang" sama-sama menguji alur gagal,
    // tetapi tidak memakai kata yang ada di daftar, sehingga PRD ditolak.
    const base = () => ({
      module: 'Contoh', description: 'd', userStories: ['x'],
      acceptanceCriteria: ['Aksi berhasil.', 'Petugas yang mencoba menghapus mendapat 403.'],
      edgeCases: []
    });
    const prd = { ...structuredClone(uiSkeleton), features: [base()] };
    assert.ok(!validatePRD(prd, 'skeleton').some(p => /alur gagal/i.test(p)), JSON.stringify(validatePRD(prd, 'skeleton')));

    const negative = base();
    negative.acceptanceCriteria = ['Aksi berhasil.', 'Sesi yang sudah logout tidak bisa dipakai ulang.'];
    const prd2 = { ...structuredClone(uiSkeleton), features: [negative] };
    assert.ok(!validatePRD(prd2, 'skeleton').some(p => /alur gagal/i.test(p)));

    // Fitur yang benar-benar hanya berisi alur bahagia tetap ditolak.
    const happy = base();
    happy.acceptanceCriteria = ['Tabel dirender di server.', 'Pagination 50 baris per halaman.'];
    const prd3 = { ...structuredClone(uiSkeleton), features: [happy] };
    assert.ok(validatePRD(prd3, 'skeleton').some(p => /alur gagal/i.test(p)));
  });

  await test('raw control characters inside JSON strings are escaped, not fatal', () => {
    // Regresi nyata: model menulis newline MENTAH di dalam string JSON,
    // sehingga seluruh PRD hilang dengan "Bad control character in string
    // literal" padahal isinya benar.
    const broken = '{"summary": "Baris satu\n  baris dua dengan\ttab", "techStack": ["a"]}';
    assert.throws(() => JSON.parse(broken));
    const fixed = JSON.parse(escapeRawControlChars(broken));
    assert.equal(fixed.summary, 'Baris satu\n  baris dua dengan\ttab');
    // Struktur JSON di luar string tidak boleh ikut di-escape.
    const ok = '{\n  "a": 1,\n  "b": [2, 3]\n}';
    assert.deepEqual(JSON.parse(escapeRawControlChars(ok)), { a: 1, b: [2, 3] });
    // extractJSON memakainya untuk keluaran mentah model.
    assert.equal(JSON.parse(extractJSON('```json\n{"x": "a\nb"}\n```')).x, 'a\nb');
  });

  await test('Design System checks accept Indonesian terms for UI states', () => {
    // Regresi nyata: modul Design System menulis "skeleton ... saat memuat",
    // "blok kosong", "blok gagal merah", tapi validator hanya mengenal istilah
    // Inggris sehingga menolak PRD yang sudah benar.
    const ds = {
      module: 'Design System',
      description: 'Token --bg #F7F6F2, --surface #FFFFFF, --accent #1F5F4B. Kontras 12:1. Font Inter 16px bobot 400 line-height 1.5. Spacing 8px/16px, radius 6px, border 1px. Input punya label terprogram dan focus ring.',
      userStories: ['x'],
      acceptanceCriteria: [
        'State UI lengkap: skeleton abu-abu saat memuat, blok kosong dengan teks "Tidak ada surat yang cocok", dan blok gagal merah dengan tombol muat ulang.',
        'Semua input punya <label> terprogramatik dan kontras teks di atas permukaan minimal 4.5:1.'
      ],
      edgeCases: ['Viewport 320px tidak overflow']
    };
    const prd = { ...structuredClone(uiSkeleton), features: [ds] };
    const problems = validatePRD(prd, 'skeleton');
    assert.ok(!problems.some(p => /state UI penting/i.test(p)), JSON.stringify(problems));
    assert.ok(!problems.some(p => /typography/i.test(p)), JSON.stringify(problems));
  });

  await test('a foreign-script fragment is stripped instead of voiding a good PRD', () => {
    // Regresi nyata: PRD dengan 5 modul, 5 acceptanceCriteria, dan 3 edgeCases
    // per modul ditolak hanya karena dua kata bocor: "surat,死的/kategori" dan
    // "dengan工具 terpisah".
    assert.equal(
      stripForeignFragments('metadata bertipe pilihan (jenis surat,死的/kategori, tujuan)'),
      'metadata bertipe pilihan (jenis surat, kategori, tujuan)'
    );
    assert.equal(
      stripForeignFragments('diinstrumentasi dengan工具 terpisah: satu tabel'),
      'diinstrumentasi dengan terpisah: satu tabel'
    );
    // Setelah dibersihkan, PRD yang isinya benar harus lolos.
    const prd = normalizePRDFields({
      ...structuredClone(uiSkeleton),
      summary: uiSkeleton.summary + ' Catatan死的 tambahan untuk konteks.',
      architectureOverview: uiSkeleton.architectureOverview + ' Diukur dengan工具 internal.'
    });
    assert.ok(!validatePRD(prd, 'skeleton').some(p => /terputus atau rusak/i.test(p)));
    // Teks yang benar-benar rusak (token berulang) tetap ditolak.
    const repeated = { ...structuredClone(uiSkeleton), summary: uiSkeleton.summary + ' UEUEUEUEUEUEUE' };
    assert.ok(validatePRD(repeated, 'skeleton').some(p => /terputus atau rusak/i.test(p)));
  });

  await test('field names drifted by the model are normalised, values still validated', () => {
    // Bentuk nyata dari live run: fitur memakai "name"/"id" alih-alih "module".
    const drifted = { features: [{ id: 'auth-session', name: 'Login Sesi', description: 'd', acceptanceCriteria: ['a', 'b'] }] };
    const fixed = normalizePRDFields(drifted);
    assert.equal(fixed.features[0].module, 'Login Sesi');
    // Nilai asli tidak ditimpa kalau module sudah ada.
    assert.equal(normalizePRDFields({ features: [{ module: 'Arsip' }] }).features[0].module, 'Arsip');
    // Task ikut dinormalisasi.
    assert.equal(normalizePRDFields({ tasks: [{ id: 'TASK-01', name: 'Auth', spec: 'x' }] }).tasks[0].module, 'Auth');
  });

  await test('the detail stage is told the Design System module is mandatory', async () => {
    // Regresi: syarat modul Design System dulu hanya ada di tahap arsitektur,
    // padahal yang menulis features adalah tahap rincian.
    const calls = mockQueue([identityOf(uiSkeleton), coreOf(uiSkeleton), detailOf(uiSkeleton), { tasks: uiTasks }]);
    await generatePRDFromPrompt('Dashboard arsip', 'Arsip', [], 'oa/space-bunny-free');
    const detailSystem = calls[2].body.messages[0].content;
    assert.match(detailSystem, /SYARAT MODUL "Design System"/);
    assert.match(detailSystem, /bernama persis "Design System"/);
    assert.match(detailSystem, /CLI\/bot\/library tanpa antarmuka, modul ini DILARANG/);
    // Tahap arsitektur tetap membawa kontrak craft penuh.
    assert.match(calls[1].body.messages[0].content, /KONTRAK DESAIN ANTI AI-SLOP/);
  });

  await test('a worse repair keeps the first detail, and the PRD still lands', async () => {
    process.env.PRDMAKER_API_KEY = 'offline-test-key';
    process.env.PRDMAKER_BASE_URL = 'http://provider.invalid/v1';
    process.env.PRDMAKER_MODEL = 'oa/gpt-6-astra';
    process.env.PRDMAKER_CONFIG = '/does/not/exist';
    // Percobaan pertama gagal hanya pada bagian PROSA (ringkasan tanpa batas
    // lingkup); rincian pertama sudah benar. Perbaikan prosa menjawab, sedangkan
    // rincian TIDAK boleh ikut diulang atau ditimpa.
    const weakSummary = { ...identityOf(uiSkeleton), summary: 'Terlalu pendek.' };
    const calls = mockQueue([
      weakSummary, coreOf(uiSkeleton), featuresOf(uiSkeleton), schemaOf(uiSkeleton),
      // Perbaikan prosa mengembalikan identitas yang benar + core.
      { ...identityOf(uiSkeleton), ...coreOf(uiSkeleton) },
      { tasks: uiTasks }
    ]);
    const result = await generatePRDFromPrompt('Arsip surat', 'Arsip Surat', [], 'oa/gpt-6-astra');
    // Rincian asli dipertahankan: nama modul utuh dan jumlah fitur tidak berubah.
    assert.deepEqual(result.features.map(f => f.module), uiSkeleton.features.map(f => f.module));
    assert.equal(result.tasks.length, uiTasks.length);
    // Fitur/skema sudah benar, jadi tidak boleh ada panggilan perbaikan rincian.
    assert.ok(!calls.some(c => /Perbaiki features/i.test(c.body.messages[1].content)));
    assert.ok(!calls.some(c => /Perbaiki databaseSchema/i.test(c.body.messages[1].content)));
  });

  await test('tasks context is trimmed to what the stage needs', async () => {
    process.env.PRDMAKER_API_KEY = 'offline-test-key';
    process.env.PRDMAKER_BASE_URL = 'http://provider.invalid/v1';
    process.env.PRDMAKER_MODEL = 'oa/gpt-6-astra';
    process.env.PRDMAKER_CONFIG = '/does/not/exist';
    // Konteks tasks yang membengkak membuat generasi lambat dan tidak stabil
    // (terukur 55s-178s untuk input identik, mepet batas upstream 249s).
    // Bagian yang tidak dipakai validator tasks tidak boleh ikut terkirim.
    const calls = mockQueue([identityOf(uiSkeleton), coreOf(uiSkeleton), featuresOf(uiSkeleton), schemaOf(uiSkeleton), { tasks: uiTasks }]);
    await generatePRDFromPrompt('Arsip surat', 'Arsip Surat', [], 'oa/gpt-6-astra');
    const tasksUser = calls[5].body.messages[1].content;
    // Yang WAJIB ada: nama modul, tabel, dan endpoint untuk coverage task.
    for (const f of uiSkeleton.features) assert.ok(tasksUser.includes(f.module), 'modul harus ada di konteks tasks: ' + f.module);
    for (const t of uiSkeleton.databaseSchema) assert.ok(tasksUser.includes(t.table), 'tabel harus ada: ' + t.table);
    for (const e of uiSkeleton.apiEndpoints) assert.ok(tasksUser.includes(e.path), 'endpoint harus ada: ' + e.path);
    // Yang TIDAK boleh ada: prosa panjang yang tidak dipakai tahap tasks.
    assert.ok(!tasksUser.includes(uiSkeleton.architectureOverview), 'arsitektur penuh tidak boleh dikirim ke tahap tasks');
    assert.ok(tasksUser.length < uiSkeleton.architectureOverview.length + uiSkeleton.summary.length + 4000,
      'konteks tasks harus lebih ramping dari skeleton penuh: ' + tasksUser.length);
  });

  await test('a tasks-stage failure reuses the good skeleton on the next model', async () => {
    process.env.PRDMAKER_API_KEY = 'offline-test-key';
    process.env.PRDMAKER_BASE_URL = 'http://provider.invalid/v1';
    process.env.PRDMAKER_MODEL = 'oa/gpt-6-astra';
    process.env.PRDMAKER_CONFIG = '/does/not/exist';
    // Skeleton sukses di model pertama, tapi tasks-nya rusak. Model cadangan
    // harus hanya menulis tasks: kerangka yang sudah benar tidak boleh diulang
    // (itu yang dulu membuat satu generate terasa 4+ menit).
    const calls = [];
    globalThis.fetch = async (url, options = {}) => {
      if (url.endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'oa/mimo-v2.6-flash' }] }), { status: 200 });
      const body = JSON.parse(options.body);
      calls.push(body);
      const prompt = body.messages[0].content;
      if (prompt.includes('"projectName"')) return completion(identityOf(uiSkeleton));
      if (prompt.includes('architectureOverview')) return completion(coreOf(uiSkeleton));
      if (prompt.includes('"features"')) return completion(featuresOf(uiSkeleton));
      if (prompt.includes('apiEndpoints')) return completion(apiOf(uiSkeleton));
      if (prompt.includes('databaseSchema')) return completion(dbOf(uiSkeleton));
      // tasks: model pertama menjawab kosong, cadangan menjawab benar.
      if (body.model === 'oa/gpt-6-astra') return completion({ tasks: [] });
      return completion({ tasks: uiTasks });
    };
    const result = await generatePRDFromPrompt('Arsip surat', 'Arsip Surat', [], '');
    assert.equal(result.tasks.length, uiTasks.length);
    // Tahap 1 hanya ditulis sekali (4 panggilan) meski dua model dipakai.
    const stageOneCalls = calls.filter(c => /"projectName"|"features"|databaseSchema/.test(c.messages[0].content));
    assert.equal(stageOneCalls.length, 3, 'identitas+fitur+skema harus sekali saja: ' + stageOneCalls.length);
    // Penanda unik prompt tasks: prompt inti teknis juga menyebut "Lead Engineer".
    // tasks boleh di-retry internal, yang penting KEDUA model mencobanya dan
    // kerangka tidak pernah ditulis ulang.
    const taskCalls = calls.filter(c => c.messages[0].content.includes('dari kerangka PRD'));
    // Cadangan berikutnya dalam rantai tetap space-bunny (rantai tidak
    // dipengaruhi isi /models), dan tahap 1 tidak boleh diulang model cadangan.
    assert.deepEqual([...new Set(taskCalls.map(c => c.model))], ['oa/gpt-6-astra', 'oa/space-bunny-free']);
    assert.ok(stageOneCalls.every(c => c.model === 'oa/gpt-6-astra'), 'tahap 1 tidak boleh diulang model cadangan');
  });

  await test('an explicitly chosen model is pinned: no fallback chain', async () => {
    process.env.PRDMAKER_API_KEY = 'offline-test-key';
    process.env.PRDMAKER_BASE_URL = 'http://provider.invalid/v1';
    process.env.PRDMAKER_MODEL = 'oa/gpt-6-astra';
    process.env.PRDMAKER_CONFIG = '/does/not/exist';
    // Pengguna memilih luna; ruang lingkup permintaan: HANYA luna yang dipakai.
    // Gagal pun tidak boleh diam-diam pindah ke space-bunny/mimo/deepseek.
    const tried = [];
    globalThis.fetch = async (url, options = {}) => {
      if (url.endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'oa/gpt-6-luna' }] }), { status: 200 });
      tried.push(JSON.parse(options.body).model);
      return new Response(JSON.stringify({ error: 'down' }), { status: 500 });
    };
    await assert.rejects(
      () => generatePRDFromPrompt('Arsip surat', 'Arsip Surat', [], 'oa/gpt-6-luna'),
      /layanan AI/i
    );
    assert.deepEqual([...new Set(tried)], ['oa/gpt-6-luna'], 'model lain tidak boleh dicoba saat pengguna memilih model: ' + tried.join(','));
  });

  await test('Default model (no explicit pick) falls back to the measured chain, and the PRD still lands', async () => {
    process.env.PRDMAKER_API_KEY = 'offline-test-key';
    process.env.PRDMAKER_BASE_URL = 'http://provider.invalid/v1';
    process.env.PRDMAKER_MODEL = 'oa/gpt-6-astra';
    process.env.PRDMAKER_CONFIG = '/does/not/exist';
    // Model pertama menolak semua tahap; model kedua di rantai mengerjakan
    // seluruh tahap dengan benar.
    globalThis.fetch = async (url, options = {}) => {
      if (url.endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'oa/mimo-v2.6-flash' }] }), { status: 200 });
      const body = JSON.parse(options.body);
      const prompt = body.messages[0].content;
      const chosenFirst = body.model === 'oa/gpt-6-astra';
      if (chosenFirst) return new Response(JSON.stringify({ error: 'down' }), { status: 500 });
      if (prompt.includes('apiEndpoints')) return completion(apiOf(uiSkeleton));
      if (prompt.includes('databaseSchema')) return completion(dbOf(uiSkeleton));
      if (prompt.includes('tepat dua kunci')) return completion(coreOf(uiSkeleton));
      if (prompt.includes('"features"')) return completion(featuresOf(uiSkeleton));
      if (prompt.includes('"projectName"')) return completion(identityOf(uiSkeleton));
      return completion({ tasks: uiTasks });
    };
    const result = await generatePRDFromPrompt('Arsip surat', 'Arsip Surat', [], '');
    assert.equal(result.tasks.length, uiTasks.length);
    assert.ok(result.features.length > 0);
  });

  await test('Default model: when every model in the chain fails, the user gets a friendly message, not raw provider text', async () => {
    process.env.PRDMAKER_API_KEY = 'offline-test-key';
    process.env.PRDMAKER_BASE_URL = 'http://provider.invalid/v1';
    process.env.PRDMAKER_MODEL = 'oa/gpt-6-astra';
    process.env.PRDMAKER_CONFIG = '/does/not/exist';
    let tried = 0;
    globalThis.fetch = async (url, options = {}) => {
      if (url.endsWith('/models')) return new Response(JSON.stringify({ data: [] }), { status: 200 });
      tried++;
      return new Response(JSON.stringify({ error: { code: 'provider_request_failed', message: 'SECRET-UPSTREAM-DETAIL' } }), { status: 503 });
    };
    await assert.rejects(
      () => generatePRDFromPrompt('Arsip surat', 'Arsip Surat', [], ''),
      (err) => {
        assert.ok(!/SECRET-UPSTREAM-DETAIL/.test(err.message), 'detail penyedia tidak boleh bocor: ' + err.message);
        assert.match(err.message, /layanan AI/i);
        return true;
      }
    );
    // Ketiga model di rantai benar-benar dicoba.
    assert.ok(tried >= 3, 'harus mencoba seluruh rantai, tercatat: ' + tried);
  });

  await test('a stage answered with the previous stage shape is retried, not trusted', async () => {
    process.env.PRDMAKER_API_KEY = 'offline-test-key';
    process.env.PRDMAKER_BASE_URL = 'http://provider.invalid/v1';
    process.env.PRDMAKER_MODEL = 'oa/gpt-6-astra';
    process.env.PRDMAKER_CONFIG = '/does/not/exist';
    // Tahap fitur dibalas dengan bentuk tahap stack: kunci hilang meski HTTP 200.
    const calls = mockQueue([
      identityOf(uiSkeleton),
      coreOf(uiSkeleton),
      coreOf(uiSkeleton),
      featuresOf(uiSkeleton),
      schemaOf(uiSkeleton),
      { tasks: uiTasks }
    ]);
    const result = await generatePRDFromPrompt('Arsip surat', 'Arsip Surat', [], 'oa/gpt-6-astra');
    assert.deepEqual(result.features.map(f => f.module), uiSkeleton.features.map(f => f.module));
    // 7 panggilan: identitas, stack, fitur(gagal), fitur(retry), skema data, kontrak API, tasks.
    assert.equal(calls.length, 7);
    assert.match(calls[3].body.messages[1].content, /Ulangi khusus tahap fitur/);
  });

  await test('a permanently shape-wrong stage names the missing fields and blames the model', async () => {
    process.env.PRDMAKER_API_KEY = 'offline-test-key';
    process.env.PRDMAKER_BASE_URL = 'http://provider.invalid/v1';
    process.env.PRDMAKER_MODEL = 'oa/gpt-6-astra';
    process.env.PRDMAKER_CONFIG = '/does/not/exist';
    mockQueue([
      identityOf(uiSkeleton),
      coreOf(uiSkeleton),
      coreOf(uiSkeleton),
      coreOf(uiSkeleton)
    ]);
    await assert.rejects(
      () => generatePRDFromPrompt('Arsip surat', 'Arsip Surat', [], 'oa/gpt-6-astra'),
      /kelemahan model, bukan kesalahan Anda/
    );
  });

  await test('truncated output is retried as a token-budget problem, not blamed on the model', async () => {
    process.env.PRDMAKER_API_KEY = 'offline-test-key';
    process.env.PRDMAKER_BASE_URL = 'http://provider.invalid/v1';
    process.env.PRDMAKER_MODEL = 'oa/gpt-6-astra';
    process.env.PRDMAKER_CONFIG = '/does/not/exist';
    // Urutan nyata: identitas, stack, fitur (terpotong lalu diulang), skema, tasks.
    const calls = mockQueue([
      identityOf(uiSkeleton),
      coreOf(uiSkeleton),
      [featuresOf(uiSkeleton), 'length'],
      [featuresOf(uiSkeleton), 'stop'],
      schemaOf(uiSkeleton),
      [{ tasks: uiTasks }, 'stop']
    ]);
    const result = await generatePRDFromPrompt('Arsip surat', 'Arsip Surat', [], 'oa/gpt-6-astra');
    assert.equal(result.tasks.length, uiTasks.length);
    // 7 panggilan: identitas, stack, fitur(potong), fitur(retry), db, api, tasks.
    assert.equal(calls.length, 7);
    assert.match(calls[3].body.messages[1].content, /terpotong/i);
    // Hint pemadatan harus sesuai tahap, bukan menyebut summary di retry tasks.
    assert.match(calls[3].body.messages[1].content, /features 3-6 modul/i);
    // Batas token harus selalu dikirim, kalau tidak router memotong sendiri.
    assert.equal(calls[0].body.max_tokens > 0, true);
  });

  await test('truncated tasks retry uses a tasks-specific compacting hint', async () => {
    process.env.PRDMAKER_API_KEY = 'offline-test-key';
    process.env.PRDMAKER_BASE_URL = 'http://provider.invalid/v1';
    process.env.PRDMAKER_MODEL = 'oa/gpt-6-astra';
    process.env.PRDMAKER_CONFIG = '/does/not/exist';
    // Regresi nyata: retry truncation tasks memakai hint summary/architecture,
    // sehingga jawaban kedua tetap kepanjangan dan terpotong lagi.
    const calls = mockQueue([
      identityOf(uiSkeleton), coreOf(uiSkeleton), featuresOf(uiSkeleton), schemaOf(uiSkeleton),
      [{ tasks: uiTasks }, 'length'],
      [{ tasks: uiTasks }, 'stop']
    ]);
    const result = await generatePRDFromPrompt('Arsip surat', 'Arsip Surat', [], 'oa/gpt-6-astra');
    assert.equal(result.tasks.length, uiTasks.length);
    // 7 panggilan: identitas, stack, fitur, db, api, tasks(potong), tasks(retry).
    assert.equal(calls.length, 7);
    const retry = calls[6].body.messages[1].content;
    assert.match(retry, /Maksimal 7 task/i);
    assert.match(retry, /terpotong/i);
    assert.doesNotMatch(retry, /architectureOverview maksimal 250 kata/);
  });

  await test('a permanently truncated stage reports the budget problem to the user', async () => {
    process.env.PRDMAKER_API_KEY = 'offline-test-key';
    process.env.PRDMAKER_BASE_URL = 'http://provider.invalid/v1';
    process.env.PRDMAKER_MODEL = 'oa/gpt-6-astra';
    process.env.PRDMAKER_CONFIG = '/does/not/exist';
    mockQueue([
      identityOf(uiSkeleton),
      coreOf(uiSkeleton),
      [featuresOf(uiSkeleton), 'length'],
      [featuresOf(uiSkeleton), 'length']
    ]);
    await assert.rejects(
      () => generatePRDFromPrompt('Arsip surat', 'Arsip Surat', [], 'oa/gpt-6-astra'),
      /terpotong/i
    );
  });

  await test('natural scale wording passes without mandatory labels', () => {
    const prd = structuredClone(validUI);
    prd.summary = prd.summary.replace('Skala: kecil, 500 surat per bulan.', 'Lima petugas dan 500 surat per bulan, jadi arsitektur harus sederhana.');
    prd.summary = prd.summary.replace('Asumsi: login melalui sesi kantor.', 'Login memakai sesi kantor yang disepakati tim.');
    assert.deepEqual(validatePRD(prd), []);
  });

  await test('missing task coverage, forward dependency, and table coverage fail explicitly', () => {
    const prd = structuredClone(validUI);
    prd.tasks = prd.tasks.filter(t => t.module !== 'Arsip Surat');
    prd.tasks[0].spec = prd.tasks[0].spec.replace('Dependensi: tidak ada', 'Dependensi: TASK-99');
    assert.ok(validatePRD(prd).some(p => /modul|tidak punya task/i.test(p)));
    assert.ok(validatePRD(prd).some(p => /TASK-99|dependensi/i.test(p)));
  });

  await test('CLI-only PRD needs no Design System or frontend task', () => {
    const prd = {
      projectName: 'Penghitung Teknis',
      summary: 'CLI untuk lima developer. Asumsi tidak ada. Skala kecil, 20 pengguna. Pembayaran, web, dan email tidak termasuk lingkup aplikasi ini.',
      techStack: ['Node.js', 'Node test runner'],
      architectureOverview: 'Memilih CLI Node.js karena tanpa server dan tanpa data pribadi. PostgreSQL ditolak karena program tidak menyimpan data. Input divalidasi, secret tidak dicetak, dan paket dipasang melalui npm.',
      features: [{
        module: 'Perhitungan', description: 'CLI menghitung estimasi waktu build.',
        acceptanceCriteria: ['Input valid menghasilkan estimasi.', 'Input negatif ditolak dengan pesan jelas.']
      }],
      databaseSchema: [],
      apiEndpoints: [],
      tasks: [{
        id: 'TASK-01', module: 'Perhitungan', title: 'Implementasikan perintah hitung',
        spec: 'File: bin/hitung.js. Dependensi: tidak ada. Tambahkan parsing input, validasi nilai negatif, format keluaran dan error tanpa secret. Kriteria selesai: input valid dan negatif teruji. Verifikasi: jalankan node --test; input valid dan negatif menghasilkan hasil yang dapat diperiksa.'
      }]
    };
    assert.deepEqual(validatePRD(prd), []);
  });

  await test('validation rejects missing shape without depending on task count', () => {
    const problems = validatePRD({ ...clarification, techStack: ['x'], databaseSchema: [], apiEndpoints: [] });
    assert.ok(problems.includes('nama proyek kosong'));
    assert.ok(problems.includes('tidak ada modul fitur'));
    assert.ok(problems.includes('tasks harus berupa array'));
  });

  await test('design guidance stays context-aware and mechanically testable', async () => {
    process.env.PRDMAKER_API_KEY = 'offline-test-key';
    process.env.PRDMAKER_BASE_URL = 'http://provider.invalid/v1';
    process.env.PRDMAKER_MODEL = 'oa/space-bunny-free';
    process.env.PRDMAKER_CONFIG = '/does/not/exist';
    const calls = mockQueue([identityOf(uiSkeleton), coreOf(uiSkeleton), detailOf(uiSkeleton), { tasks: uiTasks }]);
    await generatePRDFromPrompt('Dashboard arsip', 'Arsip', [], 'oa/space-bunny-free');
    const system = calls[1].body.messages[0].content;
    assert.equal((system.match(/KONTRAK DESAIN ANTI AI-SLOP/g) || []).length, 1);
    for (const required of [
      'jangan jadikan landing page',
      'Tidak ada emoji sebagai ikon',
      '4.5:1',
      'focus ring',
      'prefers-reduced-motion',
      '375/768/1440px',
      'gradient, glow, blur, glass, atau bento'
    ]) assert.match(system.toLowerCase(), new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
    assert.ok(!system.includes('premium/modern'));
    // Panggilan identitas harus tetap ramping: kontrak design tidak diulang di sana.
    assert.ok(!calls[0].body.messages[0].content.includes('KONTRAK DESAIN ANTI AI-SLOP'));
  });

  await test('chosen design direction reaches the skeleton stage and the task stage stays template-free', async () => {
    process.env.PRDMAKER_API_KEY = 'offline-test-key';
    process.env.PRDMAKER_BASE_URL = 'http://provider.invalid/v1';
    process.env.PRDMAKER_MODEL = 'oa/space-bunny-free';
    process.env.PRDMAKER_CONFIG = '/does/not/exist';
    const calls = mockQueue([identityOf(uiSkeleton), coreOf(uiSkeleton), featuresOf(uiSkeleton), schemaOf(uiSkeleton), { tasks: uiTasks }]);
    await generatePRDFromPrompt('Dashboard arsip', 'Arsip', [], 'oa/space-bunny-free', 'data-analysis');
    const stage1 = calls[0].body.messages[1].content;
    const core = calls[1].body.messages[1].content;
    // Tahap tasks kini panggilan ke-6 (0..5): identitas, stack, fitur, db, api, tasks.
    const stage2 = calls[5].body.messages[0].content;
    assert.match(stage1, /Arah visual WAJIB: Data & Analysis \(id: data-analysis\)/);
    assert.match(stage1, /#0f172a/, 'token HEX arah harus ikut ke prompt tahap 1');
    assert.match(core, /#0f172a/, 'arah visual juga ditegakkan di panggilan inti teknis');
    // Tahap 2 tidak boleh menerima daftar 7 template lagi, tapi kontrak design
    // tetap ada supaya task UI menyebut kontras, keyboard, dan reduced-motion.
    assert.ok(!stage2.includes('REFERENSI ARAH VISUAL'));
    assert.equal((stage2.match(/KONTRAK DESAIN ANTI AI-SLOP/g) || []).length, 1);

    const free = mockQueue([identityOf(uiSkeleton), coreOf(uiSkeleton), detailOf(uiSkeleton), { tasks: uiTasks }]);
    await generatePRDFromPrompt('Dashboard arsip', 'Arsip', [], 'oa/space-bunny-free');
    assert.match(free[0].body.messages[1].content, /PILIH SENDIRI berdasarkan brief/);
  });

  await test('bad skeleton retries before task generation, bad tasks retry after valid skeleton', async () => {
    process.env.PRDMAKER_API_KEY = 'offline-test-key';
    process.env.PRDMAKER_BASE_URL = 'http://provider.invalid/v1';
    process.env.PRDMAKER_MODEL = 'oa/gpt-6-astra';
    process.env.PRDMAKER_CONFIG = '/does/not/exist';

    const badTasks = structuredClone(uiTasks);
    badTasks[0].spec = `Tujuan: Siapkan penyimpanan letters.\nFile: src/db.js.\nDependensi: tidak ada\nImplementasi: Buat tabel letters dengan constraint nomor unik.`;
    // Fitur kosong: kunci ada tapi isi tidak lolos validator, supaya yang diuji
    // jalur perbaikan validator, bukan pengulangan karena bentuk salah.
    // Urutan panggilan nyata: identity, core, features(kosong), schema,
    // repair-features, tasks(buruk), tasks-retry.
    const calls = mockQueue([
      identityOf(uiSkeleton), coreOf(uiSkeleton), { features: [] }, schemaOf(uiSkeleton), featuresOf(uiSkeleton),
      { tasks: badTasks }, { tasks: uiTasks }
    ]);
    const result = await generatePRDFromPrompt('Arsip surat', 'Arsip Surat', [], 'oa/gpt-6-astra');

    // Urutan nyata 8 panggilan: identitas, stack, fitur(kosong), skema data,
    // kontrak API, repair-features, tasks(buruk), tasks-retry.
    assert.equal(calls.length, 8);
    assert.match(calls[0].body.messages[1].content, /projectName, tagline, summary/i);
    assert.match(calls[5].body.messages[1].content, /Perbaiki features/i);
    assert.match(calls[6].body.messages[1].content, /tahap 1/iu);
    assert.match(calls[7].body.messages[1].content, /Perbaiki tasks/i);
    assert.ok(calls.every(call => call.body.model === 'oa/gpt-6-astra'));
    assert.equal(result.tasks.length, uiTasks.length);
  });

  await test('no-UI prompt prevents unjustified web, auth, payments, and notifications', async () => {
    const calls = mockQueue([identityOf(uiSkeleton), coreOf(uiSkeleton), featuresOf(uiSkeleton), schemaOf(uiSkeleton), { tasks: uiTasks }]);
    const noUI = [...clarification.questions, { question: 'Antarmuka apa?', answer: 'Tanpa antarmuka; CLI saja. Jangan pakai web, browser, login, pembayaran, atau email.' }];
    await generatePRDFromPrompt('CLI impor CSV', 'CLI', noUI, 'oa/gpt-6-astra');
    assert.match(calls[1].body.messages[0].content, /jangan menambahkan frontend, login, atau Design System/i);
    assert.match(calls[5].body.messages[0].content, /tidak boleh mendapat task frontend, login, atau design system/i);
  });

  await test('"bukan CLI, bot, atau API tanpa UI" is contrast, not a non-UI claim', () => {
    // Regresi nyata: aplikasi web ditolak sebagai produk non-UI hanya karena
    // kalimatnya menyebut apa yang BUKAN produknya.
    const web = structuredClone(uiSkeleton);
    web.summary = 'Ini aplikasi web dengan antarmuka, bukan CLI, bot, atau API tanpa UI. 5 petugas, 500 surat per bulan. Di luar lingkup: unggah berkas.';
    web.architectureOverview = 'Keputusan teknologi: Node.js dipilih karena ringan; React ditolak sebagai alternatif. HTTPS dan validasi input.';
    assert.ok(!validatePRD(web, 'skeleton').some(p => /Design System tidak boleh/i.test(p)));
    assert.ok(!validatePRD(web, 'skeleton').some(p => /tidak ada modul Design System/i.test(p)));

    // Klaim non-UI yang sebenarnya tetap harus terdeteksi.
    const cli = structuredClone(uiSkeleton);
    cli.summary = 'CLI tanpa antarmuka untuk 1 pengguna, 100 data per bulan. Di luar lingkup: web.';
    cli.architectureOverview = 'Keputusan teknologi: Python dipilih; Redis ditolak. Validasi input.';
    assert.ok(validatePRD(cli, 'skeleton').some(p => /Design System tidak boleh/i.test(p)));
  });

  await test('"tanpa UI" as a label for a special mode does not strip the UI', () => {
    // Regresi nyata: model menulis "Aplikasi web internal (tanpa UI): tabel
    // untuk desktop", maksudnya mode cetak/keadaan khusus, tapi validator
    // membacanya sebagai produk non-UI lalu Design System dibuang.
    const web = structuredClone(uiSkeleton);
    web.summary = 'Aplikasi web internal (tanpa UI): tabel untuk desktop, 5 petugas, 500 surat per bulan. Di luar lingkup: email masuk.';
    web.architectureOverview = 'Keputusan teknologi: Node.js dipilih karena ringan. React ditolak sebagai alternatif. HTTPS, validasi input, otorisasi server-side.';
    const problems = validatePRD(web, 'skeleton');
    assert.ok(!problems.some(p => /tidak ada modul Design System/i.test(p)), JSON.stringify(problems));

    // Produk non-UI yang SUNGGUHAN tetap harus ditolak saat membawa Design System.
    const cli = structuredClone(uiSkeleton);
    cli.summary = 'CLI tanpa antarmuka untuk 1 pengguna, 100 data per bulan. Di luar lingkup: web dan dashboard.';
    cli.architectureOverview = 'Keputusan teknologi: Python dipilih karena stdlib cukup. Redis ditolak. Validasi input.';
    assert.ok(validatePRD(cli, 'skeleton').some(p => /Design System tidak boleh/i.test(p)), 'CLI dengan Design System harus ditolak');
  });

  await test('validation treats "no frontend framework" as still needing a UI', () => {
    // Regresi nyata: aplikasi web yang menolak framework (bukan menolak UI)
    // pernah dibaca sebagai produk tanpa antarmuka, lalu Design System ditolak.
    const webapp = structuredClone(uiSkeleton);
    webapp.summary = 'Aplikasi web internal dengan antarmuka untuk 5 petugas dan 500 surat per bulan. Di luar lingkup: unggah berkas.';
    webapp.architectureOverview = 'Keputusan teknologi: Node.js server-rendered HTML, bukan SPA. Aplikasi web dengan antarmuka, jadi tidak ada frontend framework. Alternatif React ditolak. HTTPS dan validasi input wajib.';
    const problems = validatePRD(webapp, 'skeleton');
    assert.ok(!problems.some(p => /tanpa antarmuka/i.test(p)), JSON.stringify(problems));
    assert.ok(!problems.some(p => /tidak ada modul Design System/i.test(p)), JSON.stringify(problems));
  });

  await test('validation catches foreign-script and repeated-token corruption in prose', () => {
    for (const bad of [' yang做 hal sama', ' zapuselageUEUEUEUEUEUE', ' UEUEUEUEUEUEUE']) {
      const prd = { ...uiSkeleton, summary: uiSkeleton.summary + bad };
      assert.ok(validatePRD(prd, 'skeleton').some(p => /terputus atau rusak/i.test(p)), JSON.stringify(bad));
    }
    // Teks Indonesia normal tidak boleh ikut tertandai.
    assert.ok(!validatePRD(uiSkeleton, 'skeleton').some(p => /terputus atau rusak/i.test(p)));
  });

  await test('validation accepts "di luar aplikasi" as an out-of-scope statement', () => {
    const prd = structuredClone(uiSkeleton);
    prd.summary = 'Arsip surat untuk 5 petugas, 500 surat per bulan. Tujuan: pencarian cepat.';
    prd.architectureOverview = 'Keputusan teknologi: Node.js dan SQLite untuk 5 petugas; PostgreSQL ditolak karena belum perlu. HTTPS dan validasi input. ';
    prd.architectureOverview += 'Lingkup di luar aplikasi: pemrosesan email masuk dan integrasi sistem luar.';
    assert.ok(!validatePRD(prd, 'skeleton').some(p => /batas lingkup/i.test(p)));
  });

  await test('markdown task list from a JSON-mode-ignoring model is parsed, not discarded', () => {
    // Keluaran NYATA oa/deepseek-v4.1-flash-free: JSON mode diminta, tapi tahap
    // tasks dijawab Markdown dengan heading "### T1.1 — ...".
    const md = [
      '## Modul 1: Design System',
      '### T1.1 — Setup proyek & tooling',
      '- **File:** package.json',
      '- **Output:** proyek jalan',
      '### T1.2 — Token desain',
      '- **File:** src/theme.css',
      '## Modul 2: Arsip',
      '### T2.1 — Model data & penyimpanan',
      '- **File:** src/db.js',
      '- **Prioritas:** HIGH'
    ].join('\n');
    const parsed = JSON.parse(extractJSON(md));
    assert.equal(parsed.tasks.length, 3);
    assert.deepEqual(parsed.tasks.map(t => t.id), ['T1.1', 'T1.2', 'T2.1']);
    assert.deepEqual(parsed.tasks.map(t => t.module), ['Design System', 'Design System', 'Arsip']);
    assert.equal(parsed.tasks[2].priority, 'HIGH');
    assert.ok(parsed.tasks[0].spec.includes('package.json'));
    // Prose tanpa daftar task tetap gagal: extractJSON mengembalikan teks apa
    // adanya (bukan JSON), bukan task kosong yang menyamar jadi data.
    assert.throws(() => JSON.parse(extractJSON('Baik, saya akan mulai mengerjakan proyek ini.')));
  });

  await test('validation rejects empty dependency, non-path file label, and missing done criteria', () => {
    const noPath = structuredClone(validUI);
    noPath.tasks[0].spec = noPath.tasks[0].spec.replace('File: src/db.js', 'File: storage layer');
    assert.ok(validatePRD(noPath).some(p => /file path/i.test(p)));

    const noDependencyValue = structuredClone(validUI);
    noDependencyValue.tasks[0].spec = noDependencyValue.tasks[0].spec.replace('Dependensi: tidak ada', 'Dependensi:');
    assert.ok(validatePRD(noDependencyValue).some(p => /dependensi/i.test(p)));

    const noDone = structuredClone(validUI);
    noDone.tasks[0].spec = noDone.tasks[0].spec.replace(/Kriteria selesai:[^\n]*/i, '');
    assert.ok(validatePRD(noDone).some(p => /kriteria selesai|definisi selesai/i.test(p)));
  });

  await test('feature acceptance criteria need a semantic failure or edge case', () => {
    const prd = structuredClone(validUI);
    prd.features[0].acceptanceCriteria = ['Pencarian nomor menghasilkan surat.', 'Pengguna melihat daftar.'];
    assert.ok(validatePRD(prd).some(p => /acceptance|edge|gagal|invalid|kosong/i.test(p)));
  });

  await test('CLI wording rejects negated web terms without requiring Design System', () => {
    const prd = structuredClone(validUI);
    prd.summary = 'CLI untuk lima developer. Asumsi tanpa server. Skala kecil, 20 pengguna. Tidak ada web, frontend, halaman, pembayaran, atau email dalam lingkup aplikasi ini.';
    prd.architectureOverview = 'Memilih CLI Node.js karena input lokal dan tanpa data pribadi. PostgreSQL ditolak karena tidak ada server. Input divalidasi, secret tidak dicetak, dan error ditangani.';
    prd.features = [{ module: 'Perhitungan', description: 'CLI menghitung estimasi waktu build.', acceptanceCriteria: ['Input valid menghasilkan estimasi.', 'Input negatif ditolak dengan pesan jelas.'] }];
    prd.databaseSchema = [];
    prd.apiEndpoints = [];
    prd.tasks = [{ id: 'TASK-01', module: 'Perhitungan', title: 'Implementasikan perintah hitung', spec: 'File: bin/hitung.js. Dependensi: tidak ada. Implementasikan parsing input, validasi nilai negatif, format keluaran, error tanpa secret. Kriteria selesai: input valid dan negatif teruji. Verifikasi: jalankan node --test; hasil aktual dapat diperiksa.' }];
    assert.deepEqual(validatePRD(prd), []);
  });

  await test('append rejects a new task that depends on itself', async () => {
    process.env.PRDMAKER_API_KEY = 'offline-test-key';
    process.env.PRDMAKER_BASE_URL = 'http://provider.invalid/v1';
    process.env.PRDMAKER_MODEL = 'oa/gpt-6-astra';
    process.env.PRDMAKER_CONFIG = '/does/not/exist';
    const badChange = {
      changeSummary: 'Tambahkan label arsip.',
      newFeatures: [], newEndpoints: [], newDbTables: [],
      newTasks: [{
        id: 'TASK-09', title: 'Implementasikan label arsip', module: 'Label Arsip',
        spec: 'Tujuan: label arsip. File: src/labels.js.\nDependensi: TASK-09\nBuat endpoint label dengan validasi, error 422, kriteria selesai: endpoint aktif. Verifikasi: node --test; hasil dapat diperiksa.'
      }]
    };
    mockQueue([badChange]);
    const { appendFeatureChange } = await import('../src/ai-prd.js');
    await assert.rejects(
      appendFeatureChange({ name: 'Arsip', summary: 'Arsip surat', techStack: [], architectureOverview: '', features: [], databaseSchema: [], apiEndpoints: [] }, [], 'Tambah label', 'oa/gpt-6-astra'),
      /mandiri|lingkaran|siklus|dependensi/i
    );
  });

  await test('config file default is used verbatim', async () => {
    const config = resolve(ROOT, 'tests/.ai-quality-config.yaml');
    fs.writeFileSync(config, 'api_key: file-test-key\ndefault_model: oa/gpt-6-astra\n');
    process.env.PRDMAKER_API_KEY = '';
    delete process.env.PRDMAKER_MODEL;
    process.env.PRDMAKER_CONFIG = config;
    try {
      const calls = mockQueue([identityOf(uiSkeleton), coreOf(uiSkeleton), detailOf(uiSkeleton), { tasks: uiTasks }]);
      await generatePRDFromPrompt('Arsip surat', 'Arsip Surat');
      assert.deepEqual(calls.map(call => call.body.model), ['oa/gpt-6-astra', 'oa/gpt-6-astra', 'oa/gpt-6-astra', 'oa/gpt-6-astra', 'oa/gpt-6-astra', 'oa/gpt-6-astra']);
    } finally {
      fs.rmSync(config, { force: true });
    }
  });

  await test('empty advertised list never fabricates a default model', async () => {
    process.env.PRDMAKER_API_KEY = 'offline-test-key';
    process.env.PRDMAKER_BASE_URL = 'http://provider.invalid/v1';
    delete process.env.PRDMAKER_MODEL;
    process.env.PRDMAKER_CONFIG = '/does/not/exist';
    mockQueue([], []);
    assert.deepEqual(await fetchAvailableModels(), []);
    await assert.rejects(generatePRDFromPrompt('Ide', 'Ide'), /model.*dipilih|default.*tersedia/i);
  });

  await test('JSON-mode rejection retries once without unsupported response_format', async () => {
    process.env.PRDMAKER_API_KEY = 'offline-test-key';
    process.env.PRDMAKER_BASE_URL = 'http://provider.invalid/v1';
    process.env.PRDMAKER_CONFIG = '/does/not/exist';
    const original = globalThis.fetch;
    const bodies = [];
    globalThis.fetch = async (_url, options = {}) => {
      const body = JSON.parse(options.body);
      bodies.push(body);
      if ('response_format' in body) return new Response(JSON.stringify({ error: { message: 'response_format unsupported' } }), { status: 400 });
      return completion({ questions: [
        { question: 'Siapa pengguna?', options: ['Admin', 'Publik'] },
        { question: 'Skala?', options: ['Kecil', 'Besar'] },
        { question: 'Perangkat?', options: ['Web', 'Mobile'] }
      ], projectSuggestion: 'Uji', briefAnalysis: 'Uji' });
    };
    const result = await generateClarifications('Ide', 'Uji', 'oa/space-bunny-free');
    assert.equal(result.projectSuggestion, 'Uji');
    assert.equal(bodies.length, 2);
    assert.ok('response_format' in bodies[0]);
    assert.ok(!('response_format' in bodies[1]));
    globalThis.fetch = original;
  });

  await test('selected-model provider error stays translated and does not leak raw response', async () => {
    process.env.PRDMAKER_API_KEY = 'offline-test-key';
    process.env.PRDMAKER_BASE_URL = 'http://provider.invalid/v1';
    process.env.PRDMAKER_MODEL = 'oa/gpt-6-astra';
    process.env.PRDMAKER_CONFIG = '/does/not/exist';
    mockQueue([new Error('ECONNREFUSED raw-secret-token')]);
    await assert.rejects(
      generatePRDFromPrompt('Bot CLI', 'Bot', [], 'oa/gpt-6-astra'),
      err => /tidak merespons tepat waktu|koneksi ke penyedia/i.test(err.message) && !/raw-secret-token|offline-test-key/i.test(err.message)
    );
  });
} finally {
  globalThis.fetch = originalFetch;
  restoreEnv();
}

async function test(name, fn) {
  await fn();
  console.log(`ok - ${name}`);
}
