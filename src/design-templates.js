// Perpustakaan design system siap pakai untuk PRD.
//
// Diturunkan dari skill desain yang sudah ada, bukan karangan:
// - ui-ux-design-pro / references/design-directions.md  -> token & personality
//   (Precision & Density, Warmth & Approachability, Sophistication & Trust,
//    Boldness & Clarity, Utility & Function, Data & Analysis, Playful & Expressive)
// - design-taste-frontend (taste-skill) -> larangan slop, disiplin arah visual
// - emil-design-eng -> aturan motion (duration, easing, property spesifik, hover media query)
//
// Dipakai dua arah:
// 1. Prompt PRD: model diberi daftar template ini agar memilih & menyalin nilai
//    konkret, tidak menebak.
// 2. (cadangan) Bisa langsung disuntikkan kalau model gagal mengisi bagian desain.

export const DESIGN_TEMPLATES = [
  {
    id: 'precision-density',
    name: 'Precision & Density',
    for: 'Developer tools, admin dashboard, monitoring, IDE-like',
    feel: 'Rapat, teknis, monokrom. Padat tapi tidak berantakan.',
    font: 'Geist / SF Pro / Inter (judul & teks), Geist Mono / SF Mono (angka)',
    scale: [4, 8, 12, 16, 24, 32],
    radius: '4px (tajam)',
    depth: 'Garis saja, tanpa bayangan',
    accent: 'Biru fungsional tunggal oklch(0.55 0.18 250)',
    dark: {
      bg: '#0d1117', surface: '#161b22', border: '#30363d',
      text: '#e6edf3', textMuted: '#8b949e', accent: '#4493f8',
      done: '#3fb950', progress: '#d29922', failed: '#f85149'
    },
    light: {
      bg: '#ffffff', surface: '#f6f8fa', border: '#d8dee4',
      text: '#1f2328', textMuted: '#59636e', accent: '#0969da',
      done: '#1a7f37', progress: '#9a6700', failed: '#cf222e'
    },
    patterns: ['Tombol kompak 28-32px', 'Baris tabel 32px', 'Kartu pakai garis, tanpa bayangan', 'Sidebar bisa collapse ikon saja'],
    note: 'PROGRESS memakai kuning; MERAH hanya untuk gagal. Jangan pakai merah untuk peringatan sedang.'
  },
  {
    id: 'warmth-approachability',
    name: 'Warmth & Approachability',
    for: 'Alat kolaborasi, aplikasi konsumen, onboarding, komunitas',
    feel: 'Luas, mengundang, lembut. Sudut membulat, ruang lega.',
    font: 'Plus Jakarta Sans / Inter / Nunito (judul & teks), JetBrains Mono (angka)',
    scale: [4, 8, 12, 16, 24, 32, 48],
    radius: '10-12px (lembut)',
    depth: 'Bayangan halus 1 tingkat',
    accent: 'Oranye hangat oklch(0.65 0.18 50)',
    dark: {
      bg: '#12100e', surface: '#1a1714', border: '#2e2821',
      text: '#f5f2eb', textMuted: '#b0a696', accent: '#f59e0b',
      done: '#10b981', progress: '#f59e0b', failed: '#ef4444'
    },
    light: {
      bg: '#fcfbf9', surface: '#ffffff', border: '#e7e2d9',
      text: '#1c1917', textMuted: '#57534e', accent: '#b45309',
      done: '#047857', progress: '#b45309', failed: '#b91c1c'
    },
    patterns: ['Tombol lega 40-44px, radius 12px', 'Kartu padding 24px + bayangan halus', 'Avatar & badge membulat', 'Empty state ramah + 1 tombol aksi'],
    note: 'Palet ini dipakai dashboard ngodingpakeai sendiri.'
  },
  {
    id: 'sophistication-trust',
    name: 'Sophistication & Trust',
    for: 'Fintech, enterprise B2B, legal, asuransi, kesehatan',
    feel: 'Tenang, berwibawa, berlapis. Menumbuhkan kepercayaan.',
    font: 'DM Sans / Outfit / Space Grotesk (judul & teks), JetBrains Mono (angka)',
    scale: [4, 8, 12, 16, 24, 32, 48],
    radius: '8px (seimbang)',
    depth: 'Bayangan berlapis halus (premium), maksimal 3 lapis',
    accent: 'Indigo/emerald tunggal oklch(0.5 0.16 260)',
    dark: {
      bg: '#0b1020', surface: '#141c30', border: '#26314a',
      text: '#e8ecf6', textMuted: '#93a0bd', accent: '#6366f1',
      done: '#10b981', progress: '#eab308', failed: '#ef4444'
    },
    light: {
      bg: '#f8fafc', surface: '#ffffff', border: '#e2e8f0',
      text: '#0f172a', textMuted: '#64748b', accent: '#4f46e5',
      done: '#047857', progress: '#a16207', failed: '#b91c1c'
    },
    patterns: ['Bayangan halus 3 lapis pada kartu', 'Angka metrik + indikator tren naik/turun', 'Warna konservatif, padat informasi tanpa riuh', 'Tabel lebar dengan ruang lega'],
    note: 'Untuk tampilan uang/transaksi: angka pakai font angka + tabular-nums supaya tidak bergeser.'
  },
  {
    id: 'boldness-clarity',
    name: 'Boldness & Clarity',
    for: 'Dashboard modern, produk penuh data, platform konten',
    feel: 'Kontras tinggi, ruang kosong dramatis, tipografi tegas.',
    font: 'Outfit / Sora (judul), Inter (teks), JetBrains Mono (angka)',
    scale: [8, 12, 16, 24, 32, 48, 64],
    radius: '6px',
    depth: 'Perbedaan warna permukaan + garis aksen',
    accent: 'Warna tunggal cerah (violet/coral/cyan)',
    dark: {
      bg: '#0a0a0a', surface: '#171717', border: '#2b2b2b',
      text: '#fafafa', textMuted: '#a3a3a3', accent: '#8b5cf6',
      done: '#22c55e', progress: '#f59e0b', failed: '#ef4444'
    },
    light: {
      bg: '#ffffff', surface: '#f5f5f5', border: '#e5e5e5',
      text: '#0a0a0a', textMuted: '#525252', accent: '#7c3aed',
      done: '#15803d', progress: '#b45309', failed: '#b91c1c'
    },
    patterns: ['Angka besar menonjol', 'Bagian selebar layar dengan spasi berani', 'Tombol aksi kontras tinggi', 'Jarak antar bagian lega'],
    note: null
  },
  {
    id: 'utility-function',
    name: 'Utility & Function',
    for: 'Alat gaya GitHub, dokumentasi, manajemen proyek, wiki',
    feel: 'Tenang, fungsional, konten yang utama. UI tidak mencolok.',
    font: 'Inter / system-ui (judul & teks), ui-monospace (angka/kode)',
    scale: [4, 8, 12, 16, 24, 32],
    radius: '6px',
    depth: 'Garis saja',
    accent: 'Biru/biru-hijau kalem',
    dark: {
      bg: '#0d1117', surface: '#161b22', border: '#30363d',
      text: '#c9d1d9', textMuted: '#8b949e', accent: '#58a6ff',
      done: '#3fb950', progress: '#d29922', failed: '#f85149'
    },
    light: {
      bg: '#ffffff', surface: '#f6f8fa', border: '#d0d7de',
      text: '#24292f', textMuted: '#57606a', accent: '#0969da',
      done: '#1a7f37', progress: '#9a6700', failed: '#cf222e'
    },
    patterns: ['Tabel & daftar padat', 'Navigasi sidebar dengan grup bersarang', 'Blok kode dengan latar berbeda', 'Menu aksi kompak'],
    note: null
  },
  {
    id: 'data-analysis',
    name: 'Data & Analysis',
    for: 'Analitik, BI, monitoring, observability',
    feel: 'Dioptimalkan untuk grafik, angka dulu, padat informasi.',
    font: 'Inter (label), JetBrains Mono (angka)',
    scale: [4, 8, 12, 16, 24, 32],
    radius: '4px (tajam demi presisi angka)',
    depth: 'Perbedaan warna permukaan',
    accent: 'Palet multi-warna untuk seri grafik (aman buta warna)',
    dark: {
      bg: '#0b0f17', surface: '#111827', border: '#1f2937',
      text: '#e5e7eb', textMuted: '#9ca3af', accent: '#3b82f6',
      done: '#22c55e', progress: '#f59e0b', failed: '#ef4444',
      chart: ['#3b82f6', '#14b8a6', '#f59e0b', '#8b5cf6', '#f87171']
    },
    light: {
      bg: '#ffffff', surface: '#f8fafc', border: '#e2e8f0',
      text: '#0f172a', textMuted: '#64748b', accent: '#2563eb',
      done: '#16a34a', progress: '#ca8a04', failed: '#dc2626',
      chart: ['#2563eb', '#0d9488', '#d97706', '#7c3aed', '#dc2626']
    },
    patterns: ['Metrik besar + grafik mini (sparkline)', 'Grid widget grafik', 'Tabel padat dengan visualisasi inline', 'Pemilih rentang waktu', 'Indikator pembaruan langsung'],
    note: 'Gunakan mode gelap kalau data ditampilkan terus-menerus.'
  },
  {
    id: 'playful-expressive',
    name: 'Playful & Expressive',
    for: 'Alat kreatif, portofolio, sosial, gamifikasi',
    feel: 'Membulat, berwarna, beranimasi. Kepribadian terasa.',
    font: 'Cabinet Grotesk / Outfit (judul & teks), JetBrains Mono (angka)',
    scale: [8, 12, 16, 24, 32, 48],
    radius: '16-20px (sangat membulat)',
    depth: 'Bayangan halus + garis berwarna',
    accent: 'Berani, boleh lebih dari satu (violet, pink, lime)',
    dark: {
      bg: '#141021', surface: '#1e1830', border: '#332b4a',
      text: '#f4f1fa', textMuted: '#a89cc4', accent: '#a855f7',
      done: '#34d399', progress: '#fbbf24', failed: '#f87171'
    },
    light: {
      bg: '#fdfcff', surface: '#ffffff', border: '#ece7f5',
      text: '#1e1830', textMuted: '#6b5f85', accent: '#9333ea',
      done: '#059669', progress: '#b45309', failed: '#dc2626'
    },
    patterns: ['Semua membulat: kartu, tombol, badge, input', 'Animasi kecil saat interaksi', 'Aksen gradien secukupnya', 'Empty state bergambar'],
    note: 'Emoji tetap DILARANG sebagai ikon meski arah ini playful. Pakai ikon SVG (lucide).'
  }
];

