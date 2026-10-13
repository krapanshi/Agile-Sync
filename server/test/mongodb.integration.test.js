import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { randomBytes } from 'node:crypto';
import { mongoStore } from '../src/auth/store.js';
import { User, Workspace, Membership, Session, Task, Board, models } from '../src/models/index.js';
import { mongoBoardStore } from '../src/boards/store.js';
import { boardActions } from '../src/boards/service.js';
import { digestToken, newToken } from '../src/auth/security.js';

test('Atlas: persistence, rollback, tenant scope, task moves, and concurrent version conflicts', {
  skip: !process.env.MONGODB_TEST_URI,
  timeout: 60000
}, async t => {
  // A separate database is forced even if the supplied URI points at application data.
  await mongoose.connect(process.env.MONGODB_TEST_URI, {
    dbName: 'agile_sync_test', autoIndex: false, serverSelectionTimeoutMS: 5000
  });
  let user, workspace;
  t.after(async () => {
    try {
      if (workspace) {
        await Task.deleteMany({ workspaceId: workspace._id });
        await Board.deleteMany({ workspaceId: workspace._id });
        await Membership.deleteMany({ workspaceId: workspace._id });
        await Workspace.deleteOne({ _id: workspace._id });
      }
      if (user) {
        await Session.deleteMany({ userId: user._id });
        await User.deleteOne({ _id: user._id });
      }
    } finally { await mongoose.disconnect(); }
  });
  for (const model of models) await model.createIndexes();
  const suffix = randomBytes(12).toString('hex');
  user = await mongoStore.createUser({ name: 'Integration fixture', email: `${suffix}@example.com`, passwordHash: 'fixture-only' });
  workspace = await mongoStore.createWorkspace({ name: 'Integration fixture', slug: `test-${suffix}` }, user._id);
  assert.equal((await mongoStore.membership(workspace._id, user._id)).role, 'owner');
  const abortedSlug = `aborted-${suffix}`;
  await assert.rejects(mongoose.connection.transaction(async session => {
    const [aborted] = await Workspace.create([{ name: 'Rollback fixture', slug: abortedSlug, createdBy: user._id }], { session });
    await Membership.create([{ workspaceId: aborted._id, userId: user._id, role: 'invalid-role' }], { session });
  }));
  assert.equal(await Workspace.findOne({ slug: abortedSlug }), null);
  assert.equal(await mongoStore.membership(new mongoose.Types.ObjectId(), user._id), null);
  await assert.rejects(mongoStore.addMember({ workspaceId: workspace._id, userId: user._id, role: 'viewer' }), error => error.code === 11000);
  const tokenHash = digestToken(newToken());
  await mongoStore.createSession({ userId: user._id, tokenHash, expiresAt: new Date(Date.now() + 60000) });
  assert.ok(await mongoStore.findSession(tokenHash));
  await mongoStore.deleteSession(tokenHash);
  assert.equal(await mongoStore.findSession(tokenHash), null);
  await mongoStore.createSession({ userId: user._id, tokenHash, expiresAt: new Date(0) });
  assert.equal(await mongoStore.findSession(tokenHash), null);
  const board = await mongoBoardStore.createBoard(workspace._id, user._id, 'Integration board');
  const create = title => mongoBoardStore.withBoard(workspace._id, board._id, undefined,
    context => boardActions.createTask(context, { title, columnId: board.columns[0]._id }, user._id));
  const a = (await create('A')).task, b = (await create('B')).task;
  const moved = await mongoBoardStore.withBoard(workspace._id, board._id, undefined,
    context => boardActions.moveTask(context, b._id, 0, board.columns[0]._id, a._id));
  assert.equal(moved.task.position, 0);
  const snapshot = await mongoBoardStore.snapshot(workspace._id, board._id);
  assert.deepEqual(snapshot.tasks.map(task => task.title), ['B', 'A']);
  const before = snapshot.board.__v;
  await assert.rejects(mongoBoardStore.withBoard(workspace._id, board._id, undefined,
    context => boardActions.updateTask(context, b._id, 0, { title: 'Stale' })), error => error.status === 409);
  assert.equal((await mongoBoardStore.snapshot(workspace._id, board._id)).board.__v, before);
  const current = moved.task.__v;
  // Independent transactions may race; no parallel operations occur inside either transaction.
  const raced = await Promise.allSettled(['First', 'Second'].map(title => mongoBoardStore.withBoard(workspace._id, board._id, undefined,
    context => boardActions.updateTask(context, b._id, current, { title }))));
  assert.equal(raced.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(raced.find(result => result.status === 'rejected').reason.status, 409);
  const latest = await mongoBoardStore.snapshot(workspace._id, board._id);
  await mongoBoardStore.withBoard(workspace._id, board._id, latest.board.__v, boardActions.deleteBoard);
  assert.equal(await Task.countDocuments({ workspaceId: workspace._id, boardId: board._id }), 0);
});
