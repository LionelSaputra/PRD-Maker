// Layar prototype per modul PRD.
//
// Prinsip (dari pekerjaan sebelumnya + permintaan pengguna):
//  1. BENTUK LAYAR MENGIKUTI DOMAIN TOPIK. Aplikasi draft MLBB dirender sebagai
//     draft board (dua tim, slot ban/pick, timer), bukan tabel absensi. Sebelumnya
//     "Real-Time Draft Room" jadi tabel dengan kolom "blue picks" berisi
//     "Contoh 1" dan status "Hadir/Izin/Sakit" dari domain sekolah.
//  2. TANPA DATA KARANGAN. Semua layar menampilkan keadaan kosong yang benar
//     ("belum ada draft", "belum ada siswa") — bukan baris palsu.
//  3. INTERAKTIF. Layar bisa diklik (tab, pilih kelas, pilih status) supaya
//     terasa prototype, bukan gambar mati.
//
// Aturan visual tetap dari skill: satu aksi utama per layar, label programatik,
// status tidak hanya warna, target sentuh 44px, reduced-motion.

export const esc = (s) => String(s == null ? '' : s)
  .replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ===== Jenis produk (menentukan bentuk preview keseluruhan) =====
export function productKind({ features = [], summary = '', architecture = '' } = {}) {
  const text = [summary, architecture].join(' ').toLowerCase();
  const featureNames = features.map(f => (f && f.module) || '').join(' ').toLowerCase();
  const all = text + ' ' + featureNames;
  if (/\b(cli|command.?line|bot\b|library|pustaka|tanpa ui\b|tanpa antarmuka|api saja)\b/.test(all)) return 'nonui';
  const proseShowcase = /portofolio|portfolio|landing page|company profile|profil perusahaan|resume|cv\b|undangan|microsite|situs profil|one.?page/.test(text);
  const featureShowcase = /\b(hero|pendidikan|pengalaman (kerja|magang)|proyek pilihan|achievement|sertifikasi|skill & tools|kontak)\b/.test(featureNames)
    && !/dashboard|admin|login|auth|transaksi|pesanan|stok|presensi|absensi|rekap|laporan|pesanan|checkout/.test(featureNames);
  return (proseShowcase || featureShowcase) ? 'showcase' : 'app';
}

// ===== Domain topik (menentukan bentuk layar spesifik) =====
export function domainKind(moduleName = '', product = 'app') {
  const n = String(moduleName).toLowerCase();
  // "Hero" di situs profil berarti bagian pembuka halaman, bukan hero game.
  // Karena itu aturan game hanya berlaku untuk jenis produk 'app'.
  if (product === 'showcase') return 'generic';
  // Konteks game MOBA/draft. Batas kata WAJIB ketat: tanpa \b, "dispatch"
  // cocok dengan "patch", "Metadata" cocok dengan "meta", dan "Hero & Profil"
  // di portofolio cocok dengan "hero" -> layar salah bentuk.
  const gamey = /\b(ban|pick|picks|bans|hero|heroes|counter|synergy|patch|patch\b|rank|ranking|meta\b)\b/.test(n)
    || /draft/.test(n) && /room|board|phase|session|live/.test(n)
    || /\bmlbb\b|mobile legends|dota|valorant|lol\b/.test(n);
  if (gamey) return 'draft';
  if (/presensi|absensi|kehadiran|siswa|murid|kelas|rombel|guru|wali/.test(n)) return 'roster';
  if (/pesanan|order|kasir|pos|produk|menu|stok|inventaris|keranjang|checkout|pembayaran/.test(n)) return 'pos';
  if (/surat|arsip|dokumen|berkas|disposisi|agenda/.test(n)) return 'archive';
  return 'generic';
}

// ===== Bentuk layar (kategori generik) =====
export function screenKind(moduleName = '') {
  const n = String(moduleName).toLowerCase();
  if (/design system|sistem desain|design token/.test(n)) return 'tokens';
  if (/auth|login|masuk|sesi|akun|pengguna|user|otentikasi|autentikasi/.test(n)) return 'auth';
  if (/laporan|rekap|rekapitulasi|statistik|dashboard|ringkas|analitik/.test(n)) return 'report';
  if (/cari|pencarian|search|filter/.test(n)) return 'search';
  if (/hero|pendidikan|pengalaman|proyek|achievement|sertifik|aktivitas|organisasi|skill|kontak|testimoni|harga|paket|faq|fitur utama/.test(n)) return 'content';
  if (/seo|metadata|deployment|deploy|analytics|konfigurasi|setup/.test(n)) return 'ops';
  if (/presensi|absensi|kehadiran|transaksi|pencatatan|entri|catat|stok|inventaris|pesanan|order|pembayaran|nilai|jadwal/.test(n)) return 'entry';
  return 'table';
}

