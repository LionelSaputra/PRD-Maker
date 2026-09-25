export const skeleton = {
  projectName: 'Arsip Surat', tagline: 'Arsip kantor kecil',
  summary: 'Website arsip surat untuk 5 petugas kantor. Tujuan: pencarian surat berdasarkan nomor. Metrik usulan: temukan surat dalam 30 detik. Asumsi: login melalui sesi kantor. Skala: kecil, 500 surat per bulan. Di luar lingkup: pembayaran dan aplikasi mobile native.',
  techStack: ['Node.js', 'SQLite', 'HTML CSS'],
  architectureOverview: 'Keputusan teknologi: Node.js monolith dan SQLite untuk lima petugas. PostgreSQL ditolak karena belum memerlukan banyak penulis bersamaan. Browser memakai HTTPS ke API dengan otorisasi server-side; secret di environment. Backup harian diverifikasi dengan restore. UI berupa daftar surat, form dan pencarian.',
  features: [
    { module: 'Arsip Surat', description: 'Petugas mencari surat kantor berdasarkan nomor unik.', acceptanceCriteria: ['Pencarian nomor menghasilkan surat yang tepat.', 'Nomor tak dikenal menampilkan keadaan kosong tanpa error.'] },
    { module: 'Design System', description: 'Reading this as: UI utilitas untuk petugas kantor; template Utility. Latar #ffffff, permukaan #f6f8fa, teks #1f2328, muted #59636e, border #d8dee4, accent #0969da, success #1a7f37. Font system-ui 16px weight 400, judul 24px 600. spacing 4px 8px 16px 24px, radius 4px. Tabel desktop dan list mobile; focus-visible, loading dan error. Motion opacity 150ms, prefers-reduced-motion.', acceptanceCriteria: ['Keyboard mencapai semua tombol dan label input.', 'Pada lebar 375px tidak ada overflow halaman dan teks memenuhi WCAG AA.'] }
  ],
  databaseSchema: [{ table: 'letters', description: 'Metadata surat kantor', fields: ['id TEXT PRIMARY KEY', 'number TEXT UNIQUE NOT NULL', 'subject TEXT NOT NULL'] }],
  apiEndpoints: [{ method: 'GET', path: '/api/v1/letters', description: 'Petugas terautentikasi: input query number; output 200 {letters: []}; 401 tanpa sesi, 422 nomor tidak valid.', payload: '{number: string}', response: '{letters: []}' }]
};
const jobs = [
  ['Arsip Surat','Siapkan penyimpanan letters','src/db.js','Buat tabel letters dan constraint nomor unik; sediakan migrasi idempoten.'],
  ['Arsip Surat','Otorisasi petugas surat','src/auth.js','Tolak sesi kosong dan expired sebelum membaca arsip; cookie HttpOnly dan SameSite.'],
  ['Arsip Surat','Implementasi pencarian surat','src/letters.js','Implementasikan GET /api/v1/letters, validasi number dan parameterized query letters.'],
  ['Design System','Tetapkan token dan komponen arsip','public/tokens.css','Terapkan palet serta typography pada form dan daftar; focus-visible dan prefers-reduced-motion.'],
  ['Arsip Surat','Tampilkan hasil pencarian surat','public/letters.js','Form nomor dan daftar hasil, loading, empty, error serta retry tanpa kehilangan input.'],
  ['Arsip Surat','Uji alur arsip ujung ke ujung','tests/letters.test.js','Uji sesi petugas dan pencarian nomor valid, kosong dan karakter berbahaya.'],
  ['Design System','Uji aksesibilitas dan responsivitas','tests/ui.test.js','Periksa tab order, label, warna, ukuran layar 375/768/1440px serta reduced-motion.'],
  ['Arsip Surat','Siapkan backup dan deployment','scripts/backup.js','Konfigurasi HTTPS, environment, backup letters dan uji restore pada DB terisolasi.']
];
export const tasks = jobs.map(([module,title,file,detail], i) => ({
  id: `TASK-${String(i+1).padStart(2,'0')}`, module, title, priority: 'HIGH',
  spec: `Tujuan: ${title}.\nFile: ${file}.\nDependensi: ${i ? `TASK-${String(i).padStart(2,'0')}` : 'tidak ada'}\nImplementasi: ${detail}\nError: tampilkan pesan yang bisa ditindaklanjuti tanpa membocorkan data atau secret.\nKriteria selesai: kebutuhan ${module} terpenuhi sesuai PRD.\nVerifikasi: jalankan node --test dan periksa skenario valid, gagal, serta data kosong dengan hasil sesuai kontrak; laporkan output aktual.`
}));
export const clarification = {
  projectSuggestion: 'Arsip Surat', briefAnalysis: 'Fokus pada pencarian surat kantor kecil.',
  questions: [
    {id:'q1',question:'Berapa petugas dan surat per bulan?',options:['5 petugas dan 500 surat (Rekomendasi)','50 petugas dan 5000 surat']},
    {id:'q2',question:'Bagaimana surat dicari?',options:['Nomor dan judul (Rekomendasi)','Nomor saja']},
    {id:'q3',question:'Siapa yang boleh membaca surat?',options:['Petugas kantor (Rekomendasi)','Semua pengunjung']},
    {id:'q4',question:'Apakah perlu lampiran surat?',options:['Metadata dulu (Rekomendasi)','PDF juga']}
  ]
};
export const change = {
  changeSummary: 'Tambahkan label arsip untuk pengelompokan surat.', updatedSummary: '',
  newFeatures: [{module:'Label Arsip',description:'Kelompokkan surat dengan label.',acceptanceCriteria:['Label tersimpan.','Label kosong ditolak.']}],
  newEndpoints: [{method:'POST',path:'/api/v1/labels',description:'Petugas mengirim {name}; 201 label atau 422 input invalid.'}],
  newDbTables: [{table:'labels',description:'Label surat',fields:['id TEXT PRIMARY KEY','name TEXT UNIQUE NOT NULL']}],
  newTasks: [{id:'TASK-09',title:'Implementasikan label arsip',module:'Label Arsip',spec:'Tujuan: kelompokkan surat dengan Label Arsip. File: src/labels.js.\nDependensi: TASK-03\nBuat tabel labels dan POST /api/v1/labels dengan otorisasi petugas, validasi nama unik serta parameterized query. Error: nama kosong 422, tanpa sesi 401. Kriteria selesai: endpoint dan storage label aktif. Verifikasi: node --test, label valid 201 dan duplikat 409; tampilkan kesalahan tanpa secret.'}]
};
