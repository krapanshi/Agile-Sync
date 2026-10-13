import { fail } from '../http/errors.js';

export const MAX_TASKS = 1000;
const same = (a, b) => String(a) === String(b);
export const ordered = tasks => [...tasks].sort((a, b) => a.position - b.position || String(a._id).localeCompare(String(b._id)));
function column(board, columnId) {
  if (!board.columns.some(item => same(item._id, columnId))) fail(400, 'Column does not belong to this board');
}
async function assignee(context, userId) {
  if (userId && !await context.membership(userId)) fail(400, 'Assignee must be a workspace member');
}
async function currentTask(context, taskId, version) {
  const task = await context.task(taskId);
  if (!task) fail(404, 'Task not found');
  if (task.__v !== version) fail(409, 'Task changed; reload and retry');
  return task;
}

export const boardActions = {
  rename: (context, name) => { context.board.name = name; return { board: context.board }; },
  addColumn: (context, name, id) => {
    if (context.board.columns.length >= 30) fail(400, 'Board cannot exceed 30 columns');
    const maximum = Math.max(...context.board.columns.map(item => item.position));
    context.board.columns.push({ _id: id, name, position: maximum + 1000 });
    return { board: context.board };
  },
  reorderColumns: (context, columns) => {
    const existing = new Set(context.board.columns.map(item => String(item._id)));
    if (columns.length !== existing.size || new Set(columns.map(item => item._id)).size !== existing.size
      || columns.some(item => !existing.has(item._id))) fail(400, 'Supply every existing column exactly once');
    context.board.columns = columns.map((item, index) => ({ _id: item._id, name: item.name, position: index * 1000 }));
    return { board: context.board };
  },
  deleteColumn: async (context, columnId) => {
    column(context.board, columnId);
    if (context.board.columns.length === 1) fail(400, 'A board must keep at least one column');
    if ((await context.tasks(columnId)).length) fail(409, 'Move or delete tasks before deleting this column');
    context.board.columns = context.board.columns.filter(item => !same(item._id, columnId));
    return { board: context.board };
  },
  deleteBoard: async context => { await context.deleteBoard(); return null; },
  createTask: async (context, data, userId) => {
    column(context.board, data.columnId);
    await assignee(context, data.assigneeId);
    const tasks = await context.tasks();
    if (tasks.length >= MAX_TASKS) fail(409, 'Board task limit reached');
    const destination = tasks.filter(item => same(item.columnId, data.columnId));
    const maximum = destination.length ? Math.max(...destination.map(item => item.position)) : -1000;
    return { task: await context.createTask({ ...data, createdBy: userId, position: maximum + 1000 }), boardVersion: context.board.__v };
  },
  updateTask: async (context, taskId, version, data) => {
    await currentTask(context, taskId, version);
    if (Object.hasOwn(data, 'assigneeId')) await assignee(context, data.assigneeId);
    return { task: await context.updateTask(taskId, version, data), boardVersion: context.board.__v };
  },
  deleteTask: async (context, taskId, version) => {
    await currentTask(context, taskId, version);
    await context.deleteTask(taskId, version);
    return null;
  },
  moveTask: async (context, taskId, version, columnId, beforeTaskId) => {
    const moving = await currentTask(context, taskId, version);
    column(context.board, columnId);
    if (same(taskId, beforeTaskId)) fail(400, 'A task cannot be placed before itself');
    const destination = ordered((await context.tasks(columnId)).filter(item => !same(item._id, taskId)));
    const insertion = beforeTaskId === null ? destination.length : destination.findIndex(item => same(item._id, beforeTaskId));
    if (insertion < 0) fail(400, 'Anchor task does not belong to the destination column');
    destination.splice(insertion, 0, moving);
    const changed = [];
    let movedTask;
    // Rebalance integer positions in one transaction; update every changed card's version.
    for (let index = 0; index < destination.length; index++) {
      const task = destination[index];
      if (same(task._id, taskId) || task.position !== index * 1000) {
        const updated = await context.updateTask(task._id, task.__v, { columnId, position: index * 1000 });
        changed.push(updated);
        if (same(task._id, taskId)) movedTask = updated;
      }
    }
    return { task: movedTask, changedTasks: changed, boardVersion: context.board.__v };
  }
};
