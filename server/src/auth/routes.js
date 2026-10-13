import express from 'express';
import { HttpError } from '../http/errors.js';
import { createBoardRouter } from '../boards/routes.js';
export { HttpError } from '../http/errors.js';
import { hashPassword, verifyPassword, digestToken, newToken, sessionLifetime, cookieToken, cookieOptions, can } from './security.js';

const fail = (status, message) => { throw new HttpError(status, message); };
const identifier = value => {
  if (typeof value !== 'string' || !/^[a-f0-9]{24}$/i.test(value)) fail(400, 'Invalid workspace ID');
  return value;
};
function input(body, fields) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !fields.includes(key))) fail(400, 'Invalid request fields');
  return body;
}
function email(value) {
  if (typeof value !== 'string') fail(400, 'A valid email is required');
  const normalized = value.trim().toLowerCase();
  if (normalized.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) fail(400, 'A valid email is required');
  return normalized;
}
function password(value) {
  if (typeof value !== 'string' || value.length < 12 || Buffer.byteLength(value) > 256) fail(400, 'Password must contain at least 12 characters and at most 256 bytes');
  return value;
}
function name(value, maximum) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maximum) fail(400, 'Invalid name');
  return value.trim();
}
const publicUser = user => ({ id: String(user._id), name: user.name, email: user.email });

export function createAuthRouter(store, { production = false, appOrigin = 'http://localhost:5173' } = {}) {
  const router = express.Router();
  const cookie = cookieOptions(production);
  const allowedOrigins = new Set([appOrigin]);
  if (!production && ['http://localhost:5173', 'http://127.0.0.1:5173'].includes(appOrigin)) {
    allowedOrigins.add('http://localhost:5173');
    allowedOrigins.add('http://127.0.0.1:5173');
  }
  const attempts = new Map();

  // A custom header forces browser cross-origin requests to preflight; no CORS grants are issued.
  router.use((req, _res, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      if (req.get('X-Agile-Sync') !== '1') return next(new HttpError(403, 'X-Agile-Sync header required'));
      if (req.get('Origin') && !allowedOrigins.has(req.get('Origin'))) return next(new HttpError(403, 'Untrusted origin'));
    }
    next();
  });

  const limit = (req, _res, next) => {
    const now = Date.now();
    for (const [key, record] of attempts) if (record.until <= now) attempts.delete(key);
    const key = req.ip;
    const record = attempts.get(key) || { count: 0, until: now + 10 * 60 * 1000 };
    if (!attempts.has(key) && attempts.size >= 10000) return next(new HttpError(429, 'Too many requests'));
    record.count++;
    attempts.set(key, record);
    next(record.count > 20 ? new HttpError(429, 'Too many authentication attempts; try again later') : undefined);
  };

  async function signIn(res, user) {
    const token = newToken();
    await store.createSession({ userId: user._id, tokenHash: digestToken(token), expiresAt: new Date(Date.now() + sessionLifetime) });
    res.cookie('agile_session', token, { ...cookie, maxAge: sessionLifetime });
  }

  const authenticated = async (req, _res, next) => {
    const token = cookieToken(req);
    const session = token && await store.findSession(digestToken(token));
    if (!session || new Date(session.expiresAt).getTime() <= Date.now()) fail(401, 'Authentication required');
    const user = await store.findUser(session.userId);
    if (!user) fail(401, 'Authentication required');
    req.user = user;
    next();
  };

  const workspaceAccess = permission => async (req, _res, next) => {
    const workspaceId = identifier(req.params.workspaceId);
    const membership = await store.membership(workspaceId, req.user._id);
    if (!membership) fail(404, 'Workspace not found');
    if (!can(membership.role, permission)) fail(403, 'Permission denied');
    req.membership = membership;
    next();
  };

  router.post('/auth/register', limit, async (req, res) => {
    const body = input(req.body, ['name', 'email', 'password']);
    const data = { name: name(body.name, 100), email: email(body.email) };
    const secret = password(body.password);
    const user = await store.createUser({ ...data, passwordHash: await hashPassword(secret) });
    await signIn(res, user);
    res.status(201).json({ user: publicUser(user) });
  });

  router.post('/auth/login', limit, async (req, res) => {
    const body = input(req.body, ['email', 'password']);
    const address = email(body.email);
    const secret = password(body.password);
    const user = await store.findUserByEmail(address);
    if (!await verifyPassword(secret, user?.passwordHash)) fail(401, 'Invalid email or password');
    // Replace the current session rather than trusting or reusing client-supplied IDs.
    const oldToken = cookieToken(req);
    if (oldToken) await store.deleteSession(digestToken(oldToken));
    await signIn(res, user);
    res.json({ user: publicUser(user) });
  });

  router.post('/auth/logout', async (req, res) => {
    const token = cookieToken(req);
    if (token) await store.deleteSession(digestToken(token));
    res.clearCookie('agile_session', cookie);
    res.status(204).end();
  });
  router.get('/auth/me', authenticated, (req, res) => res.json({ user: publicUser(req.user) }));
  router.get('/workspaces', authenticated, async (req, res) => res.json({ workspaces: await store.listWorkspaces(req.user._id) }));
  router.post('/workspaces', authenticated, async (req, res) => {
    const body = input(req.body, ['name', 'slug']);
    if (typeof body.slug !== 'string' || body.slug.length > 80 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(body.slug)) fail(400, 'Invalid workspace slug');
    const workspace = await store.createWorkspace({ name: name(body.name, 100), slug: body.slug }, req.user._id);
    res.status(201).json({ workspace, role: 'owner' });
  });
  router.get('/workspaces/:workspaceId', authenticated, workspaceAccess('workspace:read'), async (req, res) => {
    const workspace = await store.workspace(req.params.workspaceId);
    if (!workspace) fail(404, 'Workspace not found');
    res.json({ workspace, role: req.membership.role });
  });
  router.post('/workspaces/:workspaceId/members', authenticated, workspaceAccess('members:manage'), async (req, res) => {
    const body = input(req.body, ['email', 'role']);
    if (!['admin', 'member', 'viewer'].includes(body.role)) fail(400, 'Invalid membership role');
    if (req.membership.role === 'admin' && body.role === 'admin') fail(403, 'Only owners can add admins');
    const user = await store.findUserByEmail(email(body.email));
    if (!user) fail(404, 'Registered user not found');
    const membership = await store.addMember({ workspaceId: req.params.workspaceId, userId: user._id, role: body.role });
    res.status(201).json({ membership });
  });
  router.use('/workspaces/:workspaceId/boards', authenticated, workspaceAccess('workspace:read'), createBoardRouter(store));
  return router;
}
