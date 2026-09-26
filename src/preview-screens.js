// Layar contoh per modul PRD.
//
// Preview lama menampilkan SATU kartu generik (tombol + input + tabel task) yang
// sama untuk semua aplikasi, jadi tidak bisa dipakai menilai produknya.
// Modul ini membaca fitur, skema data, dan endpoint dari PRD, lalu merender
// layar yang benar-benar relevan untuk domain itu:
//   - domain tabel (data master)      -> daftar + filter + form tambah
//   - domain transaksi/pencatatan      -> form entri padat + ringkasan status
//   - domain laporan/rekap             -> ringkasan angka + tabel periode
//   - domain pencarian                 -> kolom cari + hasil
//   - auth/akun                        -> form masuk / daftar pengguna
//   - design system                    -> token (swatch, tipografi, jarak)
//
// Aturan yang dipegang (dari skill impeccable/ui-ux-design-pro/emil-design-eng):
// anatomi halaman nyata (judul, ringkasan, aksi utama, isi), keadaan kosong &
// gagal yang spesifik domain, label programatik, status tidak hanya warna,
// target sentuh 44px, dan motion yang tunduk pada prefers-reduced-motion.
//
// Data contoh dibangkitkan dari NAMA FIELD di databaseSchema sehingga tabel dan
// formulir menampilkan kolom yang benar-benar dimiliki aplikasi itu.

const esc = (s) => String(s == null ? '' : s)
  .replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Jenis produk menentukan BENTUK preview secara keseluruhan.
// Portofolio/landing TIDAK boleh dirender sebagai dashboard tabel (aturan
// design-taste-frontend: bangun narasi khusus produk, bukan hero + tiga kartu
// generik; dan jangan jadikan landing page). Aplikasi data dirender sebagai
// layar kerja (daftar/entri/laporan). CLI/bot tanpa UI tidak dapat layar.
export function productKind({ features = [], summary = '', architecture = '' } = {}) {
  // Hanya ISI PROSA yang dinilai, bukan nama modul: modul "Hero Browser" di
  // aplikasi draft game dulu salah membuat seluruh produk terdeteksi sebagai
  // portofolio hanya karena katanya mengandung "hero".
  const text = [summary, architecture].join(' ').toLowerCase();
  const featureNames = features.map(f => (f && f.module) || '').join(' ').toLowerCase();
  const all = text + ' ' + featureNames;
  if (/\b(cli|command.?line|bot\b|library|pustaka|tanpa ui\b|tanpa antarmuka|api saja)\b/.test(all)) return 'nonui';
  // Sinyal kuat: kata jenis produk di prosa, ATAU modul bernama bagian situs
  // profil (hero/pendidikan/pengalaman/proyek) yang tidak ada di aplikasi kerja.
  const proseShowcase = /portofolio|portfolio|landing page|company profile|profil perusahaan|resume|cv\b|undangan|microsite|situs profil|one.?page/.test(text);
  const featureShowcase = /\b(hero|pendidikan|pengalaman (kerja|magang)|proyek pilihan|achievement|sertifikasi|skill & tools|kontak)\b/.test(featureNames)
    && !/dashboard|admin|login|auth|transaksi|pesanan|stok|presensi|absensi|rekap|laporan|pesanan|checkout/.test(featureNames);
  return (proseShowcase || featureShowcase) ? 'showcase' : 'app';
}

// Klasifikasi modul dari namanya. Dipakai untuk memilih bentuk layar.
export function screenKind(moduleName = '') {
  const n = moduleName.toLowerCase();
  if (/design system|sistem desain|design token/.test(n)) return 'tokens';
  if (/auth|login|masuk|sesi|akun|pengguna|user|otentikasi|autentikasi/.test(n)) return 'auth';
  if (/laporan|rekap|rekapitulasi|statistik|dashboard|ringkas|analitik|laporan/.test(n)) return 'report';
  if (/cari|pencarian|pencarian|search|filter/.test(n)) return 'search';
  // Bagian khas portofolio/landing.
  if (/hero|profil|pendidikan|pengalaman|proyek|achievement|sertifik|aktivitas|organisasi|skill|kontak|testimoni|harga|paket|faq|fitur utama/.test(n)) return 'content';
  if (/seo|metadata|deployment|deploy|analytics|konfigurasi|setup/.test(n)) return 'ops';
  if (/presensi|absensi|kehadiran|transaksi|pencatatan|entri|catat|stok|inventaris|pesanan|order|pembayaran|nilai|jadwal/.test(n)) return 'entry';
  return 'table';
}