// Kolom dari tabel PRD yang cocok dengan nama modul.
export function columnsFor(moduleName, databaseSchema = []) {
  const words = String((moduleName && moduleName.module) || moduleName || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3);
  const scored = (databaseSchema || [])
    .filter((t) => t && t.table)
    .map((t) => ({ t, score: words.filter((w) => String(t.table).toLowerCase().includes(w)).length }))
    .sort((a, b) => b.score - a.score);
  const best = scored.find((x) => x.score > 0) || scored[0];
  if (!best || !Array.isArray(best.t.fields)) return null;
  const columns = best.t.fields
    .map((f) => String(f).trim().split(/[\s(]/)[0])
    .filter((c) => c && !/^(id|created_at|updated_at|password_hash|token_hash|deleted_at)$/i.test(c));
  return { table: best.t.table, columns: columns.slice(0, 5) };
}

// Keadaan kosong yang benar: label domain, tanpa data palsu.
function emptyState(title, hint, action) {
  return `<div class="empty">
    <span class="empty-mark" aria-hidden="true"></span>
    <strong>${esc(title)}</strong>
    <p>${esc(hint)}</p>
    ${action ? `<button class="btn-primary" type="button">${esc(action)}</button>` : ''}
  </div>`;
}
const noData = (what) => emptyState(`Belum ada ${what}`, `Daftar ${what} akan tampil di sini setelah data pertama dibuat.`, `Tambah ${what}`);

// Tabel kosong dengan header ASLI dari kolom PRD — struktur terlihat, isi jujur.
function emptyTable(columns, caption) {
  return `<div class="tbl-wrap"><table class="tbl">
    <caption class="vh">${esc(caption)}</caption>
    <thead><tr>${columns.map((c) => `<th scope="col">${esc(c.replace(/_/g, ' '))}</th>`).join('')}</tr></thead>
    <tbody><tr class="tbl-empty"><td colspan="${columns.length}">${noData('baris')}</td></tr></tbody>
  </table></div>`;
}

// ===== Layar domain: draft board (game MOBA/draft) =====
function draftBoard(mod, cols) {
  const slots = (n, label) => Array.from({ length: n }, (_, i) => `
    <button class="slot" type="button" aria-label="${label} ${i + 1}, masih kosong">
      <span class="slot-no">${i + 1}</span><span class="slot-x" aria-hidden="true">+</span>
    </button>`).join('');
  return `
  <div class="draft">
    <div class="draft-head">
      <div class="team team-blue"><span class="team-name">Tim Biru</span><span class="team-meta">belum ada pick</span></div>
      <div class="timer" role="timer" aria-label="Sisa waktu draft"><b>00:00</b><span>timer</span></div>
      <div class="team team-red"><span class="team-name">Tim Merah</span><span class="team-meta">belum ada pick</span></div>
    </div>
    <div class="draft-rows">
      <div class="draft-row"><span class="row-label">Ban</span><div class="slots">${slots(5, 'Ban')}</div></div>
      <div class="draft-row"><span class="row-label">Pick</span><div class="slots">${slots(5, 'Pick')}</div></div>
    </div>
    <div class="draft-pool">
      <div class="pool-head"><strong>Kumpulan hero</strong><span class="hint">pilih hero lalu klik slot di atas</span></div>
      ${emptyState('Hero belum dimuat', 'Katalog hero muncul setelah sinkronisasi patch pertama selesai.', 'Sinkronkan patch')}
    </div>
  </div>
  <p class="hint">Setiap pilihan ban/pick harus tersinkron ke semua klien dalam &lt;300 ms; slot kosong di atas menampilkan keadaan awal yang benar, bukan contoh palsu.</p>`;
}

// ===== Layar domain: absensi/roster =====
function rosterBoard(mod, cols) {
  const statuses = ['Hadir', 'Izin', 'Sakit', 'Alfa'];
  return `
  <div class="screen-bar">
    <label class="field sm"><span>Kelas</span><select><option>Belum ada kelas</option></select></label>
    <label class="field sm"><span>Tanggal</span><input type="date" /></label>
    <button class="btn-primary" type="button" disabled>Simpan kehadiran</button>
  </div>
  <div class="legend">${statuses.map((s) => `<span class="pill ${s === 'Hadir' ? 'ok' : s === 'Alfa' ? 'bad' : 'warn'}">${s}</span>`).join('')}<span class="hint">warna selalu disertai teks</span></div>
  ${emptyState('Belum ada siswa untuk ditandai', 'Pilih kelas yang sudah punya siswa. Setiap perubahan tersimpan dalam satu transaksi.', 'Kelola data siswa')}`;
}

// ===== Layar domain: kasir/POS =====
function posBoard(mod, cols) {
  return `
  <div class="pos">
    <div class="pos-list">
      <div class="screen-bar"><label class="search" for="pos-q"><span class="vh">Cari produk</span><input id="pos-q" type="search" placeholder="Cari produk…" /></label></div>
      ${emptyState('Keranjang kosong', 'Pilih produk dari daftar untuk mulai transaksi. Total dihitung otomatis.', 'Tambah produk')}
    </div>
    <aside class="pos-sum">
      <span class="hint">Total</span><b class="pos-total">Rp 0</b>
      <span class="hint">Belum ada item</span>
      <button class="btn-primary" type="button" disabled>Bayar</button>
    </aside>
  </div>`;
}

// ===== Layar domain: arsip dokumen =====
function archiveBoard(mod, cols) {
  return `
  <div class="screen-bar">
    <label class="search" for="ar-q"><span class="vh">Cari surat</span><input id="ar-q" type="search" placeholder="Cari nomor atau judul surat…" /></label>
    <button class="btn-primary" type="button">Catat surat</button>
  </div>
  <div class="split">
    <div class="split-main">${emptyState('Belum ada surat tercatat', 'Surat masuk dan keluar tampil sebagai daftar di sini.', 'Catat surat pertama')}</div>
    <aside class="split-side">
      <strong>Rincian surat</strong>
      <div class="detail-rows">
        <div><span>Nomor</span><em>—</em></div>
        <div><span>Perihal</span><em>—</em></div>
        <div><span>Status</span><em>—</em></div>
      </div>
      <p class="hint">Pilih satu surat untuk melihat rinciannya.</p>
    </aside>
  </div>`;
}

// Layar konten (portofolio/landing) — bernarasi, tanpa data palsu.
function contentScreen(mod) {
  const n = String(mod.module).toLowerCase();
  if (/kontak|contact/.test(n)) {
    return `<div class="content">
      <p class="lead">Ada peran, proyek, atau kolaborasi yang cocok? Kirim pesan lewat formulir atau WhatsApp.</p>
      <div class="entry-grid">
        <label class="field"><span>Nama</span><input placeholder="Nama Anda" /></label>
        <label class="field"><span>Email</span><input type="email" placeholder="nama@contoh.com" /></label>
        <label class="field"><span>Pesan</span><input placeholder="Tulis pesan singkat" /></label>
      </div>
      <div class="entry-foot">
        <button class="btn-primary" type="button">Kirim pesan</button>
        <a class="btn-ghost" href="#${esc(mod.slug)}">Chat WhatsApp</a>
        <span class="hint">Balasan dalam 1×24 jam kerja. Formulir punya status sukses dan gagal yang jelas.</span>
      </div>
    </div>`;
  }
  if (/hero|profil/.test(n)) {
    return `<div class="hero-blk">
      <p class="eyebrow">Posisi / Spesialisasi</p>
      <p class="hero-title">Judul utama yang menyatakan nilai Anda.</p>
      <p class="lead">Satu-dua kalimat ringkas: siapa Anda, untuk siapa, dan bukti apa yang menyusul di bawah.</p>
      <div class="row">
        <a class="btn-primary" href="#${esc(mod.slug)}">Lihat proyek</a>
        <a class="btn-ghost" href="#${esc(mod.slug)}">Unduh CV</a>
      </div>
    </div>`;
  }
  return `<div class="content">
    <p class="lead">${esc(mod.description || 'Bagian ini menampilkan isi dan bukti nyata.')}</p>
    ${emptyState('Belum ada isi', 'Isi bagian ini diambil dari data portofolio yang akan Anda isi.', 'Tambah isi')}
  </div>`;
}

// Layar checklist teknis (SEO, deployment, konfigurasi).
function opsScreen(mod) {
  const items = ['Judul dan deskripsi per halaman terisi', 'Open Graph dan kartu pratinjau tersedia', 'Peta situs dan robots.txt benar', 'Skor aksesibilitas dan performa diperiksa sebelum rilis'];
  return `<ul class="checklist">${items.map((t) => `
    <li><button class="chk" type="button" aria-pressed="false" aria-label="Tandai: ${esc(t)}"><span aria-hidden="true"></span></button>${esc(t)}</li>`).join('')}
  </ul>
  <p class="hint">Status memakai simbol dan label teks, bukan hanya warna. Klik untuk menandai.</p>`;
}

// Layar token design system.
function tokenScreen(theme, onAccent) {
  const swatches = [['Latar', theme.bg], ['Permukaan', theme.surface], ['Garis', theme.border], ['Teks', theme.text], ['Redam', theme.muted], ['Aksen', theme.accent], ['Selesai', theme.done], ['Proses', theme.progress], ['Gagal', theme.failed]];
  return `<div class="tokens">
    <div class="sw-row">${swatches.map(([l, v]) => `
      <div class="sw"><span class="chip" style="background:${v}"></span><b>${l}</b><code>${v}</code></div>`).join('')}
    </div>
    <div class="type-row">
      <div><span class="hint">Judul halaman</span><p class="t-h1">Judul halaman contoh</p></div>
      <div><span class="hint">Isi</span><p class="t-body">Ukuran teks isi untuk paragraf dan keterangan pendukung.</p></div>
      <div><span class="hint">Angka rekap</span><p class="t-num">0</p></div>
    </div>
    <div class="row">
      <button class="btn-primary" style="background:${theme.accent};color:${onAccent}">Aksi utama</button>
      <button class="btn-ghost">Batal</button>
      <button class="btn-ghost" disabled>Nonaktif</button>
      <span class="pill ok">Selesai</span><span class="pill warn">Proses</span><span class="pill bad">Gagal</span>
    </div>
  </div>`;
}

// Layar tabel generik (dengan header dari kolom PRD).
function tableScreen(mod, cols) {
  const columns = cols ? cols.columns : ['nama', 'keterangan', 'status'];
  return `
  <div class="screen-bar">
    <label class="search" for="s-${esc(mod.slug)}"><span class="vh">Cari ${esc(mod.module)}</span><input id="s-${esc(mod.slug)}" type="search" placeholder="Cari ${esc(mod.module.toLowerCase())}…" /></label>
    <button class="btn-primary" type="button">Tambah ${esc(mod.module.split(' ')[0])}</button>
  </div>
  ${emptyTable(columns, 'Daftar ' + mod.module)}`;
}

function entryScreen(mod, cols) {
  const fields = cols ? cols.columns.slice(0, 3) : ['nama', 'tanggal', 'status'];
  return `
  <div class="entry-grid">
    ${fields.map((f) => `<label class="field"><span>${esc(f.replace(/_/g, ' '))}</span><input placeholder="${esc(f.replace(/_/g, ' '))}" /></label>`).join('')}
  </div>
  <div class="entry-foot">
    <button class="btn-primary" type="button" disabled>Simpan ${esc(mod.module.split(' ')[0])}</button>
    <span class="hint">Tombol aktif setelah isian lengkap; dinonaktifkan selama proses supaya tidak terkirim dua kali.</span>
  </div>`;
}

function reportScreen(mod, cols) {
  const columns = cols ? cols.columns : ['periode', 'jumlah'];
  return `
  <div class="filters">
    <label class="field sm"><span>Periode</span><input type="month" /></label>
    <label class="field sm"><span>Kelompok</span><select><option>Semua</option></select></label>
    <button class="btn-ghost" type="button">Terapkan</button>
    <button class="btn-ghost" type="button">Ekspor CSV</button>
  </div>
  <div class="kpis">
    <div class="kpi"><span class="hint">Total</span><b>—</b></div>
    <div class="kpi"><span class="hint">Rata-rata</span><b>—</b></div>
    <div class="kpi"><span class="hint">Terendah</span><b>—</b></div>
  </div>
  ${emptyTable(columns, 'Rekap ' + mod.module)}
  <p class="hint">Angka rekap dihitung dari data transaksi, bukan tabel salinan, sehingga tidak bisa melenceng dari sumbernya.</p>`;
}

function searchScreen(mod, cols) {
  const columns = cols ? cols.columns : ['nama', 'keterangan'];
  return `
  <form class="entry" onsubmit="return false">
    <div class="entry-grid">
      <label class="field"><span>Kata kunci</span><input type="search" placeholder="Nomor, judul, atau nama…" /></label>
      <label class="field"><span>Filter status</span><select><option>Semua</option></select></label>
    </div>
    <div class="entry-foot"><button class="btn-primary" type="submit">Cari</button><span class="hint">Tekan Enter untuk mencari. Hasil muncul di bawah tanpa memuat ulang halaman.</span></div>
  </form>
  <p class="hint">Belum ada pencarian. Hasil akan tampil di sini.</p>`;
}

function authScreen(mod) {
  if (/masuk|login|sesi|auth/i.test(mod.module)) {
    return `<form class="auth" onsubmit="return false">
      <label class="field"><span>Nama pengguna</span><input autocomplete="username" placeholder="nama pengguna" /></label>
      <label class="field"><span>Kata sandi</span><input type="password" autocomplete="current-password" placeholder="kata sandi" /></label>
      <button class="btn-primary" type="submit">Masuk</button>
      <p class="err" role="alert" hidden>Nama pengguna atau kata sandi tidak cocok. Coba lagi.</p>
      <p class="hint">Sesi disimpan di server sebagai cookie HttpOnly; kata sandi di-hash, tidak pernah disimpan mentah.</p>
    </form>`;
  }
  return tableScreen(mod, null);
}

// Bangun satu layar; bentuk dipilih dari domain, lalu kategori generik.
export function buildModuleScreen(mod, ctx) {
  const { databaseSchema, theme, onAccent, product = 'app', active = false } = ctx;
  const cols = columnsFor(mod.module, databaseSchema);
  const domain = domainKind(mod.module, product);
  const kind = screenKind(mod.module);
  const pick = {
    draft: () => draftBoard(mod, cols),
    roster: () => rosterBoard(mod, cols),
    pos: () => posBoard(mod, cols),
    archive: () => archiveBoard(mod, cols)
  };
  const generic = {
    tokens: () => tokenScreen(theme, onAccent),
    auth: () => authScreen(mod),
    report: () => reportScreen(mod, cols),
    search: () => searchScreen(mod, cols),
    entry: () => entryScreen(mod, cols),
    content: () => contentScreen(mod),
    ops: () => opsScreen(mod),
    table: () => tableScreen(mod, cols)
  };
  // Design System & auth selalu pakai bentuk generiknya; sisanya ikut domain.
  const useDomain = !['tokens', 'auth'].includes(kind) && domain !== 'generic';
  const body = useDomain ? pick[domain]() : generic[kind]();

  const ac = (mod.acceptanceCriteria || []).slice(0, 2);
  const edge = (mod.edgeCases || []).slice(0, 1);
  return `
  <section class="app-window" id="screen-${esc(mod.slug)}" data-screen="${esc(mod.slug)}" role="tabpanel" aria-labelledby="nav-${esc(mod.slug)}"${active ? '' : ' hidden'}>
    <header class="win-bar">
      <div class="win-dots" aria-hidden="true"><i></i><i></i><i></i></div>
      <span class="win-name">${esc(mod.module)}</span>
      <span class="win-kind">domain ${esc(useDomain ? domain : kind)}</span>
    </header>
    <div class="win-body">
      <div class="page-head-sm">
        <div>
          <h3>${esc(mod.module)}</h3>
          <p>${esc(mod.description || 'Belum ada deskripsi modul di PRD.')}</p>
        </div>
      </div>
      ${body}
      ${ac.length || edge.length ? `<details class="crit">
        <summary>Kriteria selesai &amp; alur gagal</summary>
        <ul>${ac.map((a) => `<li>${esc(a)}</li>`).join('')}${edge.map((e) => `<li class="edge">Alur gagal: ${esc(e)}</li>`).join('')}</ul>
      </details>` : ''}
    </div>
  </section>`;
}