import { memoryStore } from './support/board-store.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { createApp } from '../src/app.js';
import { Board, Task } from '../src/models/index.js';
import { digestToken } from '../src/auth/security.js';
import { fail } from '../src/http/errors.js';
import { boardActions, MAX_TASKS } from '../src/boards/service.js';

const id = () => new mongoose.Types.ObjectId().toString();
const clone = value => structuredClone(value);
async function fixture(t) {
  const store = memoryStore();
  const server = createApp({ store }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `/workspaces/${store.workspaceId}/boards`;
  const request = (path = '', { method = 'GET', body, auth = true, headers = {} } = {}) => fetch(`http://127.0.0.1:${server.address().port}/api${base}${path}`, {
    method, headers: { 'Content-Type': 'application/json', 'X-Agile-Sync': '1', ...(auth ? { Cookie: `agile_session=${store.token}` } : {}), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const created = await request('', { method: 'POST', body: { name: 'Sprint' } });
  assert.equal(created.status, 201);
  const { board } = await created.json();
  const createTask = async (title, columnId = board.columns[0]._id, extra = {}) => {
    const response = await request(`/${board._id}/tasks`, { method: 'POST', body: { title, columnId, ...extra } });
    assert.equal(response.status, 201); return (await response.json()).task;
  };
  return { store, request, board, createTask };
}

test('board/task CRUD and stale edits return conflicts without mutation', async t => {
  const { request, board, createTask } = await fixture(t);
  const task = await createTask('Implement API');
  const updated = await request(`/${board._id}/tasks/${task._id}`, { method: 'PATCH', body: { title: 'Updated title', version: 0 } });
  assert.equal(updated.status, 200);
  assert.equal((await updated.json()).task.__v, 1);
  assert.equal((await request(`/${board._id}/tasks/${task._id}`, { method: 'PATCH', body: { title: 'Stale', version: 0 } })).status, 409);
  const snapshot = await (await request(`/${board._id}`)).json();
  assert.equal(snapshot.tasks[0].title, 'Updated title');
  assert.equal((await request(`/${board._id}`, { method: 'PATCH', body: { name: 'Stale board', version: 0 } })).status, 409);
  assert.equal((await request(`/${board._id}`, { method: 'PATCH', body: { name: 'Renamed', version: snapshot.board.__v } })).status, 200);
  assert.equal((await request(`/${board._id}/tasks/${task._id}`, { method: 'DELETE', body: { version: 1 } })).status, 204);
  assert.equal((await (await request(`/${board._id}`)).json()).tasks.length, 0);
});

test('moves insert before anchors, rebalance, and protect against stale task versions', async t => {
  const { request, board, createTask } = await fixture(t);
  const a = await createTask('A'), b = await createTask('B'), c = await createTask('C', board.columns[1]._id);
  const moved = await request(`/${board._id}/tasks/${b._id}/move`, { method: 'POST', body: { columnId: board.columns[1]._id, beforeTaskId: c._id, version: 0 } });
  assert.equal(moved.status, 200);
  const result = await moved.json();
  assert.equal(result.task.position, 0);
  assert.equal(result.changedTasks.find(task => task._id === c._id).position, 1000);
  assert.equal((await request(`/${board._id}/tasks/${c._id}`, { method: 'PATCH', body: { title: 'Stale C', version: 0 } })).status, 409);
  assert.equal((await request(`/${board._id}/tasks/${a._id}/move`, { method: 'POST', body: { columnId: board.columns[1]._id, beforeTaskId: null, version: 0 } })).status, 200);
  const snapshot = await (await request(`/${board._id}`)).json();
  const destination = snapshot.tasks.filter(task => task.columnId === board.columns[1]._id).sort((a, b) => a.position - b.position);
  assert.deepEqual(destination.map(task => task.title), ['B', 'C', 'A']);
});

test('tenant IDs, columns, assignees, and anchor tasks cannot escape scope', async t => {
  const { request, store, board, createTask } = await fixture(t);
  const foreignWorkspace = id();
  const foreignBoard = await store.createBoard(foreignWorkspace, store.userId, 'Private');
  assert.equal((await request(`/${foreignBoard._id}`)).status, 404);
  assert.equal((await request(`/${board._id}/tasks`, { method: 'POST', body: { title: 'Bad', columnId: foreignBoard.columns[0]._id } })).status, 400);
  assert.equal((await request(`/${board._id}/tasks`, { method: 'POST', body: { title: 'Bad', columnId: board.columns[0]._id, assigneeId: id() } })).status, 400);
  const assignee = id(); store.members.set(`${store.workspaceId}:${assignee}`, { role: 'member' });
  const task = await createTask('Assigned', board.columns[0]._id, { assigneeId: assignee });
  assert.equal((await request(`/${board._id}/tasks/${task._id}/move`, { method: 'POST', body: { version: 0, columnId: board.columns[0]._id, beforeTaskId: id() } })).status, 400);
  assert.equal((await request(`/${foreignBoard._id}/tasks/${task._id}`, { method: 'PATCH', body: { version: 0, title: 'Escaped' } })).status, 404);
  assert.equal(store.tasks.get(task._id).title, 'Assigned');
});

test('viewer is read-only; unauthenticated and CSRF mutations fail', async t => {
  const { request, store, board, createTask } = await fixture(t);
  const task = await createTask('Read only');
  store.members.set(`${store.workspaceId}:${store.userId}`, { role: 'viewer' });
  assert.equal((await request(`/${board._id}`)).status, 200);
  for (const [path, method, body] of [ ['', 'POST', { name: 'Blocked' }], [`/${board._id}`, 'DELETE', { version: 1 }], [`/${board._id}/tasks/${task._id}`, 'PATCH', { version: 0, title: 'Blocked' }] ]) {
    assert.equal((await request(path, { method, body })).status, 403);
  }
  assert.equal((await request('', { auth: false })).status, 401);
  assert.equal((await request('', { method: 'POST', body: { name: 'Blocked' }, headers: { 'X-Agile-Sync': '' } })).status, 403);
  store.members.delete(`${store.workspaceId}:${store.userId}`);
  assert.equal((await request('')).status, 404);
});

test('columns reorder and rename; populated columns cannot be removed; board deletion cascades', async t => {
  const { request, board, createTask } = await fixture(t);
  await createTask('Keep me');
  assert.equal((await request(`/${board._id}/columns/${board.columns[0]._id}`, { method: 'DELETE', body: { version: 1 } })).status, 409);
  let snapshot = await (await request(`/${board._id}`)).json();
  assert.equal(snapshot.board.__v, 1);
  const columns = [...snapshot.board.columns].reverse().map(column => ({ _id: column._id, name: column.name + '!' }));
  assert.equal((await request(`/${board._id}/columns`, { method: 'PUT', body: { version: 1, columns } })).status, 200);
  snapshot = await (await request(`/${board._id}`)).json();
  assert.deepEqual(snapshot.board.columns.map(column => column.position), [0, 1000, 2000]);
  assert.equal((await request(`/${board._id}/columns`, { method: 'POST', body: { version: 2, name: 'Review' } })).status, 201);
  assert.equal((await request(`/${board._id}`, { method: 'DELETE', body: { version: 3 } })).status, 204);
  assert.equal((await request(`/${board._id}`)).status, 404);
});

test('invalid IDs, injected fields, missing versions, and oversized pagination fail', async t => {
  const { request, board } = await fixture(t);
  assert.equal((await request('/invalid')).status, 400);
  assert.equal((await request('?limit=101')).status, 400);
  assert.equal((await request('', { method: 'POST', body: { name: 'Injected', workspaceId: id() } })).status, 400);
  assert.equal((await request(`/${board._id}`, { method: 'PATCH', body: { name: 'No version' } })).status, 400);
  assert.equal((await request(`/${board._id}/tasks`, { method: 'POST', body: { title: 'Bad', columnId: board.columns[0]._id, dueAt: 'tomorrow' } })).status, 400);
  assert.equal((await request(`/${board._id}/tasks`, { method: 'POST', body: { title: 'Bad date', columnId: board.columns[0]._id, dueAt: '2026-02-30T10:00:00Z' } })).status, 400);
  assert.equal((await request(`/${board._id}/tasks`, { method: 'POST', body: { title: 'Valid date', columnId: board.columns[0]._id, dueAt: '2026-10-12T10:00:00Z' } })).status, 201);
});

test('task capacity is enforced before creating more cards', async () => {
  const columnId = id();
  const context = { board: { columns: [{ _id: columnId }] }, tasks: async () => Array(MAX_TASKS).fill({ columnId }), createTask: () => { throw new Error('Must not create'); } };
  await assert.rejects(boardActions.createTask(context, { columnId }, id()), error => error.status === 409);
});

