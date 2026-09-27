// Preview UI: mengubah modul Design System di dalam PRD menjadi halaman HTML
// yang bisa dibuka di browser, supaya user bisa MELIHAT hasil desainnya sebelum
// menyuruh AI membangun aplikasinya.
//
// Cara kerja: palet HEX dan aturan dibaca dari features_json (yang sudah berisi
// template design system pilihan model), lalu dirender jadi halaman contoh.
// Dengan ?direction=<id> palet taken dari template itu, sehingga user bisa
// membandingkan arah visual lain sebelum memilih.
// Sengaja tanpa dependensi: satu fungsi, keluaran HTML mandiri.

import { DESIGN_TEMPLATES, DESIGN_DIRECTIONS } from './design-templates.js';
import { buildModuleScreen, productKind } from './preview-screens.js';

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
  // Warna status wajib ada di KEDUA jalur. Dulu cabang tanpa hex hanya
  // mengembalikan DEFAULTS tanpa done/progress/failed, sehingga swatch
  // menampilkan "undefined" (terlihat live di preview).
  const FALLBACK_STATUS = { done: '#16a34a', progress: '#ca8a04', failed: '#dc2626' };
  if (hexes.length === 0) return {
    dark: { ...DEFAULTS.dark, ...FALLBACK_STATUS },
    light: { ...DEFAULTS.light, ...FALLBACK_STATUS }
  };

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

// Palet contoh dari satu template, dipakai kalau user membandingkan arah
// visual lewat ?direction=<id> sebelum PRD dibuat.
export function directionHexes(directionId) {
  const t = DESIGN_TEMPLATES.find(x => x.id === directionId);
  if (!t) return [];
  return [...new Set(Object.values({ ...t.light, ...t.dark }).flat().filter(v => typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v)).map(v => v.toLowerCase()))];
}

