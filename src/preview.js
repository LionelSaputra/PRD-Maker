// Preview UI: mengubah modul Design System di dalam PRD menjadi halaman HTML
// yang bisa dibuka di browser, supaya user bisa MELIHAT hasil desainnya sebelum
// menyuruh AI membangun aplikasinya.
//
// Cara kerja: palet HEX dan aturan dibaca dari features_json (yang sudah berisi
// template design system pilihan model), lalu dirender jadi halaman contoh.
// Sengaja tanpa dependensi: satu fungsi, keluaran HTML mandiri.

const HEX_RE = /#([0-9a-fA-F]{6})\b/g;

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function luminance(hex) {
  const [r, g, b] = hexToRgb(hex).map(v => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a, b) {
  const la = luminance(a), lb = luminance(b);
  const hi = Math.max(la, lb), lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

// Tarik semua HEX dari modul design system.
function extractHexes(dsText) {
  return [...new Set((dsText.match(HEX_RE) || []).map(h => h.toLowerCase()))];
}

// Deteksi peran warna dari HUE, bukan dari urutan penulisan. Urutan penulisan
// berbeda-beda antar model; hue tidak.
function hueOf(hex) {
  const [r, g, b] = hexToRgb(hex).map(v => v / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (d === 0) return { h: 0, s: 0 };
  let h;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h = (h * 60 + 360) % 360;
  const l = (max + min) / 2;
  const s = d / (1 - Math.abs(2 * l - 1) || 1);
  return { h, s };
}

// Pilih warna paling dekat dengan hue tertentu (hijau ~140, kuning ~45, merah ~5).
function statusColor(pool, targetHue, fallback) {
  const scored = pool
    .map(c => ({ c, ...hueOf(c) }))
    .filter(x => x.s > 0.25)
    .map(x => ({ c: x.c, dist: Math.min(Math.abs(x.h - targetHue), 360 - Math.abs(x.h - targetHue)) }))
    .filter(x => x.dist < 50)
    .sort((a, b) => a.dist - b.dist);
  return scored.length ? scored[0].c : fallback;
}

// Bangun tema terang & gelap dari sekumpulan warna, apa pun urutannya.
// Kunci: peran ditentukan oleh luminansi & hue, bukan posisi di teks.
function buildThemes(hexes) {
  const DEFAULTS = {
    dark: { bg: '#0b0f17', surface: '#111827', border: '#1f2937', text: '#e5e7eb', muted: '#9ca3af', accent: '#3b82f6' },
    light: { bg: '#ffffff', surface: '#f7f7f9', border: '#e6e6ea', text: '#17171c', muted: '#5d5d69', accent: '#2563eb' }
  };
  if (hexes.length === 0) return { dark: { ...DEFAULTS.dark }, light: { ...DEFAULTS.light } };

  // Urutkan dari paling gelap ke paling terang.
  const sorted = [...hexes].sort((a, b) => luminance(a) - luminance(b));
  const darkest = sorted[0];
  const lightest = sorted[sorted.length - 1];
  const mid = sorted[Math.floor(sorted.length / 2)];

  // Aksen: warna paling jenuh yang bukan nyaris hitam/putih.
  const vivid = sorted
    .map(c => ({ c, ...hueOf(c) }))
    .filter(x => x.s > 0.35 && luminance(x.c) > 0.02 && luminance(x.c) < 0.75)
    .sort((a, b) => b.s - a.s);

  const dark = {
    bg: darkest,
    surface: sorted[Math.min(1, sorted.length - 1)],
    border: sorted[Math.min(2, sorted.length - 1)],
    text: lightest,
    muted: mid,
    accent: vivid.length ? vivid[0].c : DEFAULTS.dark.accent
  };
  const light = {
    bg: lightest,
    surface: sorted[Math.max(0, sorted.length - 2)],
    border: sorted[Math.max(0, sorted.length - 3)],
    text: darkest,
    muted: mid,
    accent: vivid.length ? vivid[0].c : DEFAULTS.light.accent
  };

  const done = statusColor(hexes, 140, '#16a34a');
  const progress = statusColor(hexes, 45, '#ca8a04');
  const failed = statusColor(hexes, 5, '#dc2626');

  return { dark: { ...dark, done, progress, failed }, light: { ...light, done, progress, failed } };
}

// Jaga kontras: kalau teks/tombol tidak terbaca di atas latarnya, ganti ke
// hitam atau putih (dan Aksen yang tidak terbaca sebagai latar tombol digelapkan).
function ensureContrast(theme) {
  const t = { ...theme };
  if (contrastRatio(t.text, t.bg) < 4.5) {
    t.text = contrastRatio('#ffffff', t.bg) >= contrastRatio('#000000', t.bg) ? '#ffffff' : '#000000';
  }
  if (contrastRatio(t.muted, t.bg) < 4.5) {
    t.muted = contrastRatio('#ffffff', t.bg) >= contrastRatio('#000000', t.bg) ? '#c9c9d1' : '#4a4a55';
    if (contrastRatio(t.muted, t.bg) < 4.5) t.muted = t.text;
  }
  // Warna aksen dipakai sebagai latar tombol: pastikan salah satu teks terbaca.
  if (contrastRatio('#ffffff', t.accent) < 4.5 && contrastRatio('#000000', t.accent) < 4.5) {
    t.accent = t.text; // aksen terlalu "abu tengah", pakai warna teks supaya tetap terbaca
  }
  return t;
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

export function buildPreviewHtml(ws, features, tasks) {
  const ds = (features || []).find(f => f && f.module && /design system|desain antarmuka|sistem desain|design token/i.test(f.module));
  const dsText = ds ? [ds.description, ...(ds.acceptanceCriteria || [])].join('\n') : '';
  const hexes = extractHexes(dsText);

  const themes = buildThemes(hexes);
  const L = ensureContrast(themes.light);
  const D = ensureContrast(themes.dark);
  // Teks di atas tombol beraksen: hitam atau putih, pilih yang terbaca.
  const onAccent = r => (contrastRatio('#ffffff', r.accent) >= contrastRatio('#000000', r.accent) ? '#ffffff' : '#000000');
  const title = ws.name || 'Preview';
  const modules = (features || []).map((f, i) => ({ n: String(i + 1).padStart(2, '0'), module: f.module, desc: f.description }));
  const taskList = (tasks || []).slice(0, 8);

  const ver = (a, b) => contrastRatio(a, b).toFixed(1);

  function panel(r, mode) {
    return `
  <section class="panel" data-mode="${mode}">
    <div class="panel-head">
      <h3>${mode === 'dark' ? 'Mode Gelap' : 'Mode Terang'}</h3>
      <span class="verdict">teks vs latar: ${ver(r.text, r.bg)}:1</span>
    </div>

    <div class="stage" style="background:${r.bg};color:${r.text}">
      <div class="stage-head">
        <span class="dot" style="background:${r.accent}"></span>
        <span class="stage-title">${esc(title)}</span>
        <span class="badge" style="color:${r.done}">selesai</span>
        <span class="badge" style="color:${r.progress}">proses</span>
        <span class="badge" style="color:${r.failed}">gagal</span>
      </div>

      <div class="row">
        <button class="btn-primary" style="background:${r.accent};color:${onAccent(r)}">Tombol Utama</button>
        <button class="btn-ghost" style="color:${r.text};border-color:${r.border}">Tombol Sekunder</button>
        <button class="btn-ghost" disabled style="color:${r.muted};border-color:${r.border}">Nonaktif</button>
      </div>

      <label class="field">
        <span style="color:${r.muted}">Nama modul</span>
        <input placeholder="Ketik sesuatu" style="background:${r.surface};border-color:${r.border};color:${r.text}" />
      </label>

      <table class="tbl" style="border-color:${r.border}">
        <thead>
          <tr>
            <th style="color:${r.muted};border-color:${r.border}">Task</th>
            <th style="color:${r.muted};border-color:${r.border}">Status</th>
            <th class="num" style="color:${r.muted};border-color:${r.border}">Durasi</th>
          </tr>
        </thead>
        <tbody>
          ${taskList.map((t, i) => `
          <tr>
            <td style="border-color:${r.border}">${esc((t.title || '').slice(0, 46))}</td>
            <td style="border-color:${r.border}"><span style="color:${[r.done, r.progress, r.muted][i % 3]}">${['selesai','proses','menunggu'][i % 3]}</span></td>
            <td class="num" style="color:${r.muted};border-color:${r.border}">${(i + 1) * 3}m 12s</td>
          </tr>`).join('')}
        </tbody>
      </table>

      <div class="empty" style="border-color:${r.border};background:${r.surface}">
        <strong>Belum ada data</strong>
        <p style="color:${r.muted}">Tidak ada yang perlu ditampilkan. Mulai dengan menambah item pertama.</p>
        <button class="btn-primary" style="background:${r.accent};color:${onAccent(r)}">Tambah item</button>
      </div>
    </div>

    <div class="swatches">
      ${[['latar', r.bg], ['permukaan', r.surface], ['garis', r.border], ['teks', r.text], ['teks sekunder', r.muted], ['aksen', r.accent], ['selesai', r.done], ['proses', r.progress], ['gagal', r.failed]]
        .map(([label, c]) => `<div class="sw"><span class="chip" style="background:${c}"></span><code>${c}</code><small>${label}</small></div>`).join('')}
    </div>
  </section>`;
  }

  return `<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Preview UI - ${esc(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  :root{
    --font-sans:'Inter',-apple-system,BlinkMacSystemFont,sans-serif;
    --font-mono:'JetBrains Mono',monospace;
    --page:#f4f4f6; --card:#ffffff; --line:#e4e4e9; --ink:#17171c; --ink2:#5d5d69; --accent:#b45309;
    --sp:4px;
  }
  body{font-family:var(--font-sans);background:var(--page);color:var(--ink);line-height:1.55;
       -webkit-font-smoothing:antialiased;padding:28px 20px 56px}
  .wrap{max-width:1180px;margin:0 auto}
  header.page-head{margin-bottom:28px;padding-bottom:18px;border-bottom:1px solid var(--line)}
  header.page-head h1{font-size:1.6rem;font-weight:700;letter-spacing:-0.02em;margin-bottom:4px}
  header.page-head p{color:var(--ink2);font-size:.9rem;max-width:70ch}
  header.page-head .tag{display:inline-block;margin-top:8px;font-family:var(--font-mono);font-size:.72rem;
       color:var(--accent);background:#b453091a;padding:2px 8px;border-radius:4px}
  .note{background:#fffbe9;border:1px solid #f0e0b0;color:#6b5a1a;font-size:.82rem;
        padding:10px 14px;border-radius:6px;margin:18px 0 26px}
  .panel{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:20px;margin-bottom:24px}
  .panel-head{display:flex;justify-content:space-between;align-items:baseline;gap:12px;margin-bottom:14px;flex-wrap:wrap}
  .panel-head h3{font-size:.95rem;font-weight:650}
  .verdict{font-family:var(--font-mono);font-size:.74rem;color:var(--ink2)}
  .stage{border-radius:8px;padding:20px;display:flex;flex-direction:column;gap:16px}
  .stage-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding-bottom:12px;border-bottom:1px solid currentColor;border-color:#8884}
  .dot{width:9px;height:9px;border-radius:50%}
  .stage-title{font-weight:650;font-size:.95rem;margin-right:auto}
  .badge{font-family:var(--font-mono);font-size:.72rem}
  .row{display:flex;gap:8px;flex-wrap:wrap}
  .btn-primary{border:1px solid transparent;border-radius:6px;padding:8px 14px;font:inherit;font-size:.82rem;
       font-weight:600;cursor:pointer;transition:opacity 150ms cubic-bezier(.23,1,.32,1)}
  .btn-primary:hover{opacity:.88}
  .btn-ghost{background:transparent;border:1px solid;border-radius:6px;padding:8px 14px;font:inherit;
       font-size:.82rem;font-weight:600;cursor:pointer;transition:background 150ms cubic-bezier(.23,1,.32,1)}
  .btn-ghost:hover{background:#8881}
  .btn-ghost:disabled{cursor:not-allowed}
  button:focus-visible,input:focus-visible{outline:2px solid currentColor;outline-offset:2px}
  .field{display:flex;flex-direction:column;gap:5px;font-size:.78rem;font-weight:600}
  .field input{font:inherit;font-size:.85rem;font-weight:400;padding:8px 11px;border:1px solid;border-radius:6px}
  .field input::placeholder{color:#8b8b96}
  .tbl{width:100%;border-collapse:collapse;font-size:.82rem}
  .tbl th{text-align:left;font-size:.72rem;text-transform:uppercase;letter-spacing:.05em;font-weight:600;
       padding:7px 10px;border-bottom:1px solid}
  .tbl td{padding:9px 10px;border-bottom:1px solid}
  .tbl .num{text-align:right;font-family:var(--font-mono);font-variant-numeric:tabular-nums}
  .empty{border:1px dashed;border-radius:8px;padding:18px;text-align:left;display:flex;flex-direction:column;
       gap:8px;align-items:flex-start}
  .empty strong{font-size:.88rem}
  .empty p{font-size:.8rem;max-width:52ch}
  .swatches{display:flex;flex-wrap:wrap;gap:10px;margin-top:16px;padding-top:16px;border-top:1px solid var(--line)}
  .sw{display:flex;align-items:center;gap:7px;background:#fafafb;border:1px solid var(--line);
      border-radius:6px;padding:5px 9px}
  .chip{width:15px;height:15px;border-radius:3px;border:1px solid #0002}
  .sw code{font-family:var(--font-mono);font-size:.72rem}
  .sw small{color:var(--ink2);font-size:.7rem}
  .mods{display:flex;flex-wrap:wrap;gap:8px;margin-top:6px}
  .mod{background:var(--card);border:1px solid var(--line);border-radius:6px;padding:9px 12px;font-size:.8rem}
  .mod b{font-family:var(--font-mono);font-size:.7rem;color:var(--accent);margin-right:7px}
  footer.page-foot{margin-top:32px;color:var(--ink2);font-size:.78rem}
  @media (prefers-reduced-motion: reduce){*{transition:none!important}}
</style>
</head>
<body>
<div class="wrap">
  <header class="page-head">
    <h1>${esc(title)}</h1>
    <p>${esc(ws.tagline || 'Contoh tampilan yang dihasilkan dari modul Design System di PRD ini.')}</p>
    ${ds ? `<span class="tag">template: ${esc((ds.description || '').match(/\(id:\s*([a-z-]+)\)/)?.[1] || 'design system')}</span>` : ''}
  </header>

  ${ds ? '' : '<div class="note">PRD ini belum punya modul Design System, jadi halaman ini memakai palet bawaan. Regenerate PRD-nya supaya paletnya ikut.</div>'}

  ${panel(L, 'light')}
  ${panel(D, 'dark')}

  <section class="panel">
    <div class="panel-head"><h3>Modul dalam PRD</h3><span class="verdict">${modules.length} modul</span></div>
    <div class="mods">
      ${modules.map(m => `<div class="mod"><b>${m.n}</b>${esc(m.module)}</div>`).join('')}
    </div>
  </section>

  <footer class="page-foot">
    Contoh ini dibuat dari data PRD, bukan aplikasi jadi. Palet diambil dari modul Design System sehingga bisa dipakai untuk memeriksa hasil sebelum AI membangun aplikasinya.
  </footer>
</div>
</body>
</html>`;
}
