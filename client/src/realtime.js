import { io } from 'socket.io-client';

export function newestSnapshot(previous, incoming) {
  if (previous?.board._id === incoming.board._id && previous.board.__v > incoming.board.__v) return previous;
  return incoming;
}

export function subscribeBoard({ workspaceId, boardId, changed, status, revoked, socketFactory = io }) {
  const socket = socketFactory({ path: '/socket.io', withCredentials: true, autoConnect: false });
  let active = true;
  const subscribe = () => {
    status('synchronizing');
    socket.timeout(5000).emit('board:subscribe', { workspaceId, boardId: boardId || null }, (error, reply) => {
      if (!active) return;
      if (error || !reply?.ok) { status('subscription denied'); return; }
      status('live');
      changed(); // Snapshot/list refresh after every join or reconnect recovers missed events.
    });
  };
  socket.on('connect', subscribe);
  socket.on('workspace:changed', event => { if (active && event.workspaceId === workspaceId) changed(event); });
  socket.on('disconnect', () => { if (active) status('reconnecting'); });
  socket.on('connect_error', error => {
    if (!active) return;
    if (error.message === 'Authentication required') { status('authentication required'); revoked(); }
    else status('reconnecting');
  });
  socket.on('session:revoked', () => { if (active) { status('authentication required'); revoked(); } });
  status('connecting'); socket.connect();
  return () => { active = false; socket.removeAllListeners(); socket.disconnect(); };
}
