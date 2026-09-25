// Ukur latensi nyata tahap 1 memakai system prompt yang sama persis dengan
// generator, lewat ekspor sementara di bawah (probe ini yang mengekspor).
import { readFileSync } from 'node:fs';
import { generatePRDFromPrompt } from '../src/ai-prd.js';

const idea = 'Sistem kutipan harga renovasi untuk kontraktor kecil. Klien input dimensi ruang dan bahan, aplikasi ambil daftar harga material terbaru, hitung total otomatis, lalu hasilkan PDF penawaran siap kirim. Desktop saja, 3 pengguna, semua perubahan harga harus bisa diaudit. Jangan diubah jadi landing page atau toko online.';
const t0 = Date.now();
try {
  const prd = await generatePRDFromPrompt(idea, 'Sistem Kutipan Renovasi', [
    { question: 'Harga material dari mana?', answer: 'Daftar harga dari pemasok, diperbarui bulanan oleh admin.' }
  ], 'oa/space-bunny-free', 'utility-function');
  console.log(JSON.stringify({ ok: true, secs: ((Date.now() - t0) / 1000).toFixed(1), tasks: prd.tasks.length }));
} catch (e) {
  console.log(JSON.stringify({ ok: false, secs: ((Date.now() - t0) / 1000).toFixed(1), msg: e.message }));
}
