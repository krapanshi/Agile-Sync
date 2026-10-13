import test from 'node:test';
import assert from 'node:assert/strict';
import { createHttpClient } from '../src/api.js';
import { createDemoClient, DEMO_KEY } from '../src/demo.js';

function storage() {
  const data = new Map();
  return { getItem: key => data.get(key) || null, setItem: (key, value) => data.set(key, value) };
}
async function fixture() {
  const saved = storage(), api = createDemoClient(saved);
  const { workspaces } = await api('/workspaces');
  const base = `/workspaces/${workspaces[0].workspace._id}/boards`;
  const { boards } = await api(base);
  const path = `${base}/${boards[0]._id}`;
  return { saved, api, base, path, ...await api(path) };
}

test('HTTP adapter sends session cookies and mutation/CSRF headers without local tokens', async () => {
  let call;
  const api = createHttpClient(async (url, options) => { call = { url, options }; return Response.json({ user: { name: 'Tester' } }); });
  await api('/auth/login', { method: 'POST', body: { email: 'test@example.com', password: 'test-only-password' } });
  assert.equal(call.url, '/api/auth/login');
  assert.equal(call.options.credentials, 'same-origin');
  assert.equal(call.options.headers['X-Agile-Sync'], '1');
  assert.equal(call.options.headers.Authorization, undefined);
  assert.equal(call.options.headers['Content-Type'], 'application/json');
});

test('HTTP adapter preserves conflict status, handles 204, and reports unavailable API', async () => {
  await assert.rejects(createHttpClient(async () => Response.json({ error: 'Stale version' }, { status: 409 }))('/board'), error => error.status === 409 && error.message === 'Stale version');
  assert.equal(await createHttpClient(async () => new Response(null, { status: 204 }))('/logout'), null);
  await assert.rejects(createHttpClient(async () => { throw new TypeError('Offline'); })('/board'), error => error.status === 0);
});

test('demo task creation survives a new client without persisting credentials', async () => {
  const { saved, api, path, board } = await fixture();
  await api(`${path}/tasks`, { method: 'POST', body: { title: 'Persist me', columnId: board.columns[0]._id } });
  assert.equal((await createDemoClient(saved)(path)).tasks.some(task => task.title === 'Persist me'), true);
  const raw = saved.getItem(DEMO_KEY);
  assert.equal(raw.includes('password'), false); assert.equal(raw.includes('tokenHash'), false);
});

test('demo moves rebalance and stale edits roll back board/task state', async () => {
  const { api, path, board, tasks } = await fixture();
  const task = tasks[0], target = tasks.find(item => item.columnId === board.columns[1]._id);
  const result = await api(`${path}/tasks/${task._id}/move`, { method: 'POST', body: { version: 0, columnId: target.columnId, beforeTaskId: target._id } });
  assert.equal(result.task.position, 0); assert.equal(result.task.__v, 1);
  const before = await api(path);
  await assert.rejects(api(`${path}/tasks/${task._id}`, { method: 'PATCH', body: { version: 0, title: 'Stale' } }), error => error.status === 409);
  assert.deepEqual(await api(path), before);
});

test('demo rejects invalid anchors, columns, populated-column deletion, and foreign workspace paths', async () => {
  const { api, path, board, tasks } = await fixture();
  const before = await api(path), task = tasks[0];
  await assert.rejects(api(`${path}/tasks/${task._id}/move`, { method: 'POST', body: { version: 0, columnId: board.columns[0]._id, beforeTaskId: task._id } }), error => error.status === 400);
  await assert.rejects(api(`${path}/columns/${board.columns[0]._id}`, { method: 'DELETE', body: { version: 0 } }), error => error.status === 409);
  await assert.rejects(api('/workspaces/000000000000000000000000/boards'), error => error.status === 404);
  assert.deepEqual(await api(path), before);
});

test('storage write failures leave demo state unchanged', async () => {
  const api = createDemoClient({ getItem: () => null, setItem: () => { throw new Error('Full'); } });
  const before = await api('/workspaces');
  await assert.rejects(api('/workspaces', { method: 'POST', body: { name: 'New', slug: 'new' } }), error => error.status === 507);
  assert.deepEqual(await api('/workspaces'), before);
});