export const MOTION_RULES = [
  'Sebagian besar transisi 150-250ms; tidak ada animasi di atas 300ms untuk interaksi.',
  'Sebutkan properti yang berubah secara spesifik (mis. transform/opacity), jangan ever "transition: all".',
  'Animasi masuk dan keluar memakai properti murah: transform + opacity saja.',
  'Hormati prefers-reduced-motion: matikan/miringkan animasi saat pengguna memintanya.',
  'Hover hanya dengan media query (hover: hover) and (pointer: fine), supaya tidak nyangkut di layar sentuh.',
  'Pakai CSS transition untuk elemen yang sering dipicu (bisa dibatalkan di tengah); keyframes untuk animasi sekali jalan.'
];

// Aturan dari skill `impeccable` (reference/craft-floor.md + craft mechanics).
// Ini pemeriksaan mekanis pada hasil akhir, bukan arahan rasa.
export const IMPECCABLE_RULES = [
  'Permukaan browser wajib ikut didesain: warna seleksi teks (::selection), caret (caret-color), scrollbar (scrollbar-color), focus ring (:focus-visible), dan underline-offset. Ini tanda paling murah bahwa halaman benar-benar dibangun, bukan disusun asal.',
  'Angka pada tabel/metrik wajib pakai font-variant-numeric: tabular-nums supaya tidak bergeser saat nilainya berubah.',
  'Kontras: teks isi dan placeholder minimal 4.5:1; teks besar minimal 3:1. Teks sekunder di atas bidang berwarna diturunkan dari warna bidang itu, jangan abu-abu netral.',
  'Bayangan wajib punya offset dan blur lembut. Halo berwarna tanpa offset itu hiasan, bukan kedalaman.',
  'Jarak: kelompok yang dekat dirapatkan, antar bagian diberi ruang lega, dan jarak DI ATAS judul harus lebih besar daripada di bawahnya.',
  'Tipografi: lebar baris isi 65-75 karakter, ukuran display maksimal 6rem, letter-spacing paling rapat -0.04em, dan langkah ukuran/bobot harus jelas terlihat.',
  'Motion: satu momen animasi yang disengaja, bukan efek tersebar dan bukan animasi masuk yang sama persis di setiap bagian. Pakai exponential ease-out, mulai dari keadaan yang sudah terlihat.',
  'Keadaan wajib lengkap: hover, disabled, loading, error, empty. Plus konten nyata, kontrol yang benar-benar bekerja, susunan responsif, dan focus keyboard.',
  'DILARANG gradien teks. Penekanan datang dari bobot atau ukuran.',
  'DILARANG kaca/blur sebagai hiasan; blur hanya untuk efek yang jelas tujuannya.',
  'DILARANG border-left/border-right berwarna di atas 1px pada kartu, item daftar, atau peringatan.',
  'DILARANG bayangan offset keras (mis. box-shadow: 4px 4px 0) kecuali gaya neobrutalis yang memang dipilih sadar.',
  'DILARANG monospace sebagai kostum "terkesan teknis". Monospace hanya untuk kode, data, atau angka ukuran.',
  'DILARANG label kecil (kicker/eyebrow) di atas judul. Judul harus berdiri sendiri.',
  'DILARANG kartu berukuran sama berisi ikon + judul + teks sebagai struktur halaman. Kartu adalah wadah malas, dan kartu bersarang selalu salah.',
  'DILARANG nomor bagian (01/02/03) kecuali urutannya memang membawa informasi yang dibutuhkan pembaca.'
];

