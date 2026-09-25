import assert from 'node:assert/strict';
import fs from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');

import {
  fetchAvailableModels,
  generateClarifications,
  generatePRDFromPrompt,
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
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    if (url.endsWith('/models')) {
      return new Response(JSON.stringify({ data: models }), { status: 200 });
    }
    calls.push({ url, body: JSON.parse(options.body) });
    const next = responses.shift();
    if (!next) throw new Error('unexpected provider request');
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
const detailOf = (s) => ({ features: s.features, databaseSchema: s.databaseSchema, apiEndpoints: s.apiEndpoints });

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

  await test('two-stage flow uses selected model only and validates before task stage', async () => {
    process.env.PRDMAKER_API_KEY = 'offline-test-key';
    process.env.PRDMAKER_BASE_URL = 'http://provider.invalid/v1';
    process.env.PRDMAKER_MODEL = 'oa/gpt-6-astra';
    process.env.PRDMAKER_CONFIG = '/does/not/exist';
    const calls = mockQueue([identityOf(uiSkeleton), coreOf(uiSkeleton), detailOf(uiSkeleton), { tasks: uiTasks }]);
    const result = await generatePRDFromPrompt('Arsip surat', 'Arsip Surat', [], 'oa/gpt-6-astra');
    assert.equal(result.tasks.length, uiTasks.length);
    assert.equal(result.projectName, 'Arsip Surat');
    // Tahap 1 dipecah tiga panggilan; semuanya tetap model yang dipilih.
    assert.deepEqual(calls.map(c => c.body.model), ['oa/gpt-6-astra', 'oa/gpt-6-astra', 'oa/gpt-6-astra', 'oa/gpt-6-astra']);
    assert.ok(calls.every(c => c.body.response_format.type === 'json_object'));
    assert.match(calls[0].body.messages[0].content, /projectName/);
    assert.doesNotMatch(calls[0].body.messages[0].content, /apiEndpoints/);
    assert.match(calls[1].body.messages[0].content, /architectureOverview/);
    assert.match(calls[2].body.messages[0].content, /apiEndpoints/);
    // Kontrak desain hanya sekali, di panggilan arsitektur.
    assert.equal((calls[1].body.messages[0].content.match(/KONTRAK DESAIN ANTI AI-SLOP/g) || []).length, 1);
    assert.doesNotMatch(calls[2].body.messages[0].content, /KONTRAK DESAIN ANTI AI-SLOP/);
    assert.match(calls[3].body.messages[0].content, /(?:CLI|bot|API|library).*(?:tanpa UI|tanpa antarmuka)/iu);
  });

  await test('a stage answered with the previous stage shape is retried, not trusted', async () => {
    process.env.PRDMAKER_API_KEY = 'offline-test-key';
    process.env.PRDMAKER_BASE_URL = 'http://provider.invalid/v1';
    process.env.PRDMAKER_MODEL = 'oa/gpt-6-astra';
    process.env.PRDMAKER_CONFIG = '/does/not/exist';
    // Tahap rincian dibalas dengan bentuk tahap stack: kunci hilang meski HTTP 200.
    const calls = mockQueue([
      identityOf(uiSkeleton),
      coreOf(uiSkeleton),
      coreOf(uiSkeleton),
      detailOf(uiSkeleton),
      { tasks: uiTasks }
    ]);
    const result = await generatePRDFromPrompt('Arsip surat', 'Arsip Surat', [], 'oa/gpt-6-astra');
    assert.deepEqual(result.features.map(f => f.module), uiSkeleton.features.map(f => f.module));
    assert.equal(calls.length, 5);
    assert.match(calls[3].body.messages[1].content, /Ulangi khusus tahap rincian/);
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
    // Urutan nyata: 1a identitas, 1b stack, 1c rincian (terpotong lalu diulang), 2 tasks.
    const calls = mockQueue([
      identityOf(uiSkeleton),
      coreOf(uiSkeleton),
      [detailOf(uiSkeleton), 'length'],
      [detailOf(uiSkeleton), 'stop'],
      [{ tasks: uiTasks }, 'stop']
    ]);
    const result = await generatePRDFromPrompt('Arsip surat', 'Arsip Surat', [], 'oa/gpt-6-astra');
    assert.equal(result.tasks.length, uiTasks.length);
    assert.equal(calls.length, 5);
    assert.match(calls[3].body.messages[1].content, /terpotong/i);
    // Batas token harus selalu dikirim, kalau tidak router memotong sendiri.
    assert.equal(calls[0].body.max_tokens > 0, true);
  });

  await test('a permanently truncated stage reports the budget problem to the user', async () => {
    process.env.PRDMAKER_API_KEY = 'offline-test-key';
    process.env.PRDMAKER_BASE_URL = 'http://provider.invalid/v1';
    process.env.PRDMAKER_MODEL = 'oa/gpt-6-astra';
    process.env.PRDMAKER_CONFIG = '/does/not/exist';
    mockQueue([
      identityOf(uiSkeleton),
      coreOf(uiSkeleton),
      [detailOf(uiSkeleton), 'length'],
      [detailOf(uiSkeleton), 'length']
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
    const calls = mockQueue([identityOf(uiSkeleton), coreOf(uiSkeleton), detailOf(uiSkeleton), { tasks: uiTasks }]);
    await generatePRDFromPrompt('Dashboard arsip', 'Arsip', [], 'oa/space-bunny-free', 'data-analysis');
    const stage1 = calls[0].body.messages[1].content;
    const core = calls[1].body.messages[1].content;
    const stage2 = calls[3].body.messages[0].content;
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
    // Kunci lengkap tapi isinya tidak lolos validator, supaya yang diuji adalah
    // jalur perbaikan validator, bukan pengulangan karena bentuk salah.
    const badDetail = { features: [], databaseSchema: [], apiEndpoints: [] };
    const calls = mockQueue([
      identityOf(uiSkeleton), coreOf(uiSkeleton), badDetail, detailOf(uiSkeleton),
      { tasks: badTasks }, { tasks: uiTasks }
    ]);
    const result = await generatePRDFromPrompt('Arsip surat', 'Arsip Surat', [], 'oa/gpt-6-astra');

    assert.equal(calls.length, 6);
    assert.match(calls[0].body.messages[1].content, /projectName, tagline, summary/i);
    assert.match(calls[3].body.messages[1].content, /Perbaiki rincian/i);
    assert.match(calls[4].body.messages[1].content, /tahap 1/iu);
    assert.match(calls[5].body.messages[1].content, /Perbaiki tasks/i);
    assert.ok(calls.every(call => call.body.model === 'oa/gpt-6-astra'));
    assert.equal(result.tasks.length, uiTasks.length);
  });

  await test('no-UI prompt prevents unjustified web, auth, payments, and notifications', async () => {
    const calls = mockQueue([identityOf(uiSkeleton), coreOf(uiSkeleton), detailOf(uiSkeleton), { tasks: uiTasks }]);
    const noUI = [...clarification.questions, { question: 'Antarmuka apa?', answer: 'Tanpa antarmuka; CLI saja. Jangan pakai web, browser, login, pembayaran, atau email.' }];
    await generatePRDFromPrompt('CLI impor CSV', 'CLI', noUI, 'oa/gpt-6-astra');
    assert.match(calls[1].body.messages[0].content, /jangan menambahkan frontend, login, atau Design System/i);
    assert.match(calls[3].body.messages[0].content, /tidak boleh mendapat task frontend, login, atau design system/i);
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
      assert.deepEqual(calls.map(call => call.body.model), ['oa/gpt-6-astra', 'oa/gpt-6-astra', 'oa/gpt-6-astra', 'oa/gpt-6-astra']);
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
