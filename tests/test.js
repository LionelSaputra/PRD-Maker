import assert from 'assert';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const PORT = 3334;
process.env.PORT = String(PORT);
process.env.DB_PATH = ':memory:';

// Root repo dihitung dari lokasi berkas ini, bukan path absolut, supaya tes
// bisa dijalankan siapa pun yang meng-clone repo ini.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function runTests() {
  console.log('--- Starting Integration Tests ---');

  // Start Server
  const serverProc = spawn('node', ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DB_PATH: '/tmp/test_prdmaker.db' }
  });

  await new Promise(resolve => setTimeout(resolve, 1000));

  try {
    // 1. Test PRD Generation
    console.log('[Test 1] Generating PRD & Tasks...');
    const genRes = await fetch(`http://127.0.0.1:${PORT}/api/v1/workspaces/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idea: 'Sistem absensi QR Code', name: 'QR Absen' })
    });
    assert.strictEqual(genRes.status, 201);
    const genData = await genRes.json();
    assert.ok(genData.workspace.id);
    assert.ok(genData.workspace.token);
    assert.ok(genData.totalTasks > 0, 'expected at least one generated task');
    console.log(' -> Generated Workspace ID:', genData.workspace.id);
    console.log(' -> Tasks Count:', genData.totalTasks);

    const wsId = genData.workspace.id;
    const token = genData.workspace.token;

    // Ambil task pertama lewat endpoint workspace, karena respons generate
    // hanya mengembalikan jumlah task (totalTasks), bukan daftarnya.
    const detailRes = await fetch(`http://127.0.0.1:${PORT}/api/v1/workspaces/${wsId}`);
    assert.strictEqual(detailRes.status, 200);
    const detailData = await detailRes.json();
    assert.ok(Array.isArray(detailData.tasks) && detailData.tasks.length > 0);
    const taskId = detailData.tasks[0].id;
    console.log(' -> First Task ID:', taskId);

    // 2. Test Unauthorized Task Update
    console.log('[Test 2] Testing Unauthorized Update...');
    const unauthRes = await fetch(`http://127.0.0.1:${PORT}/api/v1/workspaces/${wsId}/tasks/${taskId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'in_progress' })
    });
    assert.strictEqual(unauthRes.status, 401);

    // 3. Test CLI Workflow Simulation (Start Task)
    console.log('[Test 3] Updating Task status to in_progress...');
    const startRes = await fetch(`http://127.0.0.1:${PORT}/api/v1/workspaces/${wsId}/tasks/${taskId}`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ status: 'in_progress' })
    });
    assert.strictEqual(startRes.status, 200);
    const startData = await startRes.json();
    assert.strictEqual(startData.status, 'in_progress');

    // 4. Test Workspace Progress Stats
    console.log('[Test 4] Verifying Workspace Stats...');
    const wsRes = await fetch(`http://127.0.0.1:${PORT}/api/v1/workspaces/${wsId}`);
    assert.strictEqual(wsRes.status, 200);
    const wsData = await wsRes.json();
    assert.strictEqual(wsData.tasks[0].status, 'in_progress');

    // 5. Complete Task
    console.log('[Test 5] Completing Task...');
    const doneRes = await fetch(`http://127.0.0.1:${PORT}/api/v1/workspaces/${wsId}/tasks/${taskId}`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ status: 'done' })
    });
    assert.strictEqual(doneRes.status, 200);
    const wsRes2 = await fetch(`http://127.0.0.1:${PORT}/api/v1/workspaces/${wsId}`);
    const wsData2 = await wsRes2.json();
    assert.strictEqual(wsData2.stats.completed, 1);
    console.log(` -> Progress updated: ${wsData2.stats.progress}%`);

    console.log('✅ ALL INTEGRATION TESTS PASSED!');
  } finally {
    serverProc.kill();
  }
}

runTests().catch(err => {
  console.error('Test Failed:', err);
  process.exit(1);
});