export const ANTI_GENERIC_RULES = [
  'DILARANG memakai emoji sebagai ikon. Pakai ikon SVG (mis. lucide) dengan ukuran 16/20/24px dan stroke 1.5-2px.',
  'DILARANG memakai gradien sebagai latar utama. Gradien hanya boleh untuk aksen kecil, maksimal satu.',
  'Maksimal 1 tingkat bayangan di seluruh aplikasi (2 kalau benar-benar perlu, mis. modal).',
  'DILARANG memakai tanda pisah panjang (em-dash maupun en-dash) di teks antarmuka. Pakai titik, koma, atau titik dua.',
  'DILARANG memakai ungu-biru gradien sebagai aksen bawaan tanpa alasan dari domain aplikasi.',
  'Setiap keadaan kosong (empty state) wajib punya penjelasan singkat + 1 tombol tindakan. Dilarang gambar lucu tanpa penjelasan.',
  'Warna status hanya dari palet: hijau = selesai/berhasil, kuning = proses/menunggu, merah = gagal/berbahaya. Jangan pakai warna status untuk dekorasi.',
  'Maksimal 2 keluarga font di seluruh aplikasi.',
  'Kontras teks terhadap latarnya minimal 4.5:1 untuk teks biasa (3:1 untuk teks besar).',
  'Target sentuh minimal 40x40px untuk tombol di antarmuka yang dipakai dari HP.',
  'Angka pada tabel dan metrik memakai font angka + tabular-nums supaya tidak bergeser saat berubah.'
];

