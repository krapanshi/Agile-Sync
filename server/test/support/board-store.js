import mongoose from 'mongoose';
import { Board, Task } from '../../src/models/index.js';
import { fail } from '../../src/http/errors.js';
import { digestToken } from '../../src/auth/security.js';
const id = () => new mongoose.Types.ObjectId().toString();
const clone = value => structuredClone(value);
export function memoryStore() {
  const userId = id(), workspaceId = id();
  const boards = new Map(), tasks = new Map();
  const members = new Map([[`${workspaceId}:${userId}`, { role: 'owner' }]]);
  const token = 'b'.repeat(64);
  const store = {
    boards, tasks, members, userId, workspaceId, token,
    findSession: async hash => hash === digestToken(token) ? { userId, expiresAt: new Date(Date.now() + 60000) } : null,
    findUser: async value => value === userId ? { _id: userId, name: 'Tester', email: 'tester@example.com' } : null,
    membership: async (workspace, user) => members.get(`${workspace}:${user}`),
    listBoards: async (workspace, limit, offset) => [...boards.values()].filter(board => board.workspaceId === workspace).slice(offset, offset + limit),
    createBoard: async (workspace, user, name) => {
      const model = new Board({ workspaceId: workspace, createdBy: user, name });
      await model.validate();
      const board = JSON.parse(JSON.stringify(model)); board.__v = 0;
      boards.set(board._id, board); return clone(board);
    },
    snapshot: async (workspace, boardId) => {
      const board = boards.get(boardId);
      if (!board || board.workspaceId !== workspace) fail(404, 'Board not found');
      return clone({ board, tasks: [...tasks.values()].filter(task => task.workspaceId === workspace && task.boardId === boardId) });
    },
    withBoard: async (workspace, boardId, version, work) => {
      const stored = boards.get(boardId);
      if (!stored || stored.workspaceId !== workspace) fail(404, 'Board not found');
      if (version !== undefined && stored.__v !== version) fail(409, 'Board changed');
      const board = clone(stored), local = new Map([...tasks].map(([key, value]) => [key, clone(value)]));
      board.__v++;
      const scoped = taskId => {
        const task = local.get(taskId);
        return task?.workspaceId === workspace && task?.boardId === boardId ? task : null;
      };
      let deleted = false;
      const context = {
        board,
        membership: async user => members.get(`${workspace}:${user}`),
        task: async taskId => clone(scoped(taskId)),
        tasks: async columnId => [...local.values()].filter(task => scoped(task._id) && (!columnId || task.columnId === columnId)).map(clone),
        createTask: async data => {
          const model = new Task({ ...data, workspaceId: workspace, boardId });
          await model.validate();
          const task = JSON.parse(JSON.stringify(model)); task.__v = 0;
          local.set(task._id, task); return clone(task);
        },
        updateTask: async (taskId, expected, data) => {
          const task = scoped(String(taskId));
          if (!task || task.__v !== expected) fail(409, 'Task changed');
          Object.assign(task, data); task.__v++;
          await new Task(task).validate();
          return clone(task);
        },
        deleteTask: async (taskId, expected) => {
          if (scoped(taskId)?.__v !== expected) fail(409, 'Task changed');
          local.delete(taskId);
        },
        deleteBoard: async () => { for (const [key] of local) if (scoped(key)) local.delete(key); deleted = true; }
      };
      const result = await work(context);
      if (!deleted) await new Board(board).validate();
      if (deleted) boards.delete(boardId); else boards.set(boardId, board);
      tasks.clear(); for (const [key, value] of local) tasks.set(key, value);
      return result;
    }
  };
  return store;
}

