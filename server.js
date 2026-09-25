import http from 'http';
import { readFileSync } from 'fs';
import { randomUUID } from 'crypto';
import { db } from './src/db.js';
import { generateClarifications, generatePRDFromPrompt, fetchAvailableModels, appendFeatureChange } from './src/ai-prd.js';
import { buildPreviewHtml } from './src/preview.js';

const PORT = process.env.PORT || 3333;
const AUTH_CHECK_URL = process.env.AUTH_CHECK_URL || 'http://127.0.0.1:20131/check';
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'https://ngoding.lion3l.my.id';

// --- Autentikasi ---------------------------------------------------------
// Sebelumnya seluruh API terbuka: siapa pun yang tahu ID workspace bisa
// membaca token-nya, lalu memakai token itu untuk menulis atau menghapus.
// Aturan sekarang: endpoint workspace butuh cookie sesi web ATAU token
// workspace (untuk CLI). Endpoint yang belum punya workspace (list, clarify,
// generate) hanya boleh lewat cookie sesi web.

function bearerToken(req) {
  const auth = req.headers.authorization || '';
  return auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
}

async function hasValidSession(req) {
  const cookie = req.headers.cookie || '';
  if (!cookie) return false;
  try {
    const r = await fetch(AUTH_CHECK_URL, { headers: { Cookie: cookie } });
    return r.ok;
  } catch {
    return false; // layanan auth mati -> tolak, jangan buka pintu
  }
}

async function requireSession(req, res) {
  if (await hasValidSession(req)) return true;
  sendJson(res, 401, { error: 'Login diperlukan untuk mengakses fitur ini.' });
  return false;
}

async function requireWorkspaceAuth(req, res, ws) {
  const tok = bearerToken(req);
  if (tok && ws && tok === ws.token) return true;
  if (await hasValidSession(req)) return true;
  sendJson(res, 401, { error: 'Login atau token workspace yang sah diperlukan.' });
  return false;
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (err) {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    // CORS dibatasi ke domain app sendiri. Sebelumnya '*', sehingga situs lain
    // bisa memanggil API ini dari browser pengunjung. CLI tidak butuh CORS.
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Vary': 'Origin',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS'
  });
  res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
      'Vary': 'Origin',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS'
    });
    return res.end();
  }

  try {
    // 0. GET /api/v1/models
    if (req.method === 'GET' && url.pathname === '/api/v1/models') {
      const models = await fetchAvailableModels();
      return sendJson(res, 200, { models });
    }

    // 0.1 GET /api/v1/workspaces
    if (req.method === 'GET' && url.pathname === '/api/v1/workspaces') {
      if (!await requireSession(req, res)) return;
      const list = db.prepare(`
        SELECT w.id, w.name, w.tagline, w.summary, w.created_at,
               COUNT(t.id) as total_tasks,
               SUM(CASE WHEN t.status = 'done' THEN 1 ELSE 0 END) as completed_tasks
        FROM workspaces w
        LEFT JOIN tasks t ON w.id = t.workspace_id
        GROUP BY w.id
        ORDER BY w.created_at DESC
      `).all();

      const formatted = list.map(item => {
        const total = item.total_tasks || 0;
        const completed = item.completed_tasks || 0;
        const progress = total > 0 ? Math.round((completed / total) * 100) : 0;
        return {
          id: item.id,
          name: item.name,
          tagline: item.tagline,
          summary: item.summary,
          created_at: item.created_at,
          stats: { total, completed, progress }
        };
      });

      return sendJson(res, 200, { workspaces: formatted });
    }

    // 1. POST /api/v1/workspaces/clarify
    if (req.method === 'POST' && url.pathname === '/api/v1/workspaces/clarify') {
      if (!await requireSession(req, res)) return;
      const body = await parseJsonBody(req);
      if (!body.idea) {
        return sendJson(res, 400, { error: 'Field "idea" is required' });
      }
      const questionsData = await generateClarifications(body.idea, body.name, body.model);
      return sendJson(res, 200, questionsData);
    }

    // 2. POST /api/v1/workspaces/generate
    if (req.method === 'POST' && url.pathname === '/api/v1/workspaces/generate') {
      if (!await requireSession(req, res)) return;
      const body = await parseJsonBody(req);
      if (!body.idea) {
        return sendJson(res, 400, { error: 'Field "idea" is required' });
      }

      const prd = await generatePRDFromPrompt(body.idea, body.name, body.clarifications || [], body.model);
      const wsId = 'ws_' + randomUUID().substring(0, 8);
      const token = 'tok_' + randomUUID().replace(/-/g, '');

      const insertWs = db.prepare(`
        INSERT INTO workspaces (id, token, name, tagline, summary, architecture, features_json, db_schema_json, api_endpoints_json, tech_stack)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      insertWs.run(
        wsId,
        token,
        prd.name || prd.projectName || body.name || 'Untitled App',
        prd.tagline || '',
        prd.summary || body.idea,
        prd.architectureOverview || prd.architecture || '',
        JSON.stringify(prd.features || []),
        JSON.stringify(prd.databaseSchema || []),
        JSON.stringify(prd.apiEndpoints || []),
        JSON.stringify(prd.techStack || [])
      );

      const insertTask = db.prepare(`
        INSERT INTO tasks (id, workspace_id, title, spec, status)
        VALUES (?, ?, ?, ?, 'todo')
      `);

      const tasks = prd.tasks || [];
      const insertMany = db.transaction(() => {
        for (let i = 0; i < tasks.length; i++) {
          const t = tasks[i];
          const taskSlug = t.id || `TASK-${String(i + 1).padStart(2, '0')}`;
          insertTask.run(`${wsId}_${taskSlug}`, wsId, t.title, t.spec);
        }
      });
      insertMany();

      return sendJson(res, 201, {
        workspace: { id: wsId, token, name: prd.name || prd.projectName, summary: prd.summary },
        totalTasks: tasks.length
      });
    }

    // 2.5 PATCH /api/v1/workspaces/:id/tasks/:taskId (CLI progress update)
    if (req.method === 'PATCH' && url.pathname.includes('/tasks/')) {
      const parts = url.pathname.split('/');
      const wsIdx = parts.indexOf('workspaces');
      const wsId = parts[wsIdx + 1];
      const taskShort = parts[parts.length - 1];
      const ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(wsId);
      if (!ws) return sendJson(res, 404, { error: 'Workspace not found' });
      // Token wajib ada dan cocok, atau cookie sesi web yang sah. Sebelumnya
      // header yang tidak dikirim sama sekali lolos begitu saja.
      if (!await requireWorkspaceAuth(req, res, ws)) return;
      const body = await parseJsonBody(req);
      const allowed = ['todo', 'in_progress', 'done', 'failed'];
      if (!body.status || !allowed.includes(body.status)) {
        return sendJson(res, 400, { error: 'Field "status" must be one of: ' + allowed.join(', ') });
      }
      const fullId = taskShort.includes(wsId) ? taskShort : `${wsId}_${taskShort}`;
      const task = db.prepare('SELECT * FROM tasks WHERE id = ? AND workspace_id = ?').get(fullId, wsId);
      if (!task) return sendJson(res, 404, { error: 'Task not found' });
      db.prepare(`UPDATE tasks SET status = ?, reason = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .run(body.status, body.reason || null, fullId);
      const updated = db.prepare('SELECT * FROM tasks WHERE id = ?').get(fullId);
      return sendJson(res, 200, updated);
    }

    // 3.2 GET /api/v1/workspaces/:id/preview  (halaman contoh UI dari modul design system)
    // Harus DIPERIKSA SEBELUM handler GET workspace umum di bawah, karena handler
    // itu menangkap semua path yang diawali /api/v1/workspaces/.
    if (req.method === 'GET' && url.pathname.endsWith('/preview')) {
      const parts = url.pathname.split('/');
      const wsId = parts[parts.length - 2];
      const ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(wsId);
      if (!ws) return sendJson(res, 404, { error: 'Workspace not found' });
      if (!await requireWorkspaceAuth(req, res, ws)) return;
      const features = JSON.parse(ws.features_json || '[]');
      const tasks = db.prepare('SELECT * FROM tasks WHERE workspace_id = ? ORDER BY id ASC').all(wsId);
      const html = buildPreviewHtml(ws, features, tasks);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(html);
    }

    // 3. GET /api/v1/workspaces/:id
    if (req.method === 'GET' && url.pathname.startsWith('/api/v1/workspaces/')) {
      const wsId = url.pathname.replace('/api/v1/workspaces/', '');
      const ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(wsId);
      if (!ws) return sendJson(res, 404, { error: 'Workspace not found' });
      if (!await requireWorkspaceAuth(req, res, ws)) return;

      const tasks = db.prepare('SELECT * FROM tasks WHERE workspace_id = ? ORDER BY id ASC').all(wsId);
      const completedCount = tasks.filter(t => t.status === 'done').length;
      const progress = tasks.length > 0 ? Math.round((completedCount / tasks.length) * 100) : 0;

      return sendJson(res, 200, {
        workspace: {
          id: ws.id,
          // Token hanya dikembalikan ke pemilik token itu sendiri (CLI),
          // tidak ke sembarang pemanggil.
          token: bearerToken(req) === ws.token ? ws.token : undefined,
          name: ws.name,
          tagline: ws.tagline,
          summary: ws.summary,
          architecture: ws.architecture,
          features: JSON.parse(ws.features_json || '[]'),
          databaseSchema: JSON.parse(ws.db_schema_json || '[]'),
          apiEndpoints: JSON.parse(ws.api_endpoints_json || '[]'),
          tech_stack: JSON.parse(ws.tech_stack || '[]'),
          created_at: ws.created_at
        },
        stats: { total: tasks.length, completed: completedCount, progress },
        tasks
      });
    }

    // 3.1 DELETE /api/v1/workspaces/:id
    if (req.method === 'DELETE' && url.pathname.startsWith('/api/v1/workspaces/')) {
      const wsId = url.pathname.replace('/api/v1/workspaces/', '');
      const ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(wsId);
      if (!ws) return sendJson(res, 404, { error: 'Workspace not found' });
      if (!await requireWorkspaceAuth(req, res, ws)) return;
      const delTasks = db.prepare('DELETE FROM tasks WHERE workspace_id = ?');
      const delWs = db.prepare('DELETE FROM workspaces WHERE id = ?');
      const delTx = db.transaction(() => {
        delTasks.run(wsId);
        delWs.run(wsId);
      });
      delTx();
      return sendJson(res, 200, { success: true, deleted: wsId });
    }

    // 4. POST /api/v1/workspaces/:id/append-change
    if (req.method === 'POST' && url.pathname.endsWith('/append-change')) {
      const parts = url.pathname.split('/');
      const wsId = parts[parts.length - 2];
      const ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(wsId);
      if (!ws) return sendJson(res, 404, { error: 'Workspace not found' });
      if (!await requireWorkspaceAuth(req, res, ws)) return;

      const body = await parseJsonBody(req);
      if (!body.changeRequest) {
        return sendJson(res, 400, { error: 'Field "changeRequest" is required' });
      }

      const existingTasks = db.prepare('SELECT * FROM tasks WHERE workspace_id = ? ORDER BY id ASC').all(wsId);
      const existingPRD = {
        name: ws.name,
        summary: ws.summary,
        features: JSON.parse(ws.features_json || '[]'),
        databaseSchema: JSON.parse(ws.db_schema_json || '[]'),
        apiEndpoints: JSON.parse(ws.api_endpoints_json || '[]'),
        techStack: JSON.parse(ws.tech_stack || '[]'),
        existingTasks: existingTasks.map(t => ({ id: t.id.replace(`${wsId}_`, ''), title: t.title, status: t.status }))
      };

      const updateResult = await appendFeatureChange(existingPRD, body.changeRequest, body.model);

      if (updateResult.updatedFeatures || updateResult.updatedEndpoints || updateResult.updatedDatabaseSchema) {
        const feats = updateResult.updatedFeatures || existingPRD.features;
        const eps = updateResult.updatedEndpoints || existingPRD.apiEndpoints;
        const dbs = updateResult.updatedDatabaseSchema || existingPRD.databaseSchema;

        db.prepare(`
          UPDATE workspaces
          SET features_json = ?, api_endpoints_json = ?, db_schema_json = ?
          WHERE id = ?
        `).run(
          JSON.stringify(feats),
          JSON.stringify(eps),
          JSON.stringify(dbs),
          wsId
        );
      }

      const newTasks = updateResult.newTasks || [];
      const insertTask = db.prepare(`
        INSERT INTO tasks (id, workspace_id, title, spec, status)
        VALUES (?, ?, ?, ?, 'todo')
      `);

      const currentCount = existingTasks.length;
      const inserted = [];
      const insertTx = db.transaction(() => {
        for (let i = 0; i < newTasks.length; i++) {
          const t = newTasks[i];
          const taskSlug = t.id || `TASK-${String(currentCount + i + 1).padStart(2, '0')}`;
          const uniqueTaskId = `${wsId}_${taskSlug}`;
          insertTask.run(uniqueTaskId, wsId, t.title, t.spec);
          inserted.push({ id: uniqueTaskId, title: t.title, spec: t.spec, status: 'todo' });
        }
      });
      insertTx();

      return sendJson(res, 200, {
        success: true,
        message: updateResult.changeSummary || 'Fitur berhasil ditambahkan ke PRD!',
        addedTasks: inserted
      });
    }

    // 4.5 GET /cli.js (download CLI untuk AI agent / laptop user)
    if (req.method === 'GET' && url.pathname === '/cli.js') {
      try {
        const cli = readFileSync(new URL('./bin/cli.js', import.meta.url), 'utf-8');
        res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
        return res.end(cli);
      } catch { return sendJson(res, 404, { error: 'CLI not found' }); }
    }

    // 5. Web UI
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname.startsWith('/w/'))) {
      const html = renderHTML();
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }

    sendJson(res, 404, { error: 'Not found' });
  } catch (err) {
    // Error validasi PRD bukan kesalahan server: beri 422 + daftar masalahnya
    // supaya UI bisa menampilkan apa yang kurang, bukan "Internal error".
    if (err.validationProblems) {
      return sendJson(res, 422, { error: err.message, problems: err.validationProblems });
    }
    sendJson(res, 500, { error: err.message });
  }
});