// Ringkasan untuk disuntikkan ke prompt: model memilih SATU template lalu
// menyalin nilainya, bukan mengarang palet.

// Dipakai dropdown + kartu pratinjau di UI: user boleh memilih arah visual
// sendiri, atau membiarkan model memilih berdasarkan brief. `light` ikut
// diekspor supaya kartu bisa menampilkan palet tanpa fetch tambahan.
export const DESIGN_DIRECTIONS = DESIGN_TEMPLATES.map(({ id, name, for: use, light }) => ({
  id, name, use,
  light: ['bg', 'surface', 'border', 'text', 'textMuted', 'accent', 'done'].map(k => light[k])
}));

export function designDirectionPromptBlock(chosenId) {
  if (!chosenId) return 'Arah visual: PILIH SENDIRI berdasarkan brief, lalu sebutkan id dan alasannya di modul Design System.';
  const t = DESIGN_TEMPLATES.find(x => x.id === chosenId);
  if (!t) return 'Arah visual: PILIH SENDIRI berdasarkan brief, lalu sebutkan id dan alasannya di modul Design System.';
  const d = t.dark, l = t.light;
  return `Arah visual WAJIB: ${t.name} (id: ${t.id}) karena ${t.for}. Pengguna sudah memilih arah ini; jangan menggantinya dengan arah lain.
feels: ${t.feel}
font: ${t.font}
spasi: ${t.scale.join('/')} px | radius: ${t.radius} | kedalaman: ${t.depth}
aksen: ${t.accent}
gelap: bg ${d.bg}, surface ${d.surface}, border ${d.border}, teks ${d.text}, teks-sekunder ${d.textMuted}, aksen ${d.accent}, status ${d.done}/${d.progress}/${d.failed}
terang: bg ${l.bg}, surface ${l.surface}, border ${l.border}, teks ${l.text}, teks-sekunder ${l.textMuted}, aksen ${l.accent}, status ${l.done}/${l.progress}/${l.failed}
pola: ${t.patterns.join('; ')}${t.note ? `\ncatatan: ${t.note}` : ''}
Tulis modul Design System memakai nilai di atas apa adanya (boleh menyesuaikan satu token bila ada alasan domain yang kuat, dan sebutkan alasannya).`;
}
export function designTemplatePromptBlock() {
  return `
=== REFERENSI ARAH VISUAL (TITIK AWAL, BUKAN TEMPLATE WAJIB) ===
Pilih satu arah yang cocok setelah membaca brief. Sebutkan id, nama, alasan, dan adaptations yang dipakai. Pertahankan branding eksisting. Boleh mengubah token dengan alasan domain, tetapi jangan menggabungkan dua arah tanpa alasan.

Template bukan daftar tampilan generik. Jangan memakai ini tanpa kecocokan domain:
- precision-density: dashboard/devtools/monitoring.
- warmth-approachability: kolaborasi/konsumen/onboarding.
- sophistication-trust: fintech/health/legal/enterprise.
- boldness-clarity: consumer memusatkan perhatian pada satu aksi.
- utility-function: admin/internal tools.
- data-analysis: monitoring/analitik real-time.
- playful-expressive: kreatif/gamifikasi yang memang playful.

Untuk arah dengan >1 aksen (boldness-clarity, data-analysis, playful-expressive), pilih aksen domain yang relevan sebagai warna utama. Status done/progress/failed tetap semantik dan tidak menjadi dekorasi.

=== MOTION DAN CRAFT FLOOR (WAJIB) ===
${[...MOTION_RULES, ...IMPECCABLE_RULES, ...ANTI_GENERIC_RULES].map(r => '- ' + r).join('\n')}
`;
}
