import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createApp } from '../src/app.js';
import { hashPassword, verifyPassword, digestToken, can } from '../src/auth/security.js';

const id = () => randomBytes(12).toString('hex');
const credentials = { name: 'Developer', email: 'dev@example.com', password: 'a-long-test-password' };
const cookieOf = response => response.headers.get('set-cookie').split(';')[0];
function memoryStore() {
  const users = new Map(), sessions = new Map(), memberships = [], workspaces = new Map();
  return {
    users, sessions, memberships, workspaces,
    findUserByEmail: async email => [...users.values()].find(user => user.email === email),
    findUser: async userId => users.get(String(userId)),
    createUser: async data => {
      if ([...users.values()].some(user => user.email === data.email)) throw Object.assign(new Error(), { code: 11000 });
      const user = { ...data, _id: id() }; users.set(user._id, user); return user;
    },
    createSession: async data => { sessions.set(data.tokenHash, data); },
    findSession: async tokenHash => sessions.get(tokenHash),
    deleteSession: async tokenHash => { sessions.delete(tokenHash); },
    membership: async (workspaceId, userId) => memberships.find(item => item.workspaceId === workspaceId && item.userId === userId),
    workspace: async workspaceId => workspaces.get(workspaceId),
    listWorkspaces: async userId => memberships.filter(item => item.userId === userId).map(item => ({ workspace: workspaces.get(item.workspaceId), role: item.role })),
    createWorkspace: async (data, userId) => {
      const workspace = { ...data, _id: id(), createdBy: userId };
      workspaces.set(workspace._id, workspace);
      memberships.push({ workspaceId: workspace._id, userId, role: 'owner' });
      return workspace;
    },
    addMember: async data => { memberships.push(data); return data; }
  };
}
async function fixture(t, production = false) {
  const store = memoryStore();
  const server = createApp({ store, production }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const request = (path, { method = 'GET', body, cookie, headers = {} } = {}) => fetch(`http://127.0.0.1:${server.address().port}/api${path}`, {
    method, headers: { 'Content-Type': 'application/json', 'X-Agile-Sync': '1', ...(cookie ? { Cookie: cookie } : {}), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  return { store, request };
}

test('salted password hashes verify and reject wrong or missing hashes', async () => {
  const hash = await hashPassword(credentials.password);
  assert.notEqual(hash, await hashPassword(credentials.password));
  assert.equal(await verifyPassword(credentials.password, hash), true);
  assert.equal(await verifyPassword('incorrect-password', hash), false);
  assert.equal(await verifyPassword(credentials.password, undefined), false);
});

test('registration, login rotation, cookie protection, and logout revocation', async t => {
  const { request, store } = await fixture(t);
  const registered = await request('/auth/register', { method: 'POST', body: credentials });
  assert.equal(registered.status, 201);
  assert.equal((await registered.json()).user.passwordHash, undefined);
  const cookie = cookieOf(registered);
  assert.match(registered.headers.get('set-cookie'), /HttpOnly/);
  assert.match(registered.headers.get('set-cookie'), /SameSite=Strict/);
  assert.equal(store.sessions.has(cookie.split('=')[1]), false);
  assert.equal(store.sessions.has(digestToken(cookie.split('=')[1])), true);
  assert.equal((await request('/auth/me', { cookie })).status, 200);
  const login = await request('/auth/login', { method: 'POST', body: { email: credentials.email, password: credentials.password }, cookie });
  assert.equal(login.status, 200);
  const nextCookie = cookieOf(login);
  assert.notEqual(cookie, nextCookie);
  assert.equal((await request('/auth/me', { cookie })).status, 401);
  assert.equal((await request('/auth/logout', { method: 'POST', cookie: nextCookie })).status, 204);
  assert.equal((await request('/auth/me', { cookie: nextCookie })).status, 401);
});

test('input rejects operators and privilege injection; duplicate accounts conflict', async t => {
  const { request } = await fixture(t);
  for (const body of [{ ...credentials, email: { $ne: null } }, { ...credentials, role: 'owner' }, { ...credentials, password: 'short' }]) {
    assert.equal((await request('/auth/register', { method: 'POST', body })).status, 400);
  }
  assert.equal((await request('/auth/register', { method: 'POST', body: credentials })).status, 201);
  assert.equal((await request('/auth/register', { method: 'POST', body: credentials })).status, 409);
  const wrong = await request('/auth/login', { method: 'POST', body: { email: credentials.email, password: 'wrong-long-password' } });
  const unknown = await request('/auth/login', { method: 'POST', body: { email: 'unknown@example.com', password: 'wrong-long-password' } });
  assert.equal(wrong.status, 401); assert.equal(unknown.status, 401);
  assert.deepEqual(await wrong.json(), await unknown.json());
});

test('CSRF guard rejects missing header and untrusted origin', async t => {
  const { request } = await fixture(t);
  for (const headers of [{ 'X-Agile-Sync': '' }, { Origin: 'https://other.example' }]) {
    assert.equal((await request('/auth/register', { method: 'POST', body: credentials, headers })).status, 403);
  }
  assert.equal((await request('/auth/logout', { method: 'POST', headers: { Origin: 'http://127.0.0.1:5173' } })).status, 204);
});

test('expired and forged sessions cannot authenticate', async t => {
  const { request, store } = await fixture(t);
  const registered = await request('/auth/register', { method: 'POST', body: credentials });
  const cookie = cookieOf(registered);
  for (const session of store.sessions.values()) session.expiresAt = new Date(0);
  assert.equal((await request('/auth/me', { cookie })).status, 401);
  assert.equal((await request('/auth/me', { cookie: `agile_session=${'a'.repeat(64)}` })).status, 401);
});

test('workspace scope and roles block cross-tenant access and privilege escalation', async t => {
  const { request, store } = await fixture(t);
  const registered = await request('/auth/register', { method: 'POST', body: credentials });
  const cookie = cookieOf(registered);
  const created = await request('/workspaces', { method: 'POST', cookie, body: { name: 'Team A', slug: 'team-a' } });
  assert.equal(created.status, 201);
  const { workspace } = await created.json();
  assert.equal((await request(`/workspaces/${workspace._id}`, { cookie })).status, 200);
  const otherWorkspace = id();
  store.workspaces.set(otherWorkspace, { _id: otherWorkspace, name: 'Private team' });
  assert.equal((await request(`/workspaces/${otherWorkspace}`, { cookie })).status, 404);
  assert.equal((await request('/workspaces/invalid', { cookie })).status, 400);
  assert.equal((await request('/workspaces')).status, 401);
  assert.equal((await (await request('/workspaces', { cookie })).json()).workspaces.length, 1);
  for (const role of ['viewer', 'member', 'admin']) {
    store.memberships[0].role = role;
    assert.equal((await request(`/workspaces/${workspace._id}/members`, { method: 'POST', cookie, body: { email: credentials.email, role: 'admin' } })).status, 403);
  }
  store.memberships[0].role = 'owner';
  assert.equal((await request(`/workspaces/${workspace._id}/members`, { method: 'POST', cookie, body: { email: credentials.email, role: 'owner' } })).status, 400);
  const user = await store.createUser({ ...credentials, email: 'teammate@example.com' });
  assert.equal((await request(`/workspaces/${workspace._id}/members`, { method: 'POST', cookie, body: { email: user.email, role: 'viewer' } })).status, 201);
});

test('production cookies are Secure and permissions fail closed', async t => {
  const { request } = await fixture(t, true);
  const registered = await request('/auth/register', { method: 'POST', body: credentials });
  assert.match(registered.headers.get('set-cookie'), /Secure/);
  assert.equal((await request('/auth/logout', { method: 'POST', headers: { Origin: 'http://127.0.0.1:5173' } })).status, 403);
  assert.equal(can('viewer', 'tasks:write'), false);
  assert.equal(can('member', 'tasks:write'), true);
  assert.equal(can('unknown', 'workspace:read'), false);
  assert.equal(can('constructor', 'workspace:read'), false);
});

test('authentication attempts are rate limited', async t => {
  const { request } = await fixture(t);
  for (let attempt = 0; attempt < 20; attempt++) assert.equal((await request('/auth/login', { method: 'POST', body: {} })).status, 400);
  assert.equal((await request('/auth/login', { method: 'POST', body: {} })).status, 429);
});
