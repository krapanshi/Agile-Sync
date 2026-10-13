import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { io as client } from 'socket.io-client';
import { createRuntime } from '../src/realtime.js';
import { digestToken } from '../src/auth/security.js';
import { fail } from '../src/http/errors.js';

const id = () => randomBytes(12).toString('hex');
function event(socket, name) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Missing ${name}`)), 2000);
    socket.once(name, data => { clearTimeout(timer); resolve(data); });
  });
}
async function fixture(t) {
  const workspaceId = id(), boardId = id(), users = [id(), id()], tokens = ['a'.repeat(64), 'b'.repeat(64)];
  const sessions = new Map(tokens.map((token, index) => [digestToken(token), { userId: users[index], expiresAt: new Date(Date.now() + 60000) }]));
  const members = new Set(users);
  let board = { _id: boardId, workspaceId, name: 'Sprint', __v: 0 };
  const store = {
    findSession: async hash => sessions.get(hash), findUser: async userId => users.includes(userId) ? { _id: userId, name: 'Tester' } : null,
    membership: async (workspace, user) => workspace === workspaceId && members.has(user) ? { role: 'owner' } : null,
    workspace: async workspace => workspace === workspaceId ? { _id: workspaceId } : null,
    boardExists: async (workspace, boardIdValue) => workspace === workspaceId && boardIdValue === boardId,
    deleteSession: async hash => sessions.delete(hash),
    snapshot: async () => ({ board: structuredClone(board), tasks: [] }),
    withBoard: async (workspace, resource, version, work) => {
      if (workspace !== workspaceId || resource !== boardId) fail(404, 'Board not found');
      if (version !== undefined && version !== board.__v) fail(409, 'Board changed');
      const draft = structuredClone(board); draft.__v++;
      const result = await work({ board: draft }); board = draft; return result;
    }
  };
  const runtime = createRuntime({ store });
  runtime.server.listen(0, '127.0.0.1');
  await new Promise(resolve => runtime.server.once('listening', resolve));
  const url = `http://127.0.0.1:${runtime.server.address().port}`, sockets = [];
  t.after(async () => { for (const socket of sockets) socket.disconnect(); await runtime.close(); });
  const socket = (index = 0, headers = {}) => {
    const socket = client(url, { transports: ['websocket'], autoConnect: false, reconnection: false, extraHeaders: { Cookie: `agile_session=${tokens[index]}`, Origin: 'http://localhost:5173', ...headers } });
    sockets.push(socket); return socket;
  };
  const connect = async index => { const value = socket(index); const connected = event(value, 'connect'); value.connect(); await connected; return value; };
  const subscribe = value => value.timeout(1000).emitWithAck('board:subscribe', { workspaceId, boardId });
  const rename = version => fetch(`${url}/api/workspaces/${workspaceId}/boards/${boardId}`, {
    method: 'PATCH', headers: { Cookie: `agile_session=${tokens[0]}`, 'Content-Type': 'application/json', 'X-Agile-Sync': '1' }, body: JSON.stringify({ name: 'Changed', version })
  });
  return { runtime, store, url, workspaceId, boardId, users, tokens, sessions, members, connect, socket, subscribe, rename };
}

test('two authenticated clients receive notifications only after an HTTP mutation succeeds', async t => {
  const { connect, subscribe, rename, workspaceId, boardId } = await fixture(t);
  const a = await connect(0), b = await connect(1);
  assert.equal((await subscribe(a)).ok, true); assert.equal((await subscribe(b)).ok, true);
  const receivedA = event(a, 'board:changed'), receivedB = event(b, 'board:changed');
  assert.equal((await rename(0)).status, 200);
  assert.deepEqual(await receivedA, { workspaceId, boardId, type: 'updated' });
  assert.deepEqual(await receivedB, { workspaceId, boardId, type: 'updated' });
  let invalidations = 0; b.on('board:changed', () => invalidations++);
  assert.equal((await rename(0)).status, 409);
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(invalidations, 0);
});

test('forged sessions, untrusted origins, cross-tenant and cross-board subscriptions are denied', async t => {
  const { connect, socket, workspaceId, boardId } = await fixture(t);
  for (const headers of [{ Cookie: 'agile_session=' + 'c'.repeat(64) }, { Origin: 'https://untrusted.example' }]) {
    const denied = socket(0, headers), rejected = event(denied, 'connect_error'); denied.connect(); await rejected;
  }
  const valid = await connect(0);
  assert.equal((await valid.timeout(1000).emitWithAck('board:subscribe', { workspaceId: id(), boardId })).ok, false);
  assert.equal((await valid.timeout(1000).emitWithAck('board:subscribe', { workspaceId, boardId: id() })).ok, false);
  assert.equal((await valid.timeout(1000).emitWithAck('board:subscribe', { workspaceId: { $ne: null }, boardId })).ok, false);
});

test('removed membership and expired sessions stop further event delivery', async t => {
  const { connect, subscribe, members, users, rename, sessions, tokens } = await fixture(t);
  const b = await connect(1); await subscribe(b);
  let leaked = 0; b.on('board:changed', () => leaked++);
  members.delete(users[1]);
  const revoked = event(b, 'session:revoked');
  assert.equal((await rename(0)).status, 200); await revoked;
  assert.equal(leaked, 0);
  members.add(users[1]);
  const next = await connect(1); await subscribe(next);
  sessions.get(digestToken(tokens[1])).expiresAt = new Date(0);
  const expired = event(next, 'session:revoked');
  assert.equal((await rename(1)).status, 200); await expired;
});

test('logout disconnects every socket for that session', async t => {
  const { connect, url, tokens } = await fixture(t);
  const a = await connect(0), b = await connect(0);
  const revokedA = event(a, 'session:revoked'), revokedB = event(b, 'session:revoked');
  const response = await fetch(`${url}/api/auth/logout`, { method: 'POST', headers: { Cookie: `agile_session=${tokens[0]}`, 'X-Agile-Sync': '1' } });
  assert.equal(response.status, 204); await revokedA; await revokedB;
});

test('reconnection authenticates again and permits a new subscription after missed updates', async t => {
  const { connect, subscribe, rename } = await fixture(t);
  const a = await connect(0); await subscribe(a); a.disconnect();
  assert.equal((await rename(0)).status, 200);
  const connected = event(a, 'connect'); a.connect(); await connected;
  assert.equal((await subscribe(a)).ok, true);
  const updated = event(a, 'board:changed'); assert.equal((await rename(1)).status, 200); await updated;
});


