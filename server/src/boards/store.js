import mongoose from 'mongoose';
import { Board, Task, Membership, Workspace } from '../models/index.js';
import { fail } from '../http/errors.js';

export const mongoBoardStore = {
  boardExists: (workspaceId, boardId) => Board.exists({ workspaceId, _id: boardId }),
  listBoards: (workspaceId, limit, offset) => Board.find({ workspaceId }).sort({ updatedAt: -1, _id: 1 }).skip(offset).limit(limit).lean(),
  createBoard: async (workspaceId, userId, name) => {
    if (!await Workspace.exists({ _id: workspaceId })) fail(404, 'Workspace not found');
    return Board.create({ workspaceId, createdBy: userId, name });
  },
  snapshot: (workspaceId, boardId) => mongoose.connection.transaction(async session => {
    const board = await Board.findOne({ workspaceId, _id: boardId }).session(session).lean();
    if (!board) fail(404, 'Board not found');
    const tasks = await Task.find({ workspaceId, boardId }).sort({ columnId: 1, position: 1, _id: 1 }).session(session).lean();
    return { board, tasks };
  }, { readConcern: { level: 'snapshot' } }),
  withBoard: (workspaceId, boardId, version, work) => mongoose.connection.transaction(async session => {
    const scope = { workspaceId, _id: boardId, ...(version === undefined ? {} : { __v: version }) };
    // Every board/task mutation writes the parent first. This coordinates task moves,
    // column changes, and deletion, rather than relying only on snapshot reads.
    const board = await Board.findOneAndUpdate(scope, { $inc: { __v: 1 } }, { returnDocument: 'after', session }).lean();
    if (!board) {
      if (await Board.exists({ workspaceId, _id: boardId }).session(session)) fail(409, 'Board changed; reload and retry');
      fail(404, 'Board not found');
    }
    const taskScope = { workspaceId, boardId };
    let deleted = false;
    const context = {
      board,
      membership: userId => Membership.exists({ workspaceId, userId }).session(session),
      task: taskId => Task.findOne({ ...taskScope, _id: taskId }).session(session).lean(),
      tasks: columnId => Task.find({ ...taskScope, ...(columnId ? { columnId } : {}) }).session(session).lean(),
      createTask: async data => {
        const [task] = await Task.create([{ ...data, ...taskScope }], { session });
        return task.toObject();
      },
      updateTask: async (taskId, expectedVersion, data) => {
        const task = await Task.findOneAndUpdate({ ...taskScope, _id: taskId, __v: expectedVersion }, {
          $set: data, $inc: { __v: 1 }
        }, { session, returnDocument: 'after', runValidators: true }).lean();
        if (!task) fail(409, 'Task changed; reload and retry');
        return task;
      },
      deleteTask: async (taskId, expectedVersion) => {
        const result = await Task.deleteOne({ ...taskScope, _id: taskId, __v: expectedVersion }).session(session);
        if (!result.deletedCount) fail(409, 'Task changed; reload and retry');
      },
      deleteBoard: async () => {
        await Task.deleteMany(taskScope).session(session);
        await Board.deleteOne({ workspaceId, _id: boardId }).session(session);
        deleted = true;
      }
    };
    const result = await work(context);
    if (!deleted) {
      await new Board(board).validate();
      await Board.updateOne({ workspaceId, _id: boardId, __v: board.__v }, {
        $set: { name: board.name, columns: board.columns }
      }, { session, runValidators: true });
    }
    return result;
  }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } })
};
