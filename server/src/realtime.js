import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { createApp } from './app.js';
import { mongoStore } from './auth/store.js';
import { mongoBoardStore } from './boards/store.js';
import { cookieToken, digestToken } from './auth/security.js';

const validId = value => typeof value === 'string' && /^[a-f0-9]{24}$/i.test(value);
const workspaceRoom = id => `workspace:${id}`;
const boardRoom = (workspaceId, boardId) => `board:${workspaceId}:${boardId}`;

export function createRuntime({ store = { ...mongoStore, ...mongoBoardStore }, production = process.env.NODE_ENV === 'production', appOrigin = process.env.APP_ORIGIN || 'http://localhost:5173', ...appOptions } = {}) {
  let io;
  let delivery = Promise.resolve();
  const origins = new Set([appOrigin]);
  if (!production && ['http://localhost:5173', 'http://127.0.0.1:5173'].includes(appOrigin)) {
    origins.add('http://localhost:5173'); origins.add('http://127.0.0.1:5173');
  }
  async function authenticate(hash) {
    const session = await store.findSession(hash);
    if (!session || new Date(session.expiresAt).getTime() <= Date.now()) throw new Error('Authentication required');
    const user = await store.findUser(session.userId);
    if (!user) throw new Error('Authentication required');
    return { session, user };
  }
  function revoke(socket) { socket.emit('session:revoked'); socket.disconnect(true); }
  async function authorized(socket, workspaceId) {
    const { user } = await authenticate(socket.data.tokenHash);
    return Boolean(await store.membership(workspaceId, user._id));
  }
  function deliver(event) {
    // Queue commit-complete invalidations; never broadcast inside transaction retries.
    delivery = delivery.catch(() => {}).then(async () => {
      const sockets = [...io.sockets.sockets.values()].filter(socket => socket.data.subscription?.workspaceId === event.workspaceId);
      await Promise.allSettled(sockets.map(async socket => {
        try {
          if (!await authorized(socket, event.workspaceId)) { revoke(socket); return; }
          if (!socket.connected) return;
          socket.emit('workspace:changed', event);
          if (socket.data.subscription?.boardId === event.boardId) socket.emit('board:changed', event);
        } catch { revoke(socket); }
      }));
    });
    // The HTTP mutation already committed. Delivery failure must not report a failed write.
    return delivery.catch(() => {});
  }
  async function publish(event) {
    await deliver(event);
  }
  const decorated = {
    ...store,
    createBoard: async (...args) => {
      const board = await store.createBoard(...args);
      await publish({ workspaceId: String(args[0]), boardId: String(board._id), type: 'created' });
      return board;
    },
    withBoard: async (workspaceId, boardId, version, work, event = {}) => {
      const result = await store.withBoard(workspaceId, boardId, version, work);
      await publish({ workspaceId: String(workspaceId), boardId: String(boardId), type: event.deleted ? 'deleted' : 'updated' });
      return result;
    },
    deleteSession: async hash => {
      const result = await store.deleteSession(hash);
      for (const socket of io.sockets.sockets.values()) if (socket.data.tokenHash === hash) revoke(socket);
      return result;
    }
  };
  const app = createApp({ ...appOptions, store: decorated, production, appOrigin });
  const server = createServer(app);
  io = new Server(server, {
    path: '/socket.io', maxHttpBufferSize: 4096,
    allowRequest: (request, done) => done(null, !request.headers.origin || origins.has(request.headers.origin)),
    cors: { origin: [...origins], credentials: true }
  });
  io.use(async (socket, next) => {
    try {
      const token = cookieToken(socket.request);
      if (!token) throw new Error();
      const hash = digestToken(token);
      const { session, user } = await authenticate(hash);
      socket.data.tokenHash = hash;
      socket.data.userId = String(user._id);
      socket.data.expiresAt = new Date(session.expiresAt).getTime();
      next();
    } catch { next(new Error('Authentication required')); }
  });
  io.on('connection', socket => {
    let subscribing = false, attempts = 0, windowStart = Date.now();
    const expiry = setTimeout(() => revoke(socket), Math.max(1, Math.min(2147483647, socket.data.expiresAt - Date.now())));
    expiry.unref();
    socket.on('board:subscribe', async (payload, acknowledge) => {
      const reply = typeof acknowledge === 'function' ? acknowledge : () => {};
      if (Date.now() - windowStart > 60000) { attempts = 0; windowStart = Date.now(); }
      if (++attempts > 30 || subscribing) { reply({ ok: false, error: 'Subscription rate limit' }); return; }
      if (!payload || Object.keys(payload).some(key => !['workspaceId', 'boardId'].includes(key)) || !validId(payload.workspaceId)
        || (payload.boardId !== null && !validId(payload.boardId))) { reply({ ok: false, error: 'Invalid subscription' }); return; }
      subscribing = true;
      try {
        const workspaceId = payload.workspaceId.toLowerCase(), boardId = payload.boardId?.toLowerCase() || null;
        if (!await authorized(socket, workspaceId) || !await store.workspace(workspaceId)) throw new Error('Workspace not found');
        if (boardId && !await store.boardExists(workspaceId, boardId)) throw new Error('Board not found');
        if (!socket.connected) return;
        for (const room of [...socket.rooms]) if (room !== socket.id) await socket.leave(room);
        await socket.join(workspaceRoom(workspaceId));
        if (boardId) await socket.join(boardRoom(workspaceId, boardId));
        socket.data.subscription = { workspaceId, boardId };
        reply({ ok: true });
      } catch { reply({ ok: false, error: 'Subscription denied' }); }
      finally { subscribing = false; }
    });
    socket.on('disconnect', () => clearTimeout(expiry));
  });
  // Revalidate idle subscribers too, including sessions revoked by another process.
  const recheck = setInterval(() => {
    for (const socket of io.sockets.sockets.values()) {
      const workspaceId = socket.data.subscription?.workspaceId;
      (workspaceId ? authorized(socket, workspaceId) : authenticate(socket.data.tokenHash).then(() => true))
        .then(ok => { if (!ok) revoke(socket); }).catch(() => revoke(socket));
    }
  }, 30000);
  recheck.unref();
  io.on('close', () => clearInterval(recheck));
  return { app, server, io, close: async () => { clearInterval(recheck); await new Promise(resolve => io.close(resolve)); } };
}
