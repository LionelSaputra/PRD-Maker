#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';

// Berkas konfigurasi CLI. Nama lama (.ngodingai.json) tetap dibaca supaya repo
// yang sudah terhubung tidak perlu connect ulang setelah proyek berganti nama.
const CONFIG_FILE = resolve(process.cwd(), '.prdmaker.json');
const CONFIG_FILE_LEGACY = resolve(process.cwd(), '.ngodingai.json');

function configPath() {
  if (existsSync(CONFIG_FILE)) return CONFIG_FILE;
  if (existsSync(CONFIG_FILE_LEGACY)) return CONFIG_FILE_LEGACY;
  return CONFIG_FILE;
}

function getConfig() {
  const path = configPath();
  if (!existsSync(path)) {
    console.error('Error: Workspace not connected.');
    console.error('Run: npx prdmaker connect --workspace <id> --token <token>');
    process.exit(1);
  }
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    console.error('Error: Failed to parse config file.');
    process.exit(1);
  }
}

const args = process.argv.slice(2);
const command = args[0];

async function main() {
  if (command === 'connect') {
    const wsIdx = args.indexOf('--workspace');
    const tkIdx = args.indexOf('--token');
    const urlIdx = args.indexOf('--url');

    if (wsIdx === -1 || tkIdx === -1 || !args[wsIdx + 1] || !args[tkIdx + 1]) {
      console.error('Usage: prdmaker connect --workspace <id> --token <token> [--url <http://...>]');
      process.exit(1);
    }

    const config = {
      workspace: args[wsIdx + 1],
      token: args[tkIdx + 1],
      apiUrl: (urlIdx !== -1 && args[urlIdx + 1]) ? args[urlIdx + 1] : (process.env.PRDMAKER_API_URL || 'http://localhost:3333')
    };

    writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
    console.log(`[OK] Successfully connected repo to workspace: ${config.workspace}`);
    console.log(`[OK] Config saved to .prdmaker.json`);
    return;
  }

  if (command === 'status') {
    const config = getConfig();
    try {
      const res = await fetch(`${config.apiUrl}/api/v1/workspaces/${config.workspace}`, {
        headers: { 'Authorization': `Bearer ${config.token}` }
      });
      if (!res.ok) {
        console.error(`[Error] Failed to fetch workspace: ${res.status} ${res.statusText}`);
        process.exit(1);
      }
      const data = await res.json();
      console.log(`\n--- Workspace: ${data.workspace.name} (${data.workspace.id}) ---`);
      console.log(`Summary: ${data.workspace.summary || '-'}`);
      console.log(`Progress: ${data.stats.progress}% (${data.stats.completed}/${data.stats.total} done)`);
      console.log(`\nTasks:`);
      for (const t of data.tasks) {
        const badge = t.status === 'done' ? '[DONE]' : t.status === 'in_progress' ? '[RUN ]' : t.status === 'failed' ? '[FAIL]' : '[TODO]';
        console.log(`  ${badge} ${t.id}: ${t.title}`);
        if (t.reason) console.log(`        Reason: ${t.reason}`);
      }
      console.log('');
    } catch (err) {
      console.error(`[Error] Network failed: ${err.message}`);
      process.exit(1);
    }
    return;
  }

  if (command === 'task') {
    const sub = args[1]; // start, complete, fail
    const taskId = args[2];
    if (!sub || !taskId || !['start', 'complete', 'fail', 'done'].includes(sub)) {
      console.error('Usage: prdmaker task <start|complete|fail> <taskId> [--reason "detail"]');
      process.exit(1);
    }

    const config = getConfig();
    let status = 'in_progress';
    let reason = null;

    if (sub === 'complete' || sub === 'done') status = 'done';
    if (sub === 'fail') {
      status = 'failed';
      const rIdx = args.indexOf('--reason');
      if (rIdx !== -1 && args[rIdx + 1]) {
        reason = args[rIdx + 1];
      }
    }

    try {
      const res = await fetch(`${config.apiUrl}/api/v1/workspaces/${config.workspace}/tasks/${taskId}`, {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${config.token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ status, reason })
      });

      if (!res.ok) {
        const errTxt = await res.text();
        console.error(`[Error] Update failed: ${res.status} ${errTxt}`);
        process.exit(1);
      }

      const updated = await res.json();
      console.log(`[OK] Task ${updated.id} status updated to: [${updated.status.toUpperCase()}]`);
    } catch (err) {
      console.error(`[Error] Network failed: ${err.message}`);
      process.exit(1);
    }
    return;
  }

  console.log(`PRD-Maker CLI v1.0.0
Commands:
  prdmaker connect --workspace <id> --token <token> [--url <api_url>]
  prdmaker status
  prdmaker task start <taskId>
  prdmaker task complete <taskId>
  prdmaker task fail <taskId> --reason "reason"
`);
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