// Layar: bagian konten (portofolio/landing). Bukan tabel, bukan hero generik:
// blok bernarasi dengan label domain, item nyata, dan aksi yang jelas.
function contentScreen(mod) {
  const n = mod.module.toLowerCase();
  const isList = /pendidikan|pengalaman|proyek|achievement|sertifik|aktivitas|organisasi|skill/.test(n);
  const isContact = /kontak|contact/.test(n);
  const isHero = /hero|profil/.test(n);
  if (isContact) {
    return `
  <div class="content">
    <p class="lead">Ada peran, proyek, atau kolaborasi yang cocok? Kirim pesan lewat formulir atau WhatsApp.</p>
    <div class="entry-grid">
      <label class="field"><span>Nama</span><input value="Rekruter PT Contoh" /></label>
      <label class="field"><span>Email</span><input type="email" value="hr@contoh.co.id" /></label>
      <label class="field"><span>Pesan</span><input value="Kami tertarik mendiskusikan peran backend." /></label>
    </div>
    <div class="entry-foot">
      <button class="btn-primary" type="button">Kirim pesan</button>
      <a class="btn-ghost" href="#mod-${esc(mod.slug)}">Chat WhatsApp</a>
      <span class="hint">Balasan dalam 1×24 jam kerja. Formulir punya status sukses dan gagal yang jelas.</span>
    </div>
  </div>`;
  }
  if (isHero) {
    return `
  <div class="hero-blk">
    <p class="eyebrow">Backend Engineer · Jakarta</p>
    <p class="hero-title">Membangun layanan yang tenang dan bisa diandalkan.</p>
    <p class="lead">Tiga tahun menangani API dan basis data untuk produk internal, dari perancangan skema sampai pemantauan produksi.</p>
    <div class="row">
      <a class="btn-primary" href="#mod-${esc(mod.slug)}">Lihat proyek</a>
      <a class="btn-ghost" href="#mod-${esc(mod.slug)}">Unduh CV</a>
    </div>
  </div>`;
  }
  if (isList) {
    const items = [
      ['2024 — sekarang', 'Backend Engineer, PT Contoh', 'Merancang API absensi untuk 300 siswa; menurunkan waktu rekap dari 20 menit ke 4 detik.'],
      ['2022 — 2024', 'Backend Developer, Startup Contoh', 'Memindahkan basis data ke SQLite terkelola dan menutup 40 temuan keamanan.'],
      ['2021', 'Magang, Dinas Contoh', 'Membangun dasbor laporan mingguan yang dipakai 12 petugas.']
    ];
    return `
  <ul class="timeline">
    ${items.map(([when, what, why]) => `<li><span class="when">${esc(when)}</span><b>${esc(what)}</b><p>${esc(why)}</p></li>`).join('')}
  </ul>`;
  }
  return `
  <div class="content"><p class="lead">${esc(mod.description || 'Bagian ini menjelaskan isi dan bukti nyata, bukan klaim kosong.')}</p></div>`;
}

// Layar: teknis/operasional (SEO, deployment, konfigurasi) — checklist nyata.
function opsScreen(mod) {
  return `
  <ul class="checklist">
    ${['Judul dan deskripsi per halaman terisi', 'Open Graph dan kartu pratinjau tersedia', 'Peta situs dan robots.txt benar', 'Skor aksesibilitas dan performa diperiksa sebelum rilis']
      .map((t, i) => `<li><span class="chk ${i < 2 ? 'ok' : 'neutral'}" aria-hidden="true">${i < 2 ? '✓' : '○'}</span>${esc(t)}</li>`).join('')}
  </ul>
  <p class="hint">Status memakai simbol dan label teks, bukan hanya warna.</p>`;
}

// Ambil nama kolom dari definisi tabel yang cocok dengan kata kunci modul.
function columnsFor(moduleName, databaseSchema = []) {
  const words = moduleName.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3);
  const scored = databaseSchema
    .filter((t) => t && t.table)
    .map((t) => {
      const name = String(t.table).toLowerCase();
      const score = words.filter((w) => name.includes(w) || w.includes(name)).length;
      return { t, score };
    })
    .sort((a, b) => b.score - a.score);
  const best = scored.find((x) => x.score > 0) || scored[0];
  if (!best || !Array.isArray(best.t.fields)) return null;
  const cols = best.t.fields
    .map((f) => String(f).trim().split(/[\s(]/)[0])
    .filter((c) => c && !/^(id|created_at|updated_at|password_hash|token_hash|deleted_at)$/i.test(c));
  return { table: best.t.table, columns: cols.slice(0, 5) };
}