function renderHTML() {
  return `<!DOCTYPE html>
<html lang="id" data-theme="dark" data-palette="amber">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>PRD-Maker: Generator PRD & Spesifikasi</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    :root {
      --font-sans: 'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, sans-serif;
      --font-mono: 'JetBrains Mono', monospace;
      --radius: 6px;
      --transition: 0.15s cubic-bezier(0.23, 1, 0.32, 1);
      --sidebar-width: 280px;
    }

    /* THEME: WARM AMBER */
    [data-palette="amber"][data-theme="dark"] {
      --bg: #12100e;
      --surface: #1a1714;
      --surface-hover: #24201b;
      --border: #2e2821;
      --border-focus: #524739;
      --text: #f5f2eb;
      --text-muted: #b0a696;
      --text-subtle: #8b8272;
      --accent: #f59e0b;
      --accent-hover: #d97706;
      --accent-text: #12100e;
      --code-bg: #0b0a08;
      --badge-bg: rgba(245, 158, 11, 0.15);
      --badge-text: #fbbf24;
      --status-done: #10b981;
      --status-progress: #f59e0b;
      --status-failed: #ef4444;
    }

    [data-palette="amber"][data-theme="light"] {
      --bg: #fcfbf9;
      --surface: #ffffff;
      --surface-hover: #f7f5f0;
      --border: #e7e2d9;
      --border-focus: #c5bba8;
      --text: #1c1917;
      --text-muted: #57534e;
      --text-subtle: #6b6459;
      --accent: #b45309;
      --accent-hover: #92400e;
      --accent-text: #ffffff;
      --code-bg: #f5f2eb;
      --badge-bg: rgba(180, 83, 9, 0.1);
      --badge-text: #92400e;
      --status-done: #047857;
      --status-progress: #b45309;
      --status-failed: #b91c1c;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }

    /* Browser surfaces: selection, caret, scrollbars, focus */
    ::selection { background: var(--badge-bg); color: var(--text); }

    html { scrollbar-color: var(--border-focus) transparent; }

    ::-webkit-scrollbar { width: 10px; height: 10px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb {
      background: var(--border-focus);
      border: 3px solid transparent;
      background-clip: content-box;
      border-radius: 5px;
    }

    :focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 2px;
    }

    body {
      font-family: var(--font-sans);
      background: var(--bg);
      color: var(--text);
      line-height: 1.6;
      min-height: 100vh;
      display: flex;
      -webkit-font-smoothing: antialiased;
    }

    /* SIDEBAR */
    aside {
      width: var(--sidebar-width);
      background: var(--surface);
      border-right: 1px solid var(--border);
      display: flex;
      flex-direction: column;
      flex-shrink: 0;
      transition: width var(--transition), transform var(--transition);
      height: 100vh;
      position: sticky;
      top: 0;
      z-index: 40;
    }

    aside.collapsed {
      width: 0;
      transform: translateX(-100%);
      overflow: hidden;
      border-right: none;
    }

    .sidebar-head {
      padding: 0.85rem 1.1rem;
      border-bottom: 1px solid var(--border);
      display: flex;
      justify-content: space-between;
      align-items: center;
      height: 52px;
    }

    .sidebar-title {
      font-size: 0.775rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--text-subtle);
    }

    .btn-new-chat {
      background: var(--bg);
      border: 1px solid var(--border);
      color: var(--text);
      font-family: inherit;
      font-size: 0.775rem;
      font-weight: 600;
      padding: 4px 10px;
      border-radius: var(--radius);
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 5px;
      line-height: 1;
      height: 28px;
    }

    .btn-new-chat svg {
      width: 12px;
      height: 12px;
      stroke: currentColor;
      stroke-width: 2.5;
      flex-shrink: 0;
    }

    .btn-new-chat:hover {
      border-color: var(--border-focus);
    }

    .sidebar-list {
      flex: 1;
      overflow-y: auto;
      padding: 0.75rem;
      list-style: none;
      display: flex;
      flex-direction: column;
      gap: 0.4rem;
    }

    .history-row {
      padding: 0.65rem 0.85rem;
      border-radius: var(--radius);
      cursor: pointer;
      border: 1px solid transparent;
      transition: background var(--transition), border var(--transition);
      position: relative;
    }

    .history-row:hover {
      background: var(--surface-hover);
      border-color: var(--border);
    }

    .history-row.active {
      background: var(--bg);
      border-color: var(--border-focus);
    }

    .row-top {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 6px;
    }

    .row-name {
      font-size: 0.825rem;
      font-weight: 600;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      color: var(--text);
      flex: 1;
    }

    .btn-del-ws {
      background: transparent;
      border: none;
      color: var(--text-subtle);
      font-size: 0.75rem;
      cursor: pointer;
      padding: 2px 4px;
      border-radius: 4px;
      flex-shrink: 0;
      transition: color var(--transition), background var(--transition);
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .btn-del-ws svg {
      width: 13px;
      height: 13px;
    }

    .btn-del-ws:hover {
      color: var(--status-failed);
      background: rgba(239, 68, 68, 0.12);
    }

    .guide-actions {
      margin-top: 8px;
    }

    .row-meta {
      font-size: 0.725rem;
      color: var(--text-subtle);
      display: flex;
      justify-content: space-between;
      margin-top: 0.25rem;
    }

    .sidebar-foot {
      padding: 0.75rem 1rem;
      border-top: 1px solid var(--border);
      font-size: 0.725rem;
      color: var(--text-subtle);
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    /* MAIN APP */
    .app-main {
      flex: 1;
      display: flex;
      flex-direction: column;
      min-width: 0;
      min-height: 100vh;
    }

    header {
      border-bottom: 1px solid var(--border);
      background: var(--surface);
      position: sticky;
      top: 0;
      z-index: 30;
      height: 52px;
      display: flex;
      align-items: center;
      padding: 0 1.5rem;
      justify-content: space-between;
    }

    .header-left {
      display: flex;
      align-items: center;
      gap: 1rem;
    }

    .btn-toggle-sidebar {
      background: transparent;
      border: 1px solid var(--border);
      color: var(--text-muted);
      width: 32px;
      height: 32px;
      border-radius: var(--radius);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all var(--transition);
    }

    .btn-toggle-sidebar:hover {
      color: var(--text);
      border-color: var(--border-focus);
    }

    .brand {
      font-weight: 700;
      font-size: 0.95rem;
      letter-spacing: -0.02em;
      text-decoration: none;
      color: var(--text);
      display: flex;
      align-items: center;
      gap: 0.4rem;
      cursor: pointer;
    }

    .brand .dot {
      color: var(--accent);
    }

    .theme-segmented {
      display: inline-flex;
      align-items: center;
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 2px;
      gap: 2px;
    }

    .theme-btn {
      background: transparent;
      border: 1px solid transparent;
      color: var(--text-subtle);
      width: 28px;
      height: 26px;
      border-radius: calc(var(--radius) - 2px);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all var(--transition);
    }

    .theme-btn svg {
      width: 14px;
      height: 14px;
      stroke: currentColor;
      stroke-width: 2;
      stroke-linecap: round;
      stroke-linejoin: round;
      fill: none;
    }

    .theme-btn:hover {
      color: var(--text);
    }

    .theme-btn.active {
      background: var(--surface);
      color: var(--accent);
      border-color: var(--border);
      box-shadow: 0 1px 2px rgba(0,0,0,0.08);
    }

    /* CONTENT AREA */
    .content-area {
      max-width: 780px;
      width: 100%;
      margin: 0 auto;
      padding: 2.5rem 1.25rem 6rem;
      flex: 1;
    }

    .stepper {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 2.5rem;
      border-bottom: 1px solid var(--border);
      padding-bottom: 1.25rem;
    }

    .step-item {
      display: flex;
      align-items: center;
      gap: 0.6rem;
      font-size: 0.825rem;
      font-weight: 600;
      color: var(--text-subtle);
      transition: color var(--transition);
    }

    .step-item.active {
      color: var(--text);
    }

    .step-item.completed {
      color: var(--status-done);
    }

    .step-num {
      width: 24px;
      height: 24px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-family: var(--font-mono);
      font-size: 0.75rem;
      background: var(--surface);
      border: 1px solid var(--border);
      color: var(--text-subtle);
      transition: all var(--transition);
    }

    .step-item.active .step-num {
      background: var(--accent);
      color: var(--accent-text);
      border-color: var(--accent);
      font-weight: 700;
    }

    .step-item.completed .step-num {
      background: var(--status-done);
      color: #ffffff;
      border-color: var(--status-done);
      font-weight: 700;
    }

    .step-line {
      flex: 1;
      height: 1px;
      background: var(--border);
      margin: 0 1rem;
    }

    .view-panel {
      display: none;
    }

    .view-panel.active {
      display: block;
      animation: fadeIn 0.15s ease-out;
    }

    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(4px); }
      to { opacity: 1; transform: translateY(0); }
    }

    .view-title {
      font-size: 1.55rem;
      font-weight: 700;
      letter-spacing: -0.02em;
      margin-bottom: 0.35rem;
    }

    .view-desc {
      font-size: 0.9rem;
      color: var(--text-muted);
      margin-bottom: 1.75rem;
    }

    .card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 1.5rem;
      margin-bottom: 1.5rem;
    }

    .card-title {
      font-size: 0.95rem;
      font-weight: 700;
      margin-bottom: 0.25rem;
    }

    .card-desc {
      font-size: 0.8rem;
      color: var(--text-muted);
      margin-bottom: 1.25rem;
    }

    .form-group {
      margin-bottom: 1.25rem;
    }

    .label {
      display: block;
      font-size: 0.8rem;
      font-weight: 600;
      margin-bottom: 0.4rem;
      color: var(--text);
    }

    .input-text, .textarea, .select-input {
      width: 100%;
      background: var(--bg);
      border: 1px solid var(--border);
      color: var(--text);
      font-family: inherit;
      font-size: 0.875rem;
      border-radius: var(--radius);
      padding: 10px 12px;
      outline: none;
      transition: border-color var(--transition);
    }

    .input-text:focus, .textarea:focus, .select-input:focus {
      border-color: var(--accent);
    }

    .textarea {
      resize: vertical;
      min-height: 110px;
    }

    .btn-primary {
      background: var(--accent);
      color: var(--accent-text);
      border: 1px solid var(--accent);
      font-family: inherit;
      font-size: 0.875rem;
      font-weight: 600;
      padding: 10px 20px;
      border-radius: var(--radius);
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      transition: opacity var(--transition);
    }

    .btn-primary:hover {
      opacity: 0.9;
    }

    .btn-primary:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }

    .btn-secondary {
      background: transparent;
      border: 1px solid var(--border);
      color: var(--text);
      font-family: inherit;
      font-size: 0.825rem;
      font-weight: 600;
      padding: 7px 14px;
      border-radius: var(--radius);
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      line-height: 1;
      transition: all var(--transition);
    }

    .btn-secondary svg {
      width: 14px;
      height: 14px;
      stroke: currentColor;
      stroke-width: 2.2;
      flex-shrink: 0;
    }

    .btn-secondary:hover {
      background: var(--surface-hover);
      border-color: var(--border-focus);
    }

    /* Question list: flat numbered rows, separated by rules, never nested cards */
    .q-card {
      padding-top: 1.35rem;
      margin-top: 1.35rem;
      border-top: 1px solid var(--border);
    }

    .q-card:first-child {
      padding-top: 0;
      margin-top: 0;
      border-top: none;
    }

    .q-text {
      font-size: 0.95rem;
      font-weight: 650;
      line-height: 1.5;
      letter-spacing: -0.01em;
    }

    .q-num {
      font-family: var(--font-mono);
      font-size: 0.8rem;
      font-weight: 700;
      color: var(--accent);
      margin-right: 0.5rem;
    }

    .q-hint {
      font-size: 0.775rem;
      color: var(--text-subtle);
      margin-top: 3px;
    }

    .q-options {
      display: flex;
      flex-direction: column;
      gap: 4px;
      margin-top: 0.75rem;
    }

    .option-pill {
      display: flex;
      align-items: center;
      gap: 0.55rem;
      background: var(--bg);
      border: 1px solid var(--border);
      padding: 8px 11px;
      border-radius: var(--radius);
      font-size: 0.85rem;
      color: var(--text);
      cursor: pointer;
      transition: border-color var(--transition), background var(--transition);
    }

    .option-pill:hover {
      border-color: var(--border-focus);
    }

    .option-pill:has(input:checked) {
      border-color: var(--accent);
      background: var(--badge-bg);
      font-weight: 600;
    }

    .option-pill input {
      accent-color: var(--accent);
      margin: 0;
      flex-shrink: 0;
    }

    /* PRD STRUCTURED CARDS */
    .tech-pill {
      display: inline-block;
      background: var(--bg);
      border: 1px solid var(--border);
      color: var(--accent);
      padding: 4px 10px;
      border-radius: var(--radius);
      font-size: 0.775rem;
      font-weight: 600;
      margin-right: 6px;
      margin-bottom: 6px;
    }

    .guide-box {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 1.15rem 1.25rem;
      margin-bottom: 1.5rem;
      font-size: 0.85rem;
    }

    .guide-title {
      font-weight: 700;
      color: var(--text);
      margin-bottom: 6px;
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .guide-steps {
      display: flex;
      flex-direction: column;
      gap: 6px;
      color: var(--text-muted);
      margin-top: 6px;
    }

    .guide-step-item {
      display: flex;
      align-items: baseline;
      gap: 8px;
    }

    .guide-badge {
      background: var(--bg);
      border: 1px solid var(--border);
      color: var(--accent);
      font-family: var(--font-mono);
      font-weight: 700;
      font-size: 0.725rem;
      padding: 1px 6px;
      border-radius: 4px;
      flex-shrink: 0;
    }

    .guide-text {
      font-size: 0.8rem;
      margin-top: 2px;
    }

    .btn-copy {
      background: var(--surface);
      border: 1px solid var(--border);
      color: var(--text);
      font-family: inherit;
      font-size: 0.775rem;
      font-weight: 600;
      line-height: 1;
      height: 30px;
      padding: 0 11px;
      border-radius: var(--radius);
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      white-space: nowrap;
      flex-shrink: 0;
      transition: border-color var(--transition), background var(--transition), color var(--transition);
    }

    .btn-copy svg {
      width: 13px;
      height: 13px;
      stroke: currentColor;
      stroke-width: 2;
      stroke-linecap: round;
      stroke-linejoin: round;
      fill: none;
      flex-shrink: 0;
    }

    .btn-copy:hover {
      border-color: var(--border-focus);
      background: var(--surface-hover);
    }

    .btn-copy:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 2px;
    }

    .btn-copy.is-copied {
      border-color: var(--status-done);
      color: var(--status-done);
    }

    .progress-bar-wrap {
      height: 6px;
      background: var(--surface-hover);
      border-radius: 3px;
      overflow: hidden;
      margin-top: 8px;
    }

    .progress-bar {
      background: var(--accent);
      height: 100%;
      width: 0%;
      transition: width var(--transition);
    }

    .cli-box {
      background: var(--code-bg);
      border: 1px solid var(--border);
      padding: 8px 8px 8px 12px;
      border-radius: var(--radius);
      font-family: var(--font-mono);
      font-size: 0.775rem;
      color: var(--text-muted);
      margin: 8px 0 0;
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .cli-cmd {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .sec-block {
      margin-top: 1.5rem;
      padding-top: 1.25rem;
      border-top: 1px solid var(--border);
    }

    .sec-block h4 {
      font-size: 0.875rem;
      font-weight: 700;
      margin-bottom: 0.6rem;
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .module-item, .db-table-item, .task-item {
      padding: 12px 0;
      border-top: 1px solid var(--border);
    }

    .module-item:first-child, .db-table-item:first-child, .task-item:first-child {
      padding-top: 0;
      border-top: none;
    }

    .module-item:last-child, .db-table-item:last-child, .task-item:last-child {
      padding-bottom: 0;
    }

    .module-head {
      font-size: 0.875rem;
      font-weight: 700;
      color: var(--text);
      margin-bottom: 2px;
      line-height: 1.4;
    }

    .module-desc {
      font-size: 0.825rem;
      color: var(--text-muted);
      line-height: 1.5;
      margin-bottom: 8px;
    }

    .criteria-list {
      list-style: none;
      padding-left: 0;
      margin-top: 6px;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .criteria-item {
      font-size: 0.775rem;
      color: var(--text-subtle);
      display: flex;
      align-items: flex-start;
      gap: 6px;
    }

    .criteria-item::before {
      content: "";
      width: 4px;
      height: 4px;
      border-radius: 1px;
      background: var(--accent);
      margin-top: 0.55em;
      flex-shrink: 0;
    }

    .db-table-name {
      font-family: var(--font-mono);
      font-size: 0.85rem;
      font-weight: 700;
      color: var(--accent);
      margin-bottom: 2px;
    }

    .db-table-desc {
      font-size: 0.8rem;
      color: var(--text-muted);
      line-height: 1.5;
      margin-bottom: 8px;
    }

    .field-chips {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
    }

    .field-chip {
      background: var(--bg);
      border: 1px solid var(--border);
      font-family: var(--font-mono);
      font-size: 0.725rem;
      padding: 2px 6px;
      border-radius: 4px;
      color: var(--text-muted);
    }

    .endpoint-row {
      display: flex;
      align-items: baseline;
      gap: 8px;
      padding: 8px 12px;
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      margin-bottom: 6px;
      font-size: 0.825rem;
    }

    .endpoint-row:last-child {
      margin-bottom: 0;
    }

    .endpoint-path {
      font-family: var(--font-mono);
      color: var(--text);
      font-weight: 600;
    }

    .endpoint-desc {
      color: var(--text-muted);
      font-size: 0.8rem;
    }

    .endpoint-tag {
      display: inline-block;
      font-family: var(--font-mono);
      font-weight: 700;
      padding: 2px 6px;
      border-radius: 4px;
      font-size: 0.7rem;
      flex-shrink: 0;
    }

    .tag-get { background: rgba(59, 130, 246, 0.15); color: #60a5fa; border: 1px solid rgba(59, 130, 246, 0.3); }
    .tag-post { background: rgba(16, 185, 129, 0.15); color: #34d399; border: 1px solid rgba(16, 185, 129, 0.3); }
    .tag-patch { background: rgba(245, 158, 11, 0.15); color: #fbbf24; border: 1px solid rgba(245, 158, 11, 0.3); }
    .tag-delete { background: rgba(239, 68, 68, 0.15); color: #f87171; border: 1px solid rgba(239, 68, 68, 0.3); }

    .task-head {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 10px;
      margin-bottom: 8px;
    }

    .task-title {
      font-size: 0.875rem;
      line-height: 1.4;
    }

    .task-actions {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-shrink: 0;
    }

    .task-id {
      font-family: var(--font-mono);
      color: var(--accent);
      font-weight: 700;
      font-size: 0.8rem;
      margin-right: 6px;
    }

    .badge {
      font-family: var(--font-mono);
      font-size: 0.7rem;
      padding: 2px 7px;
      border-radius: 4px;
      font-weight: 600;
      text-transform: uppercase;
      border: 1px solid transparent;
    }

    .badge-todo { background: var(--bg); color: var(--text-subtle); border-color: var(--border); }
    .badge-in_progress { background: rgba(245, 158, 11, 0.15); color: var(--status-progress); border-color: var(--status-progress); }
    .badge-done { background: rgba(16, 185, 129, 0.15); color: var(--status-done); border-color: var(--status-done); }
    .badge-failed { background: rgba(239, 68, 68, 0.15); color: var(--status-failed); border-color: var(--status-failed); }

    .task-spec {
      font-size: 0.8rem;
      color: var(--text-muted);
      line-height: 1.65;
      margin-top: 8px;
      white-space: pre-wrap;
      word-break: break-word;
    }

    .task-fail {
      font-size: 0.8rem;
      color: var(--status-failed);
      margin-top: 4px;
    }

    .empty-note {
      color: var(--text-subtle);
      font-size: 0.8rem;
    }
  </style>
</head>
<body>

  <!-- LEFT SIDEBAR: History Workspace Panel -->
  <aside id="sidebar">
    <div class="sidebar-head">
      <span class="sidebar-title">Riwayat Sesi</span>
      <button class="btn-new-chat" onclick="startNewSession()">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
        <span>Sesi Baru</span>
      </button>
    </div>

    <ul class="sidebar-list" id="sidebar-history-list">
      <li style="padding: 0.75rem; color: var(--text-subtle); font-size: 0.8rem;">Memuat sesi...</li>
    </ul>

    <div class="sidebar-foot">
      <span>Local SQLite DB</span>
      <span style="font-family: var(--font-mono);" id="sidebar-count">0 Sesi</span>
    </div>
  </aside>

  <!-- MAIN APP CONTAINER -->
  <div class="app-main">
    <header>
      <div class="header-left">
        <button class="btn-toggle-sidebar" id="btnToggleSidebar" onclick="toggleSidebar()" title="Toggle Sidebar">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="3" y1="12" x2="21" y2="12"></line>
            <line x1="3" y1="6" x2="21" y2="6"></line>
            <line x1="3" y1="18" x2="21" y2="18"></line>
          </svg>
        </button>
        <div class="brand" onclick="startNewSession()">
          <span>ngodingpake<span class="dot">ai</span></span>
        </div>
      </div>

      <div class="theme-segmented" role="radiogroup" aria-label="Theme switcher">
        <button class="theme-btn" id="btnLight" onclick="setTheme('light')" title="Light mode">
          <svg viewBox="0 0 24 24">
            <circle cx="12" cy="12" r="4"></circle>
            <path d="M12 2v2"></path>
            <path d="M12 20v2"></path>
            <path d="m4.93 4.93 1.41 1.41"></path>
            <path d="m17.66 17.66 1.41 1.41"></path>
            <path d="M2 12h2"></path>
            <path d="M20 12h2"></path>
            <path d="m6.34 17.66-1.41 1.41"></path>
            <path d="m19.07 4.93-1.41 1.41"></path>
          </svg>
        </button>
        <button class="theme-btn active" id="btnDark" onclick="setTheme('dark')" title="Dark mode">
          <svg viewBox="0 0 24 24">
            <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"></path>
          </svg>
        </button>
      </div>
    </header>

    <div class="content-area">
      <!-- Stepper Flow -->
      <div class="stepper">
        <div class="step-item active" id="stepIndicator1">
          <div class="step-num">1</div>
          <span>Input Ide</span>
        </div>
        <div class="step-line"></div>
        <div class="step-item" id="stepIndicator2">
          <div class="step-num">2</div>
          <span>Klarifikasi AI</span>
        </div>
        <div class="step-line"></div>
        <div class="step-item" id="stepIndicator3">
          <div class="step-num">3</div>
          <span>Dokumen PRD</span>
        </div>
      </div>

      <!-- STEP 1: INPUT IDE -->
      <div class="view-panel active" id="step-1">
        <h1 class="view-title">Rancang Aplikasi Baru</h1>
        <p class="view-desc">Pilih AI Engine dan ceritakan kebutuhan sistem Anda. AI akan menganalisis aspek arsitektur dan mengajukan pertanyaan klarifikasi mendalam.</p>

        <div class="card">
          <div class="form-group">
            <label class="label">Pilihan Model AI Engine</label>
            <select class="select-input" id="ai-model-select">
              <option value="oa/gemini-3.8-flash-high">Gemini 3.8 Flash High (Cepat & Cerdas)</option>
              <option value="oa/claude-opus-4.8">Claude Opus 4.8 (Arsitektur FAANG Sangat Detail)</option>
              <option value="oa/claude-sonnet-4.6">Claude Sonnet 4.6 (Presisi & Cepat)</option>
              <option value="oa/deepseek-v4-pro-0813">DeepSeek V4 Pro (Spesialis Code Spec)</option>
              <option value="oa/gpt-5.6-luna">GPT 5.6 Luna (Reasoning Model)</option>
            </select>
          </div>

          <div class="form-group">
            <label class="label">Nama Proyek (Opsional)</label>
            <input type="text" class="input-text" id="proj-name" placeholder="Misal: Katalog Inventory Gudang">
          </div>

          <div class="form-group">
            <label class="label">Deskripsi Ide / Problem Statement</label>
            <textarea class="textarea" id="proj-idea" placeholder="Ceritakan fitur utama, alur kerja transaksi, integrasi pihak ketiga, atau target pengguna..."></textarea>
          </div>

          <div style="display: flex; justify-content: flex-end;">
            <button class="btn-primary" id="btn-discover" onclick="startDiscovery()">
              <span>Minta AI Buat Pertanyaan Klarifikasi</span>
            </button>
          </div>
        </div>
      </div>

      <!-- STEP 2: KLARIFIKASI AI -->
      <div class="view-panel" id="step-2">
        <h1 class="view-title">Pertanyaan Klarifikasi Arsitektur</h1>
        <p class="view-desc" id="analysis-brief">Tentukan keputusan teknis dan alur bisnis berikut sebelum menyusun PRD final.</p>

        <div class="card">
          <div id="questions-container"></div>

          <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 1.5rem; gap: 1rem; flex-wrap: wrap;">
            <button class="btn-secondary" onclick="resetStep1()">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><line x1="19" y1="12" x2="5" y2="12"></line><polyline points="12 19 5 12 12 5"></polyline></svg>
              <span>Ubah Deskripsi Ide</span>
            </button>
            <button class="btn-primary" id="btn-generate-prd" onclick="submitClarifications()">
              <span>Susun PRD & Daftar Tugas</span>
            </button>
          </div>
        </div>
      </div>

      <!-- STEP 3: WORKSPACE PRD & TASK TRACKER -->
      <div class="view-panel" id="workspace-view">
        <div style="margin-bottom: 1.25rem;">
          <div style="display: flex; justify-content: space-between; align-items: center; gap: 1rem;">
            <h1 class="view-title" id="ws-name" style="word-break: break-word; font-size: 1.45rem; margin-bottom: 0;">Project Name</h1>
            <div style="display: flex; gap: 0.5rem; flex-shrink: 0;">
              <button class="btn-secondary" id="btn-preview-ui" style="white-space: nowrap;" onclick="openPreview()" title="Lihat contoh tampilan dari modul Design System">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>
                <span>Lihat Preview UI</span>
              </button>
              <button class="btn-secondary" style="white-space: nowrap;" onclick="startNewSession()">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
                <span>Project Baru</span>
              </button>
            </div>
          </div>
          <p id="ws-tagline" style="color: var(--accent); font-style: italic; font-size: 0.85rem; margin-top: 4px;"></p>
          <p id="ws-summary" style="color: var(--text-muted); font-size: 0.875rem; margin-top: 6px; line-height: 1.5;"></p>
        </div>

        <!-- PANDUAN EKSEKUSI PEMULA (ALUR RESMI) -->
        <div class="guide-box">
          <div class="guide-title">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>
            <span>Alur Resmi Eksekusi (Mulai dari mana?):</span>
          </div>
          <div class="guide-steps">
            <div class="guide-step-item">
              <span class="guide-badge">LANGKAH 1</span>
              <div>
                <strong>Berikan Konteks Awal ke AI:</strong>
                <div class="guide-text">Buka Cursor / the assistant / ChatGPT, lalu salin prompt konteks awal di bawah ini untuk mengajari AI tentang gambaran umum arsitektur dan modul proyek Anda.</div>
                <button class="btn-copy guide-actions" onclick="copyFullArchitecturePrompt(this)">
                  <svg viewBox="0 0 24 24"><rect x="9" y="9" width="12" height="12" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
                  <span>Salin Prompt Konteks Awal</span>
                </button>
              </div>
            </div>
            <div class="guide-step-item">
              <span class="guide-badge">LANGKAH 2</span>
              <div>
                <strong>Eksekusi Task Bertahap (Satu per Satu):</strong>
                <div class="guide-text">Scroll ke bagian <b>Daftar Task</b> di bawah. Klik tombol <b>Salin Prompt Task</b> mulai dari <b>TASK-01</b>, paste ke AI coding agent Anda, lalu uji hasilnya sampai berhasil.</div>
              </div>
            </div>
            <div class="guide-step-item">
              <span class="guide-badge">LANGKAH 3</span>
              <div>
                <strong>Lanjut ke Task Berikutnya:</strong>
                <div class="guide-text">Ulangi untuk <b>TASK-02</b>, <b>TASK-03</b>, dst. Jangan lompat task agar kode aplikasi tersusun rapi tanpa bug dependensi.</div>
              </div>
            </div>
          </div>
        </div>

        <!-- Tech Stack & Progress -->
        <div class="card">
          <div class="card-title">Execution Progress & Tech Stack</div>
          <div id="ws-tech-stack" style="margin-top: 8px; margin-bottom: 12px;"></div>

          <div>
            <div style="display: flex; justify-content: space-between; font-size: 0.85rem; font-weight: 600;">
              <span>Progress Task Eksekusi</span>
              <span id="ws-progress-text">0% (0/0)</span>
            </div>
            <div class="progress-bar-wrap">
              <div class="progress-bar" id="ws-progress-fill"></div>
            </div>
          </div>

          <div style="margin-top: 1rem;">
            <label class="label">Command Sync Terminal / AI Coding Agent:</label>
            <div class="cli-box">
              <span id="ws-cli-cmd" class="cli-cmd">prdmaker connect ...</span>
              <button class="btn-copy" onclick="copyCli(this)">
                <svg viewBox="0 0 24 24"><rect x="9" y="9" width="12" height="12" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
                <span>Salin</span>
              </button>
            </div>
          </div>
        </div>

        <!-- System Architecture Overview -->
        <div class="card">
          <div class="card-title">Arsitektur & Spesifikasi Sistem</div>

          <div class="sec-block" style="margin-top: 0.75rem; border-top: none; padding-top: 0;">
            <h4>Ringkasan Arsitektur</h4>
            <p id="ws-architecture" style="font-size: 0.85rem; color: var(--text-muted); line-height: 1.6;"></p>
          </div>

          <div class="sec-block">
            <h4>Modul Fitur & Acceptance Criteria</h4>
            <div id="ws-features"></div>
          </div>

          <div class="sec-block">
            <h4>Database Schema & Relasi</h4>
            <div id="ws-dbschema"></div>
          </div>

          <div class="sec-block">
            <h4>API Contracts & Endpoints</h4>
            <div id="ws-endpoints"></div>
          </div>
        </div>

        <!-- Task List -->
        <div class="card">
          <div class="card-title">Daftar Task Eksekusi Terminal (Realtime)</div>
          <div class="card-desc">Status task tersinkronisasi otomatis saat AI agent menyelesaikan pekerjaan di CLI.</div>
          <div id="tasks-container"></div>
        </div>

        <!-- Append Feature Request -->
        <div class="card">
          <div class="card-title">Ubah / Tambah Fitur Baru di Tengah Jalan</div>
          <div class="card-desc">Ingin menambah modul atau integrasi baru? Ketik permintaannya di bawah, AI akan memperbarui PRD dan menambahkan task baru.</div>
          <textarea class="textarea" id="change-request-input" rows="3" placeholder="Contoh: Tambahkan sistem export transaksi ke Excel dan notifikasi Telegram..."></textarea>
          <div style="display: flex; justify-content: flex-end; margin-top: 0.75rem;">
            <button class="btn-primary" id="btn-submit-change" onclick="submitChangeRequest()">
              <span>Perbarui PRD & Tambahkan Task Baru</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>

  <script>
    let currentWsId = null;
    let questionsList = [];

    function toggleSidebar() {
      const sidebar = document.getElementById('sidebar');
      sidebar.classList.toggle('collapsed');
      localStorage.setItem('sidebar_collapsed', sidebar.classList.contains('collapsed'));
    }

    function setTheme(theme) {
      document.documentElement.setAttribute('data-theme', theme);
      localStorage.setItem('ngoding_theme', theme);

      const btnLight = document.getElementById('btnLight');
      const btnDark = document.getElementById('btnDark');

      if (theme === 'light') {
        btnLight.classList.add('active');
        btnDark.classList.remove('active');
      } else {
        btnDark.classList.add('active');
        btnLight.classList.remove('active');
      }
    }

    function setStep(step, skipScroll = false) {
      document.querySelectorAll('.view-panel').forEach(el => el.classList.remove('active'));
      document.querySelectorAll('.step-item').forEach((el, idx) => {
        el.classList.remove('active', 'completed');
        if (idx + 1 < step) el.classList.add('completed');
        if (idx + 1 === step) el.classList.add('active');
      });

      if (step === 1) document.getElementById('step-1').classList.add('active');
      if (step === 2) document.getElementById('step-2').classList.add('active');
      if (step === 3) {
        document.getElementById('workspace-view').classList.add('active');
        startPolling();
      }

      if (!skipScroll) {
        window.scrollTo(0, 0);
      }
    }

    async function initModels() {
      try {
        const res = await fetch('/api/v1/models', { credentials: 'include', headers: { 'Accept': 'application/json' } });
        if (!res.ok) return;
        const data = await res.json();
        if (data.models && data.models.length > 0) {
          const select = document.getElementById('ai-model-select');
          const currentVal = select.value;
          select.innerHTML = '';
          data.models.forEach(m => {
            const opt = document.createElement('option');
            opt.value = m;
            opt.innerText = m;
            if (m === currentVal || m === 'oa/gemini-3.8-flash-high') opt.selected = true;
            select.appendChild(opt);
          });
        }
      } catch (err) {
        console.warn('Failed to load dynamic model list:', err);
      }
    }

    async function loadHistorySidebar() {
      const listEl = document.getElementById('sidebar-history-list');
      const countEl = document.getElementById('sidebar-count');

      try {
        const res = await fetch('/api/v1/workspaces', { credentials: 'include', headers: { 'Accept': 'application/json' } });
        if (!res.ok) throw new Error('HTTP status ' + res.status);
        const data = await res.json();
        const list = data.workspaces || [];
        countEl.innerText = list.length + ' Sesi';

        if (list.length === 0) {
          listEl.innerHTML = '<li style="padding: 0.75rem; color: var(--text-subtle); font-size: 0.8rem;">Belum ada riwayat sesi.</li>';
          return;
        }

        listEl.innerHTML = '';
        list.forEach(item => {
          const li = document.createElement('li');
          li.className = 'history-row' + (item.id === currentWsId ? ' active' : '');
          li.onclick = () => {
            window.location.hash = item.id;
            loadWorkspace(item.id);
          };

          const stats = item.stats || { progress: 0, completed: 0, total: 0 };
          const topDiv = document.createElement('div');
          topDiv.className = 'row-top';
          const nameDiv = document.createElement('div');
          nameDiv.className = 'row-name';
          nameDiv.textContent = item.name;
          const delBtn = document.createElement('button');
          delBtn.className = 'btn-del-ws';
          delBtn.title = 'Hapus Sesi';
          delBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>';
          delBtn.onclick = (e) => deleteWorkspace(e, item.id);
          topDiv.appendChild(nameDiv);
          topDiv.appendChild(delBtn);
          const metaDiv = document.createElement('div');
          metaDiv.className = 'row-meta';
          const metaL = document.createElement('span');
          metaL.textContent = stats.progress + '% (' + stats.completed + '/' + stats.total + ')';
          const metaR = document.createElement('span');
          metaR.textContent = (item.created_at || '').substring(0, 10);
          metaDiv.appendChild(metaL);
          metaDiv.appendChild(metaR);
          li.appendChild(topDiv);
          li.appendChild(metaDiv);

          listEl.appendChild(li);
        });
      } catch (err) {
        console.error(err);
        listEl.innerHTML = '<li style="padding: 0.75rem; color: var(--status-failed); font-size: 0.8rem;">Gagal memuat sesi.</li>';
      }
    }

    async function deleteWorkspace(event, id) {
      event.stopPropagation();
      if (!confirm('Yakin ingin menghapus workspace ini beserta seluruh task-nya?')) return;

      try {
        const res = await fetch('/api/v1/workspaces/' + id, { method: 'DELETE', credentials: 'include' });
        const data = await res.json();
        if (data.error) throw new Error(data.error);

        if (currentWsId === id) {
          startNewSession();
        } else {
          loadHistorySidebar();
        }
      } catch (err) {
        alert('Gagal menghapus: ' + err.message);
      }
    }

    async function startDiscovery() {
      const idea = document.getElementById('proj-idea').value.trim();
      const name = document.getElementById('proj-name').value.trim();
      const model = document.getElementById('ai-model-select').value;

      if (!idea) return alert('Masukkan deskripsi ide aplikasi terlebih dahulu!');

      const btn = document.getElementById('btn-discover');
      btn.innerHTML = '<span>Menganalisis Kebutuhan Arsitektur...</span>';
      btn.disabled = true;

      try {
        const res = await fetch('/api/v1/workspaces/clarify', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ idea, name, model })
        });
        const data = await res.json();
        if (data.error) throw new Error(data.error);

        questionsList = data.questions || [];
        if (data.projectSuggestion && !name) {
          document.getElementById('proj-name').value = data.projectSuggestion;
        }
        document.getElementById('analysis-brief').innerText = data.briefAnalysis || 'AI menganalisis ide proyek Anda dan memerlukan keputusan teknis ini:';

        const qc = document.getElementById('questions-container');
        qc.innerHTML = '';
        questionsList.forEach((q, qIdx) => {
          const card = document.createElement('div');
          card.className = 'q-card';
          const isMulti = q.allowMultiple === true;
          const inputType = isMulti ? 'checkbox' : 'radio';
          const qtext = document.createElement('div');
          qtext.className = 'q-text';
          const qnum = document.createElement('span');
          qnum.className = 'q-num';
          qnum.textContent = String(qIdx + 1).padStart(2, '0');
          qtext.appendChild(qnum);
          qtext.appendChild(document.createTextNode(q.question));
          const optsBox = document.createElement('div');
          optsBox.className = 'q-options';
          if (isMulti) {
            const hint = document.createElement('div');
            hint.className = 'q-hint';
            hint.textContent = 'Boleh pilih lebih dari satu.';
            optsBox.appendChild(hint);
          }
          (q.options || []).forEach((opt, oIdx) => {
            const label = document.createElement('label');
            label.className = 'option-pill';
            const input = document.createElement('input');
            input.type = inputType;
            input.name = 'q_' + qIdx;
            input.value = opt;
            if (oIdx === 0) input.checked = true;
            const span = document.createElement('span');
            span.textContent = opt;
            label.appendChild(input);
            label.appendChild(span);
            optsBox.appendChild(label);
          });
          card.appendChild(qtext);
          card.appendChild(optsBox);
          qc.appendChild(card);
        });

        setStep(2);
      } catch (err) {
        alert('Gagal: ' + err.message);
      } finally {
        btn.innerHTML = '<span>Minta AI Buat Pertanyaan Klarifikasi</span>';
        btn.disabled = false;
      }
    }

    function resetStep1() {
      setStep(1);
    }

    function openPreview() {
      if (!currentWsId) return alert('Buka salah satu sesi terlebih dahulu.');
      window.open('/api/v1/workspaces/' + currentWsId + '/preview', '_blank');
    }

    function startNewSession() {
      currentWsId = null;
      window.location.hash = '';
      document.getElementById('proj-name').value = '';
      document.getElementById('proj-idea').value = '';
      setStep(1);
      loadHistorySidebar();
    }

    async function submitClarifications() {
      const idea = document.getElementById('proj-idea').value.trim();
      const name = document.getElementById('proj-name').value.trim();
      const model = document.getElementById('ai-model-select').value;

      const clarifications = [];
      questionsList.forEach((q, qIdx) => {
        const isMulti = q.allowMultiple === true;
        let answer = '';
        if (isMulti) {
          const checkedEls = Array.from(document.querySelectorAll('input[name="q_' + qIdx + '"]:checked'));
          answer = checkedEls.map(el => el.value).join(', ');
        } else {
          const checked = document.querySelector('input[name="q_' + qIdx + '"]:checked');
          answer = checked ? checked.value : '';
        }

        clarifications.push({
          question: q.question,
          answer: answer || (q.options ? q.options[0] : '')
        });
      });

      const btn = document.getElementById('btn-generate-prd');
      btn.innerHTML = '<span>Menyusun Deep PRD & Tasks...</span>';
      btn.disabled = true;

      try {
        const res = await fetch('/api/v1/workspaces/generate', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ idea, name, model, clarifications })
        });
        const data = await res.json();
        if (data.error) throw new Error(data.error);

        window.location.hash = data.workspace.id;
        await loadWorkspace(data.workspace.id);
        loadHistorySidebar();
      } catch (err) {
        alert('Gagal: ' + err.message);
      } finally {
        btn.innerHTML = '<span>Susun PRD & Daftar Tugas</span>';
        btn.disabled = false;
      }
    }

    let lastTasksHash = '';

    async function loadWorkspace(id, isPolling = false) {
      try {
        const res = await fetch('/api/v1/workspaces/' + id, { credentials: 'include' });
        const data = await res.json();
        if (data.error) return;

        currentWsId = id;
        const ws = data.workspace;

        setStep(3, isPolling);

        // Jangan overwrite DOM statis jika polling
        if (!isPolling) {
          document.getElementById('ws-name').innerText = ws.name;
          document.getElementById('ws-tagline').innerText = ws.tagline ? '\"' + ws.tagline + '\"' : '';
          document.getElementById('ws-summary').innerText = ws.summary;
          document.getElementById('ws-architecture').innerText = ws.architecture || 'Tidak ada spesifikasi khusus.';

          const techBox = document.getElementById('ws-tech-stack');
          techBox.innerHTML = '';
          (ws.tech_stack || []).forEach(t => {
            const pill = document.createElement('span');
            pill.className = 'tech-pill';
            pill.innerText = t;
            techBox.appendChild(pill);
          });

          // Features Structure
          const featBox = document.getElementById('ws-features');
          featBox.innerHTML = '';
          const features = ws.features || [];
          if (features.length === 0) {
            featBox.innerHTML = '<div class="empty-note">Tidak ada modul fitur spesifik.</div>';
          } else {
            features.forEach(f => {
              const card = document.createElement('div');
              card.className = 'module-item';
              const head = document.createElement('div');
              head.className = 'module-head';
              head.textContent = f.module || 'Modul Fitur';
              const desc = document.createElement('div');
              desc.className = 'module-desc';
              desc.textContent = f.description || '';
              card.appendChild(head);
              card.appendChild(desc);
              if (f.acceptanceCriteria && f.acceptanceCriteria.length > 0) {
                const ul = document.createElement('ul');
                ul.className = 'criteria-list';
                f.acceptanceCriteria.forEach(c => {
                  const li = document.createElement('li');
                  li.className = 'criteria-item';
                  li.textContent = c;
                  ul.appendChild(li);
                });
                card.appendChild(ul);
              }
              featBox.appendChild(card);
            });
          }

          // Database Schema Structure
          const dbBox = document.getElementById('ws-dbschema');
          dbBox.innerHTML = '';
          const schemas = ws.databaseSchema || [];
          if (schemas.length === 0) {
            dbBox.innerHTML = '<div class="empty-note">Tidak ada skema database spesifik.</div>';
          } else {
            schemas.forEach(d => {
              const card = document.createElement('div');
              card.className = 'db-table-item';
              const tName = document.createElement('div');
              tName.className = 'db-table-name';
              tName.textContent = d.table || 'table_name';
              const tDesc = document.createElement('div');
              tDesc.className = 'db-table-desc';
              tDesc.textContent = d.description || '';
              card.appendChild(tName);
              card.appendChild(tDesc);
              if (d.fields && d.fields.length > 0) {
                const chips = document.createElement('div');
                chips.className = 'field-chips';
                d.fields.forEach(fld => {
                  const chip = document.createElement('span');
                  chip.className = 'field-chip';
                  chip.textContent = fld;
                  chips.appendChild(chip);
                });
                card.appendChild(chips);
              }
              dbBox.appendChild(card);
            });
          }

          // Endpoints Structure
          const epBox = document.getElementById('ws-endpoints');
          epBox.innerHTML = '';
          const endpoints = ws.apiEndpoints || [];
          if (endpoints.length === 0) {
            epBox.innerHTML = '<div class="empty-note">Tidak ada endpoint spesifik.</div>';
          } else {
            endpoints.forEach(ep => {
              const row = document.createElement('div');
              row.className = 'endpoint-row';
              const method = (ep.method || 'GET').toUpperCase();
              const tag = document.createElement('span');
              tag.className = 'endpoint-tag tag-' + method.toLowerCase();
              tag.textContent = method;
              const path = document.createElement('code');
              path.className = 'endpoint-path';
              path.textContent = ep.path;
              const desc = document.createElement('span');
              desc.className = 'endpoint-desc';
              desc.textContent = ep.description || '';
              row.appendChild(tag);
              row.appendChild(path);
              row.appendChild(desc);
              epBox.appendChild(row);
            });
          }

          const origin = window.location.origin;
          document.getElementById('ws-cli-cmd').innerText = 'prdmaker connect --workspace ' + id + ' --token ' + ws.token + ' --url ' + origin;
        }

        // Update progress & tasks realtime HANYA jika data berubah
        const stats = data.stats;
        document.getElementById('ws-progress-text').innerText = stats.progress + '% (' + stats.completed + '/' + stats.total + ' selesai)';
        document.getElementById('ws-progress-fill').style.width = stats.progress + '%';

        const newTasksHash = JSON.stringify(data.tasks || []);
        if (newTasksHash !== lastTasksHash || !isPolling) {
          lastTasksHash = newTasksHash;
          const tasksContainer = document.getElementById('tasks-container');
          tasksContainer.innerHTML = '';
          data.tasks.forEach(t => {
            const item = document.createElement('div');
            item.className = 'task-item';
            const taskName = t.id.replace(id + '_', '');
            item.innerHTML =
              '<div class="task-head">' +
                '<div class="task-title"><span class="task-id"></span><strong></strong></div>' +
                '<div class="task-actions">' +
                  '<span class="badge-slot"></span>' +
                  '<button class="btn-copy">' +
                    '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="12" height="12" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>' +
                    '<span>Salin Prompt Task</span>' +
                  '</button>' +
                '</div>' +
              '</div>';
            item.querySelector('.task-id').textContent = taskName;
            item.querySelector('.task-title strong').textContent = t.title;
            var copyBtn = item.querySelector('.btn-copy');
            copyBtn.setAttribute('data-spec', t.spec || '');
            copyBtn.setAttribute('onclick', 'copyPromptFromBtn(this)');
            var badge = item.querySelector('.badge-slot');
            badge.className = 'badge badge-' + t.status;
            badge.textContent = t.status;
            var specDiv = document.createElement('div');
            specDiv.className = 'task-spec';
            specDiv.textContent = t.spec;
            item.appendChild(specDiv);
            if (t.reason) {
              var failDiv = document.createElement('div');
              failDiv.className = 'task-fail';
              failDiv.textContent = 'Gagal: ' + t.reason;
              item.appendChild(failDiv);
            }
            tasksContainer.appendChild(item);
          });
        }

      } catch (err) {
        console.error(err);
      }
    }

    function copyFullArchitecturePrompt(btn) {
      const name = document.getElementById('ws-name').innerText;
      const summary = document.getElementById('ws-summary').innerText;
      const arch = document.getElementById('ws-architecture').innerText;

      const techPills = Array.from(document.querySelectorAll('#ws-tech-stack .tech-pill')).map(el => el.innerText).join(', ');
      const features = Array.from(document.querySelectorAll('#ws-features .module-item')).map(el => {
        const head = el.querySelector('.module-head')?.innerText || '';
        const desc = el.querySelector('.module-desc')?.innerText || '';
        return '- ' + head + ': ' + desc;
      }).join('\\n');

      const dbs = Array.from(document.querySelectorAll('#ws-dbschema .db-table-item')).map(el => {
        const tName = el.querySelector('.db-table-name')?.innerText || '';
        const tDesc = el.querySelector('.db-table-desc')?.innerText || '';
        const flds = Array.from(el.querySelectorAll('.field-chip')).map(f => f.innerText).join(', ');
        return '- Tabel ' + tName + ' (' + tDesc + '): ' + flds;
      }).join('\\n');

      const prompt = '[KONTEKS AWAL PROYEK UNTUK AI CODING AGENT]\\n' +
        'Saya sedang membangun aplikasi: "' + name + '"\\n\\n' +
        'Ringkasan Proyek:\\n' + summary + '\\n\\n' +
        'Tech Stack: ' + techPills + '\\n\\n' +
        'Arsitektur Sistem:\\n' + arch + '\\n\\n' +
        'Modul Fitur Utama:\\n' + (features || 'Tidak ada') + '\\n\\n' +
        'Skema Database:\\n' + (dbs || 'Tidak ada') + '\\n\\n' +
        '---\\n' +
        'Tolong pelajari dan pahami konteks arsitektur proyek di atas. Cukup konfirmasi bahwa Anda sudah memahami arsitektur ini. Setelah ini saya akan memberikan instruksi task teknis bertahap (TASK-01, TASK-02, dst) untuk dikerjakan secara berurutan. Siap?';

      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(prompt).then(() => {
          showCopySuccess(btn);
        }).catch(() => {
          fallbackCopy(prompt, btn);
        });
      } else {
        fallbackCopy(prompt, btn);
      }
    }

    function copyCli(btn) {
      const txt = document.getElementById('ws-cli-cmd').innerText;
      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(txt).then(() => {
          showCopySuccess(btn);
        }).catch(() => {
          fallbackCopy(txt, btn);
        });
      } else {
        fallbackCopy(txt, btn);
      }
    }

    function copyPromptFromBtn(btn) {
      const spec = btn.getAttribute('data-spec') || '';
      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(spec).then(() => {
          showCopySuccess(btn);
        }).catch(() => {
          fallbackCopy(spec, btn);
        });
      } else {
        fallbackCopy(spec, btn);
      }
    }

    function fallbackCopy(text, btn) {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      try {
        document.execCommand('copy');
        showCopySuccess(btn);
      } catch (err) {
        alert('Gagal menyalin otomatis. Silakan blok dan salin manual.');
      }
      document.body.removeChild(ta);
    }

    function showCopySuccess(btn) {
      if (!btn) return;
      const label = btn.querySelector('span');
      if (!label) return;
      const original = label.textContent;
      btn.classList.add('is-copied');
      label.textContent = 'Tersalin';
      clearTimeout(btn._copyTimer);
      btn._copyTimer = setTimeout(() => {
        btn.classList.remove('is-copied');
        label.textContent = original;
      }, 1600);
    }

    async function submitChangeRequest() {
      if (!currentWsId) return;
      const input = document.getElementById('change-request-input');
      const changeRequest = input.value.trim();
      if (!changeRequest) return alert('Ketik perubahan fitur yang ingin ditambahkan!');

      const btn = document.getElementById('btn-submit-change');
      btn.innerText = 'Menyusun Task Baru...';
      btn.disabled = true;

      try {
        const res = await fetch('/api/v1/workspaces/' + currentWsId + '/append-change', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ changeRequest })
        });
        const data = await res.json();
        if (data.error) throw new Error(data.error);

        alert(data.message || 'Fitur baru berhasil ditambahkan!');
        input.value = '';
        loadWorkspace(currentWsId);
      } catch (err) {
        alert('Gagal: ' + err.message);
      } finally {
        btn.innerText = 'Perbarui PRD & Tambahkan Task Baru';
        btn.disabled = false;
      }
    }

    // Init
    (function() {
      const savedTheme = localStorage.getItem('ngoding_theme') || 'dark';
      const sidebarCollapsed = localStorage.getItem('sidebar_collapsed') === 'true';

      setTheme(savedTheme);
      initModels();
      loadHistorySidebar();

      if (sidebarCollapsed) {
        document.getElementById('sidebar').classList.add('collapsed');
      }

      if (window.location.hash) {
        const hashId = window.location.hash.substring(1);
        loadWorkspace(hashId);
      }
    })();

    let pollingTimer = null;

    function startPolling() {
      if (pollingTimer) clearInterval(pollingTimer);
      pollingTimer = setInterval(() => {
        const step3Visible = document.getElementById('workspace-view').classList.contains('active');
        if (currentWsId && step3Visible) {
          loadWorkspace(currentWsId, true);
        }
      }, 5000);
    }
  </script>
</body>
</html>`;
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`PRD-Maker running at http://127.0.0.1:${PORT}`);
});
