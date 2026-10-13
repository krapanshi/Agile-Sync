import express from 'express';
import mongoose from 'mongoose';
import { can } from '../auth/security.js';
import { fail } from '../http/errors.js';
import { boardActions } from './service.js';

const id = value => {
  if (typeof value !== 'string' || !/^[a-f0-9]{24}$/i.test(value)) fail(400, 'Invalid resource ID');
  return value.toLowerCase();
};
const text = (value, maximum) => {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maximum) fail(400, 'Invalid text value');
  return value.trim();
};
const input = (body, fields) => {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !fields.includes(key))) fail(400, 'Invalid request fields');
  return body;
};
const version = value => {
  if (!Number.isSafeInteger(value) || value < 0) fail(400, 'A nonnegative integer version is required');
  return value;
};
function taskData(body, create) {
  const data = {};
  if (create || Object.hasOwn(body, 'title')) data.title = text(body.title, 200);
  if (create) data.columnId = id(body.columnId);
  if (Object.hasOwn(body, 'description')) {
    if (typeof body.description !== 'string' || body.description.length > 10000) fail(400, 'Invalid description');
    data.description = body.description;
  }
  if (Object.hasOwn(body, 'priority')) {
    if (!['low', 'medium', 'high'].includes(body.priority)) fail(400, 'Invalid priority');
    data.priority = body.priority;
  }
  if (Object.hasOwn(body, 'assigneeId')) data.assigneeId = body.assigneeId === null ? null : id(body.assigneeId);
  if (Object.hasOwn(body, 'dueAt')) {
    if (body.dueAt !== null) {
      if (typeof body.dueAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(body.dueAt) || Number.isNaN(Date.parse(body.dueAt))) fail(400, 'dueAt must be a UTC ISO timestamp or null');
      const canonical = body.dueAt.includes('.') ? body.dueAt : body.dueAt.replace('Z', '.000Z');
      if (new Date(body.dueAt).toISOString() !== canonical) fail(400, 'Invalid calendar date');
    }
    data.dueAt = body.dueAt === null ? null : new Date(body.dueAt);
  }
  if (!create && !Object.keys(data).length) fail(400, 'Supply at least one task change');
  return data;
}

export function createBoardRouter(store) {
  const router = express.Router({ mergeParams: true });
  router.use((req, _res, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const permission = req.path.includes('/tasks') ? 'tasks:write' : 'boards:write';
      if (!can(req.membership.role, permission)) fail(403, 'Permission denied');
    }
    next();
  });
  const mutate = (req, expectedVersion, work) => store.withBoard(req.params.workspaceId, id(req.params.boardId), expectedVersion, work,
    { deleted: req.method === 'DELETE' && /^\/[a-f0-9]{24}$/i.test(req.path) });
  router.get('/', async (req, res) => {
    if (Object.keys(req.query).some(key => !['limit', 'offset'].includes(key))) fail(400, 'Invalid query parameters');
    const limit = Number(req.query.limit ?? 50), offset = Number(req.query.offset ?? 0);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0 || offset > 10000) fail(400, 'Invalid pagination');
    res.json({ boards: await store.listBoards(req.params.workspaceId, limit, offset), limit, offset });
  });
  router.post('/', async (req, res) => {
    const body = input(req.body, ['name']);
    res.status(201).json({ board: await store.createBoard(req.params.workspaceId, req.user._id, text(body.name, 120)) });
  });
  router.get('/:boardId', async (req, res) => res.json(await store.snapshot(req.params.workspaceId, id(req.params.boardId))));
  router.patch('/:boardId', async (req, res) => {
    const body = input(req.body, ['name', 'version']);
    const name = text(body.name, 120);
    res.json(await mutate(req, version(body.version), context => boardActions.rename(context, name)));
  });
  router.delete('/:boardId', async (req, res) => {
    const body = input(req.body, ['version']);
    await mutate(req, version(body.version), boardActions.deleteBoard);
    res.status(204).end();
  });
  router.post('/:boardId/columns', async (req, res) => {
    const body = input(req.body, ['name', 'version']);
    const name = text(body.name, 100), columnId = new mongoose.Types.ObjectId();
    res.status(201).json(await mutate(req, version(body.version), context => boardActions.addColumn(context, name, columnId)));
  });
  router.put('/:boardId/columns', async (req, res) => {
    const body = input(req.body, ['columns', 'version']);
    if (!Array.isArray(body.columns) || body.columns.length < 1 || body.columns.length > 30) fail(400, 'Invalid columns');
    const columns = body.columns.map(item => { input(item, ['_id', 'name']); return { _id: id(item._id), name: text(item.name, 100) }; });
    res.json(await mutate(req, version(body.version), context => boardActions.reorderColumns(context, columns)));
  });
  router.delete('/:boardId/columns/:columnId', async (req, res) => {
    const body = input(req.body, ['version']), columnId = id(req.params.columnId);
    res.json(await mutate(req, version(body.version), context => boardActions.deleteColumn(context, columnId)));
  });
  router.post('/:boardId/tasks', async (req, res) => {
    const body = input(req.body, ['title', 'columnId', 'description', 'priority', 'assigneeId', 'dueAt']);
    const data = taskData(body, true);
    res.status(201).json(await mutate(req, undefined, context => boardActions.createTask(context, data, req.user._id)));
  });
  router.patch('/:boardId/tasks/:taskId', async (req, res) => {
    const body = input(req.body, ['title', 'description', 'priority', 'assigneeId', 'dueAt', 'version']);
    const data = taskData(body, false), taskId = id(req.params.taskId), expected = version(body.version);
    res.json(await mutate(req, undefined, context => boardActions.updateTask(context, taskId, expected, data)));
  });
  router.post('/:boardId/tasks/:taskId/move', async (req, res) => {
    const body = input(req.body, ['columnId', 'beforeTaskId', 'version']);
    const columnId = id(body.columnId), anchor = body.beforeTaskId === null ? null : id(body.beforeTaskId);
    const taskId = id(req.params.taskId), expected = version(body.version);
    res.json(await mutate(req, undefined, context => boardActions.moveTask(context, taskId, expected, columnId, anchor)));
  });
  router.delete('/:boardId/tasks/:taskId', async (req, res) => {
    const body = input(req.body, ['version']), taskId = id(req.params.taskId), expected = version(body.version);
    await mutate(req, undefined, context => boardActions.deleteTask(context, taskId, expected));
    res.status(204).end();
  });
  return router;
}
