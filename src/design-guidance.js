// Portable, curated snapshot of the installed design skills. No runtime access
// to a user's home directory and no requirement to install skills on the target.
export const DESIGN_GUIDANCE_VERSION = '1.0';
export const DESIGN_SKILL_SOURCES = Object.freeze([
  'design-taste-frontend', 'ui-ux-design-pro', 'emil-design-eng'
]);

export function getDesignGuidance() {
  return `KONTRAK DESAIN ANTI AI-SLOP v${DESIGN_GUIDANCE_VERSION}
Sumber: ringkasan terkurasi ${DESIGN_SKILL_SOURCES.join(', ')}. Prompt ini portabel, tidak bergantung skill atau instalasi lokal.

1. JANGAN PAKAI TEMPLATE ACAK. BACA BRIEF, TENTUKAN KONSEKS, LALU KUSTOM.
Untuk aplikasi/dashboard: prioritaskan pekerjaan pengguna, kepadatan informasi, tabel/list/filter yang berguna, navigasi, dan satu aksi utama per konteks. Jangan jadikan landing page. Untuk landing/portofolio: bangun narasi khusus produk, hierarchy yang disengaja, bukti nyata, dan CTA jelas. Jangan memakai hero + tiga kartu generik. Untuk CLI/bot/API/library tanpa UI: aturan visual tidak berlaku; jangan tambah dashboard, login, design-system task, atau frontend untuk memenuhi checklist.
Tulis Design Read satu kalimat: jenis halaman, pengguna utama, pekerjaan utama, karakter merek, arah visual, dan alasannya. Pertahankan aset, token, dan branding yang sudah ada saat redesign. Preferensi eksplisit pengguna dan aksesibilitas mengalahkan contoh estetika.
2. KONKRETKAN SETIAP KEPUTUSAN.
Modul Design System menetapkan token semantik background/surface/text/muted/border/accent/focus/status beserta HEX/OKLCH, keluarga font dan fallback, ukuran/weight/line-height, spacing, radius, strategi border/shadow, lebar konten, dan breakpoint. Tentukan anatomi halaman utama, proporsi, komponen, data realistis, serta perilaku desktop/mobile. Jelaskan 2-3 keputusan khas produk, bukan dekorasi generik.
3. ANTI-SLOP YANG BISA DIJELASKAN.
Tidak ada gradient, glow, blur, glass, atau bento sebagai dekorasi tanpa kebutuhan. Tidak ada emoji sebagai ikon, fake testimonial, fake metrics, lorem ipsum, CTA mati, atau copy marketing hampa. Pakai satu keluarga ikon SVG konsisten. Tulis label, empty-state, loading, dan error-copy yang spesifik terhadap domain.
4. AKSESIBILITAS ADALAH SYARAT, BUKAN CATATAN AKHIR.
Setiap warna teks dan status harus punya kontras; teks normal sedikitnya 4.5:1, teks besar dan kontrol penting sedikitnya 3:1. Warna tidak boleh menjadi satu-satunya penanda status. Semua fungsi harus dapat dipakai keyboard dengan focus ring dan tab order masuk akal. Input punya label programatik, aset informatif punya alt text, tabel punya header semantik, dan tabel lebar memakai overflow lokal. Target sentuh 44px, kurangi sesuai konteks tanpa merusak keterbacaan. Uji alur sukses, gagal, kosong, hover, focus, disabled, loading, dan error.
5. CRAFT TANPA MENGORBANKAN KECEPATAN.
Motion hanya untuk orientasi atau feedback, umumnya 150-250ms, transform/opacity, properti transition eksplisit, jangan memakai \`transition: all\`. Hormati \`prefers-reduced-motion\`; batasi hover ke pointer yang mendukungnya. Tahan double-submit, jangan geser layout saat loading, dan jangan menampilkan copy sukses sebelum operasi benar-benar berhasil.
6. BUKTI SEBELUM SELESAI.
Uji alur utama, kegagalan, data kosong, keyboard, 375/768/1440px, dan reduced-motion. Periksa overflow, kontras terukur, hierarchy, konsistensi token, serta interaksi. Bedakan yang diuji otomatis, manual, dan belum diuji. Jangan mengklaim desain anti-slop hanya karena checklist atau nama skill tercantum.`;
}
