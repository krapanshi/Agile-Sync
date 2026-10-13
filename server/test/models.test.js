import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { User, Membership, Board, Task } from '../src/models/index.js';

const id = () => new mongoose.Types.ObjectId();
const task = (overrides = {}) => new Task({
  workspaceId: id(), boardId: id(), columnId: id(), createdBy: id(),
  title: 'Implement login', position: 1000, ...overrides
});
const invalid = (document, field) => assert.rejects(document.validate(), error => Boolean(error.errors?.[field]));

test('tenant-owned documents require workspace IDs', async () => {
  await invalid(new Membership({ userId: id(), role: 'member' }), 'workspaceId');
  await invalid(new Board({ name: 'Sprint', createdBy: id() }), 'workspaceId');
  await invalid(task({ workspaceId: undefined }), 'workspaceId');
});

test('roles reject arbitrary privilege names', async () => {
  await invalid(new Membership({ workspaceId: id(), userId: id(), role: 'superuser' }), 'role');
});

test('boards start with three distinct ordered columns', async () => {
  const board = new Board({ workspaceId: id(), name: 'Sprint', createdBy: id() });
  await board.validate();
  assert.deepEqual(board.columns.map(column => column.name), ['To Do', 'In Progress', 'Done']);
  assert.equal(new Set(board.columns.map(column => String(column._id))).size, 3);
  board.columns[1].position = board.columns[0].position;
  await invalid(board, 'columns');
});

test('boards reject empty columns and duplicate column IDs', async () => {
  const board = new Board({ workspaceId: id(), name: 'Sprint', createdBy: id(), columns: [] });
  await invalid(board, 'columns');
  const columnId = id();
  board.columns = [{ _id: columnId, name: 'A', position: 0 }, { _id: columnId, name: 'B', position: 1000 }];
  await invalid(board, 'columns');
});

test('task ordering rejects negative and fractional positions', async () => {
  await task().validate();
  for (const position of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    await invalid(task({ position }), 'position');
  }
});

test('user email is normalized and password hash excluded from JSON', async () => {
  const user = new User({ name: 'Developer', email: ' Dev@Example.com ', passwordHash: 'test-hash-only' });
  await user.validate();
  assert.equal(user.email, 'dev@example.com');
  assert.equal(user.toJSON().passwordHash, undefined);
});
