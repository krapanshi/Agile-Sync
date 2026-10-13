import test from 'node:test';
import assert from 'node:assert/strict';
import { newestSnapshot, subscribeBoard } from '../src/realtime.js';

test('late snapshots cannot overwrite a newer version of the same board', () => {
  const latest = { board: { _id: 'board', __v: 5 } };
  assert.equal(newestSnapshot(latest, { board: { _id: 'board', __v: 4 } }), latest);
  const other = { board: { _id: 'other', __v: 0 } };
  assert.equal(newestSnapshot(latest, other), other);
});

test('client resubscribes and requests a fresh snapshot on every reconnect; cleanup removes listeners', () => {
  const handlers = new Map(), statuses = [], subscriptions = [];
  let changed = 0, revoked = 0, disconnected = false;
  const fake = {
    on: (name, callback) => handlers.set(name, callback),
    timeout: () => ({ emit: (_name, payload, reply) => { subscriptions.push(payload); reply(null, { ok: true }); } }),
    connect: () => handlers.get('connect')(),
    removeAllListeners: () => handlers.clear(), disconnect: () => { disconnected = true; }
  };
  const stop = subscribeBoard({ workspaceId: 'workspace', boardId: 'board', socketFactory: () => fake,
    changed: () => changed++, revoked: () => revoked++, status: value => statuses.push(value) });
  handlers.get('disconnect')(); handlers.get('connect')();
  assert.equal(subscriptions.length, 2); assert.equal(changed, 2);
  handlers.get('workspace:changed')({ workspaceId: 'other' }); assert.equal(changed, 2);
  handlers.get('workspace:changed')({ workspaceId: 'workspace' }); assert.equal(changed, 3);
  handlers.get('session:revoked')(); assert.equal(revoked, 1);
  assert.ok(statuses.includes('live')); stop(); assert.equal(handlers.size, 0); assert.equal(disconnected, true);
});