// Contoh isi kolom yang masuk akal untuk domain Indonesia, supaya layar tidak
// menampilkan "lorem ipsum" yang justru dilarang kontrak anti-slop.
function sampleFor(col) {
  const c = col.toLowerCase();
  if (/nama|name|siswa|murid|petugas|guru|user|pengguna/.test(c)) return ['Ahmad Fauzi', 'Siti Nurhaliza', 'Budi Santoso', 'Dewi Lestari'];
  if (/kelas|class|rombel|jurusan|prodi/.test(c)) return ['XII RPL 1', 'XI TKJ 2', 'X AKL 1', 'XII RPL 2'];
  if (/tanggal|date|tgl|waktu|jam|periode|bulan/.test(c)) return ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04'];
  if (/status|kehadiran|state/.test(c)) return ['Hadir', 'Izin', 'Sakit', 'Alfa'];
  if (/nomor|no_|kode|kode_|kode|nis|nip|npsn/.test(c)) return ['2026001', '2026002', '2026003', '2026004'];
  if (/judul|title|uraian|keterangan|deskripsi|catatan/.test(c)) return ['Surat undangan rapat', 'Laporan bulanan', 'Nota dinas', 'Berita acara'];
  if (/jumlah|total|nominal|harga|biaya|saldo|nilai/.test(c)) return ['12', '28', '7', '35'];
  if (/email|surel/.test(c)) return ['ahmad@sekolah.sch.id', 'siti@sekolah.sch.id', 'budi@sekolah.sch.id', 'dewi@sekolah.sch.id'];
  if (/role|peran|hak|akses/.test(c)) return ['admin', 'petugas', 'petugas', 'wali kelas'];
  return ['Contoh 1', 'Contoh 2', 'Contoh 3', 'Contoh 4'];
}

const statusClass = (v) => {
  const s = String(v).toLowerCase();
  if (/hadir|selesai|aktif|sukses|berhasil|dibayar|lunas/.test(s)) return 'ok';
  if (/izin|sakit|proses|tunda|pending|sebagian/.test(s)) return 'warn';
  if (/alfa|absen|gagal|batal|tolak|nonaktif/.test(s)) return 'bad';
  return 'neutral';
};

// Layar: daftar data master (tabel + filter + aksi).
function tableScreen(mod, cols, endpoints) {
  const head = cols ? cols.columns : ['nama', 'keterangan', 'status'];
  const rows = [0, 1, 2, 3].map((i) => head.map((c) => sampleFor(c)[i]));
  const fetcher = endpoints.find((e) => /get/i.test(e.method) && new RegExp(mod.module.split(' ')[0], 'i').test(e.path)) || endpoints[0];
  return `
  <div class="screen-bar">
    <label class="search" for="s-${esc(mod.slug)}">
      <span class="vh">Cari ${esc(mod.module)}</span>
      <input id="s-${esc(mod.slug)}" type="search" placeholder="Cari ${esc(mod.module.toLowerCase())}…" data-field="cari">
    </label>
    <button class="btn-primary" type="button">Tambah ${esc(mod.module.split(' ')[0])}</button>
  </div>
  <div class="tbl-wrap">
    <table class="tbl">
      <caption class="vh">Daftar ${esc(mod.module)}</caption>
      <thead><tr>${head.map((c) => `<th scope="col">${esc(c.replace(/_/g, ' '))}</th>`).join('')}<th scope="col">Status</th><th scope="col"><span class="vh">Aksi</span></th></tr></thead>
      <tbody>
        ${rows.map((r, i) => `<tr>
          ${r.map((v, j) => `<td${j === 0 ? ' class="strong"' : ''}>${esc(v)}</td>`).join('')}
          <td><span class="pill ${statusClass(sampleFor('status')[i])}">${esc(sampleFor('status')[i])}</span></td>
          <td><button class="btn-ghost sm" type="button" aria-label="Ubah baris ${i + 1}">Ubah</button></td>
        </tr>`).join('')}
      </tbody>
    </table>
  </div>
  <p class="hint">${fetcher ? `Data dari <code>${esc(fetcher.method)} ${esc(fetcher.path)}</code>. ` : ''}Filter dan pencarian bekerja di server; tabel kosong menampilkan ajakan menambah, bukan ruang hampa.</p>`;
}