export function buildPreviewHtml(ws, features, tasks, options = {}) {
  const databaseSchema = options.databaseSchema || [];
  const apiEndpoints = options.apiEndpoints || [];
  const ds = (features || []).find(f => f && f.module && /design system|desain antarmuka|sistem desain|design token/i.test(f.module));
  const dsText = ds ? [ds.description, ...(ds.acceptanceCriteria || [])].join('\n') : '';
  const direction = DESIGN_TEMPLATES.find(x => x.id === options.direction);
  const hexes = direction ? directionHexes(direction.id) : extractHexes(dsText);

  const themes = buildThemes(hexes);
  const L = ensureContrast(themes.light);
  const D = ensureContrast(themes.dark);
  // Teks di atas tombol beraksen: hitam atau putih, pilih yang terbaca.
  const onAccent = r => (contrastRatio('#ffffff', r.accent) >= contrastRatio('#000000', r.accent) ? '#ffffff' : '#000000');
  const title = ws.name || 'Preview';
  const modules = (features || []).map((f, i) => ({
    n: String(i + 1).padStart(2, '0'),
    module: f.module,
    desc: f.description,
    slug: String(f.module || 'modul').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || ('modul-' + i),
    acceptanceCriteria: f.acceptanceCriteria || [],
    edgeCases: f.edgeCases || []
  }));
  const kind = productKind({ features, summary: ws.summary || '', architecture: ws.architecture || '' });
  const product = kind;
  // Layar contoh per modul: bentuk dipilih dari domain modul + kolom tabel PRD.
  const screens = modules
    .map((m, i) => buildModuleScreen(m, { databaseSchema, apiEndpoints, theme: D, onAccent: onAccent(D), product, active: i === 0 }))
    .join('\n');
  // Untuk portofolio/landing, modul disusun sebagai bagian halaman berurutan
  // (bukan kumpulan kartu aplikasi), sesuai aturan design-taste-frontend.
  const showcase = kind === 'showcase';

  const ver = (a, b) => contrastRatio(a, b).toFixed(1);

  // Prototype: tab per layar + pilih arah visual langsung (tanpa reload halaman).
  // Panel palet lama dibuang karena duplikat dengan tab "Design System".
  const navTabs = modules.map((m, i) => `
    <button class="tab${i === 0 ? ' is-on' : ''}" type="button" role="tab" id="nav-${esc(m.slug)}"
      aria-selected="${i === 0 ? 'true' : 'false'}" aria-controls="screen-${esc(m.slug)}" data-tab="${esc(m.slug)}">
      <span class="tab-no">${m.n}</span><span>${esc(m.module)}</span>
    </button>`).join('');

  const themeSwitcher = (currentId) => DESIGN_TEMPLATES.map((t) => `
    <button class="sw-btn${t.id === currentId ? ' is-on' : ''}" type="button" data-direction="${esc(t.id)}"
      aria-pressed="${t.id === currentId ? 'true' : 'false'}"
      title="${esc(t.name)} — ${esc(t.for)}">
      <span class="sw-band" style="background:linear-gradient(90deg, ${t.light.bg} 0 34%, ${t.light.surface} 34% 50%, ${t.light.accent} 50% 66%, ${t.light.text} 66% 82%, ${t.light.done} 82% 100%)"></span>
      <span class="sw-name">${esc(t.name)}</span>
    </button>`).join('');

  // Kartu perbandingan: user lihat semua palet lalu pilih arah yang dipakai.
  // Klik kartu membuka pratinjau lengkap arah itu; tombol "pakai ini" memakai
  // POST sehingga arah tersimpan di workspace tanpacharger ulang PRD.
  function compareSection(currentId) {
    const cards = DESIGN_TEMPLATES.map(t => {
      const l = t.light;
      const band = `linear-gradient(90deg, ${l.bg} 0 34%, ${l.surface} 34% 50%, ${l.accent} 50% 66%, ${l.text} 66% 82%, ${l.done} 82% 100%)`;
      const isCurrent = t.id === currentId;
      // <form> tidak boleh ada di dalam <a>, jadi kartu bukan link: judulnya
      // yang membuka pratinjau, tombolnya yang menyimpan pilihan.
      return `<div class="cmp-card${isCurrent ? ' current' : ''}">
        <a class="cmp-swatch" style="background:${band}" href="?compare=1&amp;direction=${encodeURIComponent(t.id)}" aria-label="Pratinjau ${esc(t.name)}"></a>
        <div class="cmp-body">
          <a href="?compare=1&amp;direction=${encodeURIComponent(t.id)}" style="color:inherit;text-decoration:none"><strong>${esc(t.name)}</strong></a>
          <small>${esc(t.feel)}</small>
          <small>${esc(t.for)}</small>
          ${isCurrent ? '<span class="cmp-cta">Arah yang dipakai PRD ini</span>'
            : `<form method="POST" action="/api/v1/workspaces/${esc(ws.id)}/preview/direction"><input type="hidden" name="direction" value="${esc(t.id)}">
                 <button class="btn-primary" type="submit" style="font-size:.75rem;padding:6px 10px">Pakai arah ini</button></form>`}
        </div>
      </div>`;
    }).join('\n');
    return `<section class="panel">
      <div class="panel-head"><h3>Pilih arah visual</h3><span class="verdict">${DESIGN_DIRECTIONS.length} arah</span></div>
      <p class="verdict" style="margin:0 0 10px">Klik kartu untuk melihat pratinjau lengkap arah itu. "Pakai arah ini" menyimpan pilihan di workspace ini; PRD yang sudah jadi tidak berubah, tapi task berikutnya memakai arah pilihan.</p>
      <div class="cmp">${cards}</div>
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
  .vh{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
  .app-window{border:1px solid var(--line);border-radius:10px;overflow:hidden;margin-bottom:18px;background:var(--card)}
  .win-bar{display:flex;align-items:center;gap:10px;padding:8px 12px;background:var(--page);border-bottom:1px solid var(--line)}
  .win-dots{display:flex;gap:4px}
  .win-dots i{width:9px;height:9px;border-radius:50%;background:var(--line);display:block}
  .win-name{font-size:.8rem;font-weight:650}
  .win-kind{margin-left:auto;font-family:var(--font-mono);font-size:.68rem;color:var(--ink2)}
  .win-body{padding:18px}
  .page-head-sm{display:flex;justify-content:space-between;gap:12px;margin-bottom:14px}
  .page-head-sm h3{font-size:1.02rem;font-weight:700;letter-spacing:-.01em;margin-bottom:2px}
  .page-head-sm p{color:var(--ink2);font-size:.82rem;max-width:68ch}
  .screen-bar{display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap;align-items:center}
  .screen-bar .search{flex:1;min-width:220px}
  .screen-bar input{width:100%;padding:9px 11px;border:1px solid var(--line);border-radius:7px;font:inherit;font-size:.84rem;background:var(--card);color:var(--ink)}
  .tbl-wrap{overflow-x:auto;border:1px solid var(--line);border-radius:8px}
  .tbl{width:100%;border-collapse:collapse;font-size:.82rem}
  .tbl th{text-align:left;font-weight:650;color:var(--ink2);background:var(--page);padding:9px 11px;white-space:nowrap}
  .tbl td{padding:10px 11px;border-top:1px solid var(--line)}
  .tbl td.strong{font-weight:600}
  .pill{display:inline-block;font-size:.72rem;font-weight:600;padding:2px 8px;border-radius:999px;border:1px solid}
  .pill.ok{color:#047857;border-color:#04785744;background:#04785712}
  .pill.warn{color:#9a5b06;border-color:#9a5b0644;background:#9a5b0612}
  .pill.bad{color:#b3261e;border-color:#b3261e44;background:#b3261e12}
  .pill.neutral{color:var(--ink2);border-color:var(--line);background:var(--page)}
  .pill::after{content:'';}
  .btn-primary,.btn-ghost{cursor:pointer}
  .entry-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px}
  .field{display:flex;flex-direction:column;gap:5px;font-size:.78rem}
  .field span{color:var(--ink2);font-weight:600}
  .field input,.field select{padding:9px 11px;border:1px solid var(--line);border-radius:7px;font:inherit;font-size:.84rem;background:var(--card);color:var(--ink)}
  .field.sm{max-width:180px}
  .entry-foot{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:14px}
  .tally{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;margin-top:16px}
  .tally-item{display:flex;align-items:baseline;gap:8px;padding:11px;border:1px solid var(--line);border-radius:8px}
  .tally-item b{font-size:1.25rem;font-variant-numeric:tabular-nums;margin-left:auto}
  .filters{display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap;margin-bottom:14px}
  .kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin-bottom:14px}
  .kpi{padding:13px;border:1px solid var(--line);border-radius:8px;display:flex;flex-direction:column;gap:3px}
  .kpi b{font-size:1.4rem;font-variant-numeric:tabular-nums;letter-spacing:-.02em}
  .auth{max-width:340px;display:flex;flex-direction:column;gap:11px}
  .auth .btn-primary{width:100%}
  .err{color:#b3261e;font-size:.78rem;border-left:2px solid #b3261e;padding-left:9px}
  .hint{color:var(--ink2);font-size:.76rem;line-height:1.5}
  .hint code{font-family:var(--font-mono);font-size:.72rem;background:var(--page);padding:1px 5px;border-radius:4px}
  .tokens .sw-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;margin-bottom:16px}
  .sw{display:flex;flex-direction:column;gap:4px;font-size:.74rem}
  .sw .chip{height:38px;border-radius:7px;border:1px solid var(--line)}
  .sw code{font-family:var(--font-mono);font-size:.68rem;color:var(--ink2)}
  .type-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:14px;margin-bottom:16px;padding-top:14px;border-top:1px solid var(--line)}
  .t-h1{font-size:1.35rem;font-weight:700;letter-spacing:-.02em}
  .t-body{font-size:.86rem;max-width:60ch}
  .t-num{font-size:2rem;font-weight:700;font-variant-numeric:tabular-nums}
  .crit{margin-top:14px;border-top:1px solid var(--line);padding-top:10px}
  .crit summary{cursor:pointer;font-size:.8rem;font-weight:600}
  .crit ul{margin:9px 0 0 18px;font-size:.78rem;color:var(--ink2);display:flex;flex-direction:column;gap:4px}
  .crit li.edge{color:#9a5b06}
  .content{display:flex;flex-direction:column;gap:14px}
  .lead{font-size:.88rem;color:var(--ink2);max-width:68ch;line-height:1.6}
  .hero-blk{display:flex;flex-direction:column;gap:12px;padding:6px 0}
  .eyebrow{font-family:var(--font-mono);font-size:.72rem;color:var(--ink2);letter-spacing:.04em;text-transform:uppercase}
  .hero-title{font-size:1.55rem;font-weight:700;letter-spacing:-.025em;line-height:1.2;max-width:24ch}
  .timeline{list-style:none;display:flex;flex-direction:column;gap:0;margin:0;padding:0}
  .timeline li{padding:14px 0 14px 16px;border-left:2px solid var(--line);position:relative;display:flex;flex-direction:column;gap:3px}
  .timeline li::before{content:'';position:absolute;left:-5px;top:19px;width:8px;height:8px;border-radius:50%;background:var(--line)}
  .timeline li:first-child::before{background:var(--ink2)}
  .timeline .when{font-family:var(--font-mono);font-size:.72rem;color:var(--ink2)}
  .timeline b{font-size:.88rem}
  .timeline p{font-size:.82rem;color:var(--ink2);max-width:70ch}
  .checklist{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:9px;font-size:.84rem}
  .checklist li{display:flex;gap:9px;align-items:baseline}
  .chk{width:17px;height:17px;flex:0 0 17px;border-radius:5px;border:1px solid var(--line);display:inline-flex;align-items:center;justify-content:center;font-size:.72rem;font-weight:700}
  .chk.ok{color:#047857;border-color:#04785788}
  a.btn-primary,a.btn-ghost{text-decoration:none;display:inline-flex;align-items:center}
  /* ===== Prototype: tab, switcher, komponen domain ===== */
  .proto-bar{display:flex;gap:12px;align-items:center;justify-content:space-between;flex-wrap:wrap;margin-bottom:14px;padding-bottom:12px;border-bottom:1px solid var(--line)}
  .proto-nav{display:flex;gap:4px;flex-wrap:wrap}
  .tab{display:inline-flex;align-items:center;gap:8px;border:1px solid transparent;background:transparent;font:inherit;font-size:.8rem;font-weight:600;color:var(--ink2);padding:8px 12px;border-radius:7px;cursor:pointer;min-height:44px;transition:background 140ms cubic-bezier(.23,1,.32,1)}
  .tab:hover{background:var(--page);color:var(--ink)}
  .tab.is-on{background:var(--ink);color:var(--card);border-color:var(--ink)}
  .tab-no{font-family:var(--font-mono);font-size:.68rem;opacity:.65}
  .proto-actions{display:flex;gap:10px;align-items:center}
  .proto-theme{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:16px}
  .sw-list{display:flex;gap:6px;flex-wrap:wrap}
  .sw-btn{border:1px solid var(--line);background:var(--card);border-radius:7px;padding:5px 9px 6px;cursor:pointer;font:inherit;display:flex;flex-direction:column;gap:4px;min-width:104px;min-height:44px;transition:border-color 140ms cubic-bezier(.23,1,.32,1)}
  .sw-btn:hover{border-color:var(--ink2)}
  .sw-btn.is-on{border-color:var(--ink);box-shadow:0 0 0 1px var(--ink)}
  .sw-band{display:block;height:9px;border-radius:4px}
  .sw-name{font-size:.68rem;color:var(--ink2);font-weight:600;text-align:left;line-height:1.2}
  .sw-btn.is-on .sw-name{color:var(--ink)}
  .proto-body.is-showcase{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:0}
  .proto-body.is-showcase .app-window{border:0;border-bottom:1px solid var(--line);border-radius:0;margin:0}
  .proto-body.is-showcase .app-window:last-child{border-bottom:0}
  .proto-body.is-showcase .win-bar{display:none}
  .app-window{background:var(--card)}
  .empty{display:flex;flex-direction:column;align-items:flex-start;gap:7px;padding:26px 20px;border:1px dashed var(--line);border-radius:9px;text-align:left}
  .empty-mark{width:26px;height:26px;border-radius:7px;border:1.5px solid var(--line);position:relative}
  .empty-mark::after{content:'';position:absolute;inset:7px;border-radius:3px;background:var(--line)}
  .empty strong{font-size:.88rem}
  .empty p{color:var(--ink2);font-size:.8rem;max-width:56ch}
  .tbl-empty td{padding:0;border-top:1px solid var(--line)}
  .tbl-empty .empty{border:0;border-radius:0}
  .legend{display:flex;gap:7px;align-items:center;flex-wrap:wrap;margin-bottom:14px}
  /* draft board */
  .draft{display:flex;flex-direction:column;gap:14px}
  .draft-head{display:grid;grid-template-columns:1fr auto 1fr;gap:12px;align-items:center;padding:12px;border:1px solid var(--line);border-radius:9px;background:var(--page)}
  .team{display:flex;flex-direction:column;gap:2px}
  .team-red{align-items:flex-end}
  .team-name{font-weight:700;font-size:.86rem}
  .team-meta{font-size:.72rem;color:var(--ink2)}
  .team-blue .team-name{color:#2563eb}
  .team-red .team-name{color:#dc2626}
  .timer{display:flex;flex-direction:column;align-items:center;font-variant-numeric:tabular-nums}
  .timer b{font-size:1.5rem;letter-spacing:-.02em}
  .timer span{font-size:.66rem;color:var(--ink2);text-transform:uppercase;letter-spacing:.06em}
  .draft-rows{display:flex;flex-direction:column;gap:10px}
  .draft-row{display:flex;gap:12px;align-items:center}
  .row-label{width:42px;font-size:.74rem;font-weight:700;color:var(--ink2);text-transform:uppercase;letter-spacing:.05em}
  .slots{display:flex;gap:7px;flex-wrap:wrap}
  .slot{width:54px;height:54px;border:1px dashed var(--line);border-radius:9px;background:var(--page);display:flex;align-items:center;justify-content:center;position:relative;cursor:pointer;font:inherit;transition:border-color 140ms cubic-bezier(.23,1,.32,1)}
  .slot:hover{border-color:var(--ink2)}
  .slot-no{position:absolute;top:3px;left:6px;font-family:var(--font-mono);font-size:.6rem;color:var(--ink2)}
  .slot-x{font-size:1.1rem;color:var(--ink2)}
  .draft-pool .pool-head{display:flex;justify-content:space-between;gap:10px;align-items:baseline;margin-bottom:9px}
  /* pos */
  .pos{display:grid;grid-template-columns:1fr 240px;gap:14px}
  @media (max-width:720px){.pos{grid-template-columns:1fr}}
  .pos-sum{display:flex;flex-direction:column;gap:7px;padding:14px;border:1px solid var(--line);border-radius:9px;background:var(--page)}
  .pos-total{font-size:1.5rem;font-variant-numeric:tabular-nums;letter-spacing:-.02em}
  /* arsip */
  .split{display:grid;grid-template-columns:1fr 260px;gap:14px}
  @media (max-width:720px){.split{grid-template-columns:1fr}}
  .split-side{padding:14px;border:1px solid var(--line);border-radius:9px;background:var(--page);display:flex;flex-direction:column;gap:9px}
  .detail-rows{display:flex;flex-direction:column;gap:7px;font-size:.8rem}
  .detail-rows div{display:flex;justify-content:space-between;gap:10px}
  .detail-rows span{color:var(--ink2)}
  .detail-rows em{font-style:normal;color:var(--ink2)}
  .checklist button.chk{border:1px solid var(--line);background:var(--card);width:19px;height:19px;flex:0 0 19px;border-radius:5px;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;padding:0}
  .checklist button.chk[aria-pressed="true"]{background:var(--ink);border-color:var(--ink)}
  .checklist button.chk[aria-pressed="true"] span::after{content:'✓';color:var(--card);font-size:.72rem;font-weight:700}
  /* tipografi lebih matang */
  .page-head-sm h3{letter-spacing:-.015em}
  .tbl th{font-size:.72rem;text-transform:uppercase;letter-spacing:.05em}
  .btn-primary{box-shadow:0 1px 2px #00000014}
  .btn-primary:active{transform:translateY(.5px)}
  @media (hover:hover) and (pointer:fine){.btn-ghost:hover{border-color:var(--ink2);color:var(--ink)}}
  /* Mode gelap prototype: membalik token halaman, bukan warna komponen. */
  :root[data-theme="dark"]{--page:#0e1116;--card:#161a21;--line:#262c36;--ink:#e7eaf0;--ink2:#9aa4b2}
  :root[data-theme="dark"] .tab.is-on{background:var(--ink);color:#0e1116;border-color:var(--ink)}
  :root[data-theme="dark"] .win-bar{background:#12161c}
  :root[data-theme="dark"] .empty-mark{border-color:#39414d}
  :root[data-theme="dark"] .empty-mark::after{background:#39414d}
  :root[data-theme="dark"] .pill.ok{color:#4ade80;border-color:#4ade8055;background:#4ade8014}
  :root[data-theme="dark"] .pill.warn{color:#fbbf24;border-color:#fbbf2455;background:#fbbf2414}
  :root[data-theme="dark"] .pill.bad{color:#f87171;border-color:#f8717155;background:#f8717114}
  :root[data-theme="dark"] .team-blue .team-name{color:#60a5fa}
  :root[data-theme="dark"] .team-red .team-name{color:#f87171}
  @media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
  .panel-head{display:flex;justify-content:space-between;align-items:baseline;gap:12px;margin-bottom:14px;flex-wrap:wrap}
  .panel-head h3{font-size:.95rem;font-weight:650}
  .verdict{font-family:var(--font-mono);font-size:.74rem;color:var(--ink2)}
  .stage{border-radius:8px;padding:20px;display:flex;flex-direction:column;gap:16px}
  .sample-row{border:1px solid;border-radius:8px;padding:10px 12px;display:flex;flex-direction:column;gap:0}
  .sample-line{display:flex;gap:14px;padding:8px 0;font-size:.8rem;border-bottom:1px solid #8883}
  .sample-line:last-child{border-bottom:0}
  .sample-line span:first-child{min-width:34%}
  .states{display:flex;gap:8px;flex-wrap:wrap}
  .state{border:1px dashed;border-radius:6px;padding:6px 10px;font-size:.74rem}
  .stage-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding-bottom:12px;border-bottom:1px solid currentColor;border-color:#8884}
  .dot{width:9px;height:9px;border-radius:50%}
  .stage-title{font-weight:650;font-size:.95rem;margin-right:auto}
  .badge{font-family:var(--font-mono);font-size:.72rem}
  .row{display:flex;gap:8px;flex-wrap:wrap}
  .btn-primary{border:1px solid transparent;border-radius:6px;padding:8px 14px;font:inherit;font-size:.82rem;
       font-weight:600;cursor:pointer;transition:opacity 150ms cubic-bezier(.23,1,.32,1)}
  .btn-ghost{background:transparent;border:1px solid;border-radius:6px;padding:8px 14px;font:inherit;
       font-size:.82rem;font-weight:600;cursor:pointer;transition:background 150ms cubic-bezier(.23,1,.32,1)}
  @media (hover:hover) and (pointer:fine){.btn-primary:hover{opacity:.88}.btn-ghost:hover{background:#8881}}
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
  .mod b{font-family:var(--font-mono);font-size:.72rem;color:var(--accent);margin-right:7px}
  .cmp{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:12px;margin-top:6px}
  .cmp-card{border:1px solid var(--line);border-radius:8px;overflow:hidden;background:var(--card);
           display:flex;flex-direction:column}
  .cmp-card.current{border-color:var(--accent);box-shadow:inset 0 0 0 1px var(--accent)}
  .cmp-swatch{display:block;height:64px}
  .cmp-swatch:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}
  .cmp-body{padding:10px 12px;display:flex;flex-direction:column;gap:4px}
  .cmp-body strong{font-size:.85rem}
  .cmp-body small{color:var(--ink2);font-size:.72rem;line-height:1.4}
  .cmp-body form{margin:0}
  .cmp-cta{font-size:.7rem;color:var(--accent);font-weight:600;margin-top:2px}
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

  ${direction ? `<div class="note">Pratinjau arah <strong>${esc(direction.name)}</strong> (${esc(direction.for)}). Halaman ini belum memakai PRD: hanya palet, tipografi, dan bentuk komponen dari arah tersebut. Arah yang dipakai PRD ada di bawah.</div>` : ''}
  ${!direction && !ds ? '<div class="note">PRD ini belum punya modul Design System, jadi halaman ini memakai palet bawaan. Regenerate PRD-nya supaya paletnya ikut.</div>' : ''}



  ${options.compare ? compareSection(options.compareId) : ''}

  <section class="panel proto">
    <div class="proto-bar">
      <div class="proto-nav" role="tablist" aria-label="Layar ${esc(title)}">${navTabs}</div>
      <div class="proto-actions">
        <span class="verdict">${modules.length} layar</span>
        <button class="btn-ghost" type="button" id="toggle-theme">Mode gelap</button>
      </div>
    </div>
    <div class="proto-theme">
      <span class="verdict">Arah visual</span>
      <div class="sw-list">${themeSwitcher(options.direction)}</div>
      <span class="hint" id="theme-note">Klik untuk melihat arah lain pada prototype ini; pilihan tersimpan di workspace ini.</span>
    </div>
    <div class="proto-body ${showcase ? 'is-showcase' : ''}" id="proto-body">
      ${screens}
    </div>
    <p class="hint">Prototype dari data PRD, bukan aplikasi jadi. Layar mengikuti domain modul; isi sengaja kosong dengan keadaan awal yang benar.</p>
  </section>
</div>

<script>
(() => {
  const body = document.getElementById('proto-body');
  const tabs = [...document.querySelectorAll('.tab')];
  const panes = [...body.querySelectorAll('.app-window')];
  const show = (slug) => {
    panes.forEach((p) => { p.hidden = p.dataset.screen !== slug; });
    tabs.forEach((t) => {
      const on = t.dataset.tab === slug;
      t.classList.toggle('is-on', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
    });
  };
  tabs.forEach((t) => t.addEventListener('click', () => show(t.dataset.tab)));
  if (panes[0]) show(panes[0].dataset.screen);
  // Panah kiri/kanan untuk berpindah layar (keyboard, tanpa mouse).
  document.querySelector('.proto-nav')?.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const i = tabs.findIndex((t) => t.classList.contains('is-on'));
    const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
    if (next) { next.focus(); show(next.dataset.tab); }
  });

  // Ganti arah visual LANGSUNG: muat ulang halaman dengan ?direction=<id> lalu
  // pertahankan layar yang sedang dibuka. Pilihan disimpan ke workspace lewat
  // POST supaya task berikutnya memakai arah ini.
  const current = new URLSearchParams(location.search).get('direction');
  document.querySelectorAll('.sw-btn').forEach((b) => b.addEventListener('click', async () => {
    const id = b.dataset.direction;
    document.querySelectorAll('.sw-btn').forEach((x) => { x.classList.toggle('is-on', x === b); x.setAttribute('aria-pressed', x === b ? 'true' : 'false'); });
    const open = (tabs.find((t) => t.classList.contains('is-on')) || {}).dataset?.tab;
    try {
      await fetch('preview/direction', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'direction=' + encodeURIComponent(id) });
    } catch {}
    const u = new URL(location.href);
    u.searchParams.set('direction', id);
    if (!current) u.searchParams.delete('compare');
    if (open) u.hash = 'screen-' + open;
    location.href = u.toString();
  }));

  // Mode gelap/terang: membalik seluruh prototype tanpa perlu PRD baru.
  const btn = document.getElementById('toggle-theme');
  const apply = (dark) => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    if (btn) btn.textContent = dark ? 'Mode terang' : 'Mode gelap';
    try { localStorage.setItem('prd-theme', dark ? 'dark' : 'light'); } catch {}
  };
  let dark = false;
  try { dark = localStorage.getItem('prd-theme') === 'dark'; } catch {}
  apply(dark);
  btn?.addEventListener('click', () => { dark = !dark; apply(dark); });
})();
</script>
</body>
</html>`;
}
