import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createRuntime } from '../src/realtime.js';
import { memoryStore } from './support/board-store.js';
import { runLoadTest } from '../src/load-runner.js';

test('mixed HTTP workload completes and removes only its own fixture board', { timeout: 30000 }, async t => {
  const store = memoryStore();
  // Simulate MongoDB's shared-parent serialization for this offline repository.
  const original = store.withBoard;
  let queue = Promise.resolve();
  store.withBoard = (...args) => { const result = queue.then(() => original(...args)); queue = result.catch(() => {}); return result; };
  const existing = await store.createBoard(store.workspaceId, store.userId, 'Keep this board');
  const runtime = createRuntime({ store }); runtime.server.listen(0, '127.0.0.1');
  await new Promise(resolve => runtime.server.once('listening', resolve));
  t.after(() => runtime.close());
  const report = await runLoadTest({ baseUrl: `http://127.0.0.1:${runtime.server.address().port}`, cookie: `agile_session=${store.token}`, workspaceId: store.workspaceId });
  assert.equal(report.requests, 200); assert.equal(report.reads, 140); assert.equal(report.edits, 40); assert.equal(report.moves, 20);
  assert.equal(report.unexpectedFailures, 0); assert.equal(report.fixtureCleanup, 'removed');
  assert.equal(store.boards.size, 1); assert.ok(store.boards.has(existing._id)); assert.equal(store.tasks.size, 0);
  const directory = fileURLToPath(new URL('../../benchmarks/', import.meta.url)); await mkdir(directory, { recursive: true });
  await writeFile(`${directory}/load-simulated.json`, JSON.stringify({ mode: 'OFFLINE_HTTP_WITH_IN_MEMORY_REPOSITORY_NOT_MONGODB_LOAD_RESULTS', ...report }, null, 2));
});

test('load workload bounds are validated before fixture creation', async () => {
  await assert.rejects(runLoadTest({ baseUrl: 'http://localhost', workspaceId: 'bad', concurrency: 100 }));
});