// Layar: pencatatan/entri transaksi.
function entryScreen(mod, cols) {
  const fields = cols ? cols.columns.slice(0, 4) : ['siswa', 'tanggal', 'status', 'catatan'];
  const statusIdx = fields.findIndex((f) => /status|kehadiran/i.test(f));
  return `
  <form class="entry" onsubmit="return false">
    <div class="entry-grid">
      ${fields.map((f, i) => `<label class="field">
        <span>${esc(f.replace(/_/g, ' '))}</span>
        ${i === statusIdx
          ? `<select data-field="${esc(f)}">${['Hadir', 'Izin', 'Sakit', 'Alfa'].map((o) => `<option>${o}</option>`).join('')}</select>`
          : `<input data-field="${esc(f)}" value="${esc(sampleFor(f)[0])}" />`}
      </label>`).join('')}
    </div>
    <div class="entry-foot">
      <button class="btn-primary" type="submit">Simpan ${esc(mod.module.split(' ')[0])}</button>
      <button class="btn-ghost" type="reset">Kosongkan</button>
      <span class="hint">Belum ada yang disimpan. Tombol dinonaktifkan sementara proses berjalan supaya tidak terkirim dua kali.</span>
    </div>
  </form>
  <div class="tally">
    ${[['Hadir', 28, 'ok'], ['Izin', 3, 'warn'], ['Sakit', 2, 'warn'], ['Alfa', 1, 'bad']].map(([l, n, k]) => `
      <div class="tally-item"><span class="pill ${k}">${l}</span><b>${n}</b><span class="hint">siswa</span></div>`).join('')}
  </div>`;
}

// Layar: laporan/rekap.
function reportScreen(mod, cols) {
  const head = cols ? cols.columns : ['periode', 'jumlah'];
  return `
  <div class="filters">
    <label class="field sm"><span>Periode</span><input type="month" value="2026-09" /></label>
    <label class="field sm"><span>Kelompok</span><select><option>Semua</option><option>XII RPL 1</option><option>XI TKJ 2</option></select></label>
    <button class="btn-ghost" type="button">Terapkan</button>
    <button class="btn-ghost" type="button">Ekspor CSV</button>
  </div>
  <div class="kpis">
    ${[['Total', '1.248'], ['Rata-rata', '94,2%'], ['Terendah', '78,1%']].map(([l, v]) => `
      <div class="kpi"><span class="hint">${l}</span><b>${v}</b></div>`).join('')}
  </div>
  <div class="tbl-wrap">
    <table class="tbl">
      <caption class="vh">Rekap ${esc(mod.module)}</caption>
      <thead><tr>${head.map((c) => `<th scope="col">${esc(c.replace(/_/g, ' '))}</th>`).join('')}<th scope="col">Perubahan</th></tr></thead>
      <tbody>
        ${['XII RPL 1', 'XI TKJ 2', 'X AKL 1'].map((k, i) => `<tr>
          <td class="strong">${esc(k)}</td>
          ${head.slice(1).map((c) => `<td>${esc(sampleFor(c)[i])}</td>`).join('')}
          <td><span class="pill ${i === 2 ? 'bad' : 'ok'}">${i === 2 ? '−2,4%' : '+1,8%'}</span></td>
        </tr>`).join('')}
      </tbody>
    </table>
  </div>
  <p class="hint">Angka direkap dari data transaksi, bukan tabel salinan, sehingga tidak bisa melenceng dari sumbernya.</p>`;
}

// Layar: pencarian.
function searchScreen(mod, cols) {
  const head = cols ? cols.columns : ['nama', 'keterangan'];
  return `
  <form class="entry" onsubmit="return false">
    <div class="entry-grid">
      <label class="field"><span>Kata kunci</span><input type="search" placeholder="Nomor, judul, atau nama…" /></label>
      <label class="field"><span>Filter status</span><select><option>Semua</option><option>Aktif</option><option>Selesai</option></select></label>
    </div>
    <div class="entry-foot"><button class="btn-primary" type="submit">Cari</button><span class="hint">Tekan Enter untuk mencari. Hasil muncul di bawah tanpa memuat ulang halaman.</span></div>
  </form>
  <div class="tbl-wrap">
    <table class="tbl">
      <caption class="vh">Hasil pencarian</caption>
      <thead><tr>${head.map((c) => `<th scope="col">${esc(c.replace(/_/g, ' '))}</th>`).join('')}</tr></thead>
      <tbody>${[0, 1, 2].map((i) => `<tr>${head.map((c, j) => `<td${j === 0 ? ' class="strong"' : ''}>${esc(sampleFor(c)[i])}</td>`).join('')}</tr>`).join('')}</tbody>
    </table>
  </div>`;
}

// Layar: autentikasi / akun.
function authScreen(mod, cols) {
  if (/masuk|login|sesi|auth/i.test(mod.module)) {
    return `
  <form class="auth" onsubmit="return false">
    <label class="field"><span>Nama pengguna</span><input autocomplete="username" /></label>
    <label class="field"><span>Kata sandi</span><input type="password" autocomplete="current-password" /></label>
    <button class="btn-primary" type="submit">Masuk</button>
    <p class="err" role="alert">Nama pengguna atau kata sandi tidak cocok. Coba lagi.</p>
    <p class="hint">Sesi disimpan di server sebagai cookie HttpOnly; kata sandi di-hash, tidak pernah disimpan mentah.</p>
  </form>`;
  }
  return tableScreen(mod, cols, []);
}

// Layar: token design system.
function tokenScreen(theme, onAccent) {
  const swatches = [['Latar', theme.bg], ['Permukaan', theme.surface], ['Garis', theme.border], ['Teks', theme.text], ['Redam', theme.muted], ['Aksen', theme.accent], ['Selesai', theme.done], ['Proses', theme.progress], ['Gagal', theme.failed]];
  return `
  <div class="tokens">
    <div class="sw-row">${swatches.map(([l, v]) => `
      <div class="sw"><span class="chip" style="background:${v}"></span><b>${l}</b><code>${v}</code></div>`).join('')}
    </div>
    <div class="type-row">
      <div><span class="hint">Judul halaman</span><p class="t-h1">Presensi Kelas XII RPL 1</p></div>
      <div><span class="hint">Isi</span><p class="t-body">Catat kehadiran satu kelas untuk satu tanggal. Perubahan tersimpan sebagai satu transaksi.</p></div>
      <div><span class="hint">Angka rekap</span><p class="t-num">1.248</p></div>
    </div>
    <div class="row">
      <button class="btn-primary" style="background:${theme.accent};color:${onAccent}">Aksi utama</button>
      <button class="btn-ghost">Batal</button>
      <button class="btn-ghost" disabled>Nonaktif</button>
      <span class="pill ok">Hadir</span><span class="pill warn">Izin</span><span class="pill bad">Alfa</span>
    </div>
  </div>`;
}

// Bangun satu layar lengkap untuk sebuah modul, memakai data PRD.
export function buildModuleScreen(mod, ctx) {
  const { databaseSchema, apiEndpoints, theme, onAccent } = ctx;
  const cols = columnsFor(mod.module, databaseSchema);
  const kind = screenKind(mod.module);
  const body = {
    tokens: () => tokenScreen(theme, onAccent),
    auth: () => authScreen(mod, cols),
    report: () => reportScreen(mod, cols),
    search: () => searchScreen(mod, cols),
    entry: () => entryScreen(mod, cols),
    content: () => contentScreen(mod),
    ops: () => opsScreen(mod),
    table: () => tableScreen(mod, cols, apiEndpoints)
  }[kind]();

  const ac = (mod.acceptanceCriteria || []).slice(0, 2);
  const edge = (mod.edgeCases || []).slice(0, 1);
  return `
  <section class="app-window" id="mod-${esc(mod.slug)}" aria-labelledby="h-${esc(mod.slug)}">
    <header class="win-bar">
      <div class="win-dots" aria-hidden="true"><i></i><i></i><i></i></div>
      <span class="win-name">${esc(mod.module)}</span>
      <span class="win-kind">layar ${kind}</span>
    </header>
    <div class="win-body">
      <div class="page-head-sm">
        <div>
          <h3 id="h-${esc(mod.slug)}">${esc(mod.module)}</h3>
          <p>${esc(mod.description || '')}</p>
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

export const previewHelpers = { esc, columnsFor, sampleFor, statusClass };
