import { ApiError } from './api.js';

export const DEMO_KEY = 'agile-sync.demo.v1';
const id = () => [...crypto.getRandomValues(new Uint8Array(12))].map(byte => byte.toString(16).padStart(2, '0')).join('');
const copy = value => structuredClone(value);
export function seedDemo() {
  const user = { id: id(), name: 'Demo teammate', email: 'demo@agilesync.local' };
  const workspace = { _id: id(), name: 'Product team', slug: 'product-team' };
  const board = { _id: id(), workspaceId: workspace._id, name: 'Product sprint', createdBy: user.id, __v: 0,
    columns: ['To Do', 'In Progress', 'Done'].map((name, index) => ({ _id: id(), name, position: index * 1000 })) };
  const titles = ['Map the onboarding flow', 'Build workspace permissions', 'Review task move conflicts', 'Polish the empty states', 'Write the API guide', 'Create the project foundation'];
  const tasks = titles.map((title, index) => ({ _id: id(), boardId: board._id, workspaceId: workspace._id,
    columnId: board.columns[Math.floor(index / 2)]._id, title, description: ['Keep the first experience focused and easy to follow.', 'Make each workspace a safe place for its team.'][index % 2],
    priority: ['medium', 'high', 'high', 'low', 'medium', 'low'][index], position: (index % 2) * 1000, createdBy: user.id, dueAt: null, __v: 0 }));
  return { schema: 1, user, workspaces: [workspace], boards: [board], tasks };
}
export function createDemoClient(storage) {
  let state;
  try { state = JSON.parse(storage?.getItem(DEMO_KEY) || 'null'); } catch { state = null; }
  if (!state || state.schema !== 1 || !state.user || !Array.isArray(state.tasks) || !Array.isArray(state.boards) || !Array.isArray(state.workspaces)) state = seedDemo();
  const persist = () => {
    try { storage?.setItem(DEMO_KEY, JSON.stringify(state)); } catch { throw new ApiError(507, 'Demo changes could not be saved. Browser storage may be full or disabled.'); }
  };
  const fail = (status, message) => { throw new ApiError(status, message); };
  const version = (document, value) => { if (document.__v !== value) fail(409, 'This item changed. Refresh and retry.'); };
  return async (path, { method = 'GET', body = {} } = {}) => {
    const original = copy(state);
    try {
      if (path === '/auth/me') return { user: copy(state.user) };
      if (path === '/auth/logout') return null;
      if (path === '/workspaces') {
        if (method === 'GET') return { workspaces: state.workspaces.map(workspace => ({ workspace: copy(workspace), role: 'owner' })) };
        if (state.workspaces.some(workspace => workspace.slug === body.slug)) fail(409, 'Workspace slug already exists');
        const workspace = { _id: id(), ...body }; state.workspaces.push(workspace); persist(); return { workspace: copy(workspace), role: 'owner' };
      }
      const parts = path.split('/').filter(Boolean);
      if (parts[0] !== 'workspaces' || parts[2] !== 'boards' || !state.workspaces.some(workspace => workspace._id === parts[1])) fail(404, 'Workspace not found');
      const workspaceId = parts[1], boardId = parts[3], taskId = parts[5];
      if (!boardId) {
        if (method === 'GET') return { boards: copy(state.boards.filter(board => board.workspaceId === workspaceId)) };
        const board = { _id: id(), workspaceId, name: body.name, createdBy: state.user.id, __v: 0,
          columns: ['To Do', 'In Progress', 'Done'].map((name, index) => ({ _id: id(), name, position: index * 1000 })) };
        state.boards.push(board); persist(); return { board: copy(board) };
      }
      const board = state.boards.find(item => item._id === boardId && item.workspaceId === workspaceId);
      if (!board) fail(404, 'Board not found');
      const boardTasks = () => state.tasks.filter(task => task.boardId === boardId && task.workspaceId === workspaceId);
      if (parts.length === 4 && method === 'GET') return copy({ board, tasks: boardTasks() });
      let result;
      if (parts.length === 4) {
        version(board, body.version);
        if (method === 'DELETE') { state.boards = state.boards.filter(item => item._id !== boardId); state.tasks = state.tasks.filter(item => item.boardId !== boardId); result = null; }
        else { board.name = body.name; result = { board }; }
      } else if (parts[4] === 'columns') {
        version(board, body.version);
        if (method === 'POST') {
          if (board.columns.length >= 30) fail(400, 'Board cannot exceed 30 columns');
          board.columns.push({ _id: id(), name: body.name, position: Math.max(...board.columns.map(column => column.position)) + 1000 });
        } else if (method === 'DELETE') {
          if (!board.columns.some(column => column._id === parts[5])) fail(404, 'Column not found');
          if (board.columns.length === 1) fail(400, 'Keep at least one column');
          if (boardTasks().some(task => task.columnId === parts[5])) fail(409, 'Move or delete tasks before deleting this column');
          board.columns = board.columns.filter(column => column._id !== parts[5]);
        } else fail(400, 'Unsupported demo operation');
        result = { board };
      } else if (parts[4] === 'tasks') {
        if (!taskId) {
          if (!board.columns.some(column => column._id === body.columnId)) fail(400, 'Invalid column');
          if (boardTasks().length >= 1000) fail(409, 'Board task limit reached');
          const destination = boardTasks().filter(task => task.columnId === body.columnId);
          const task = { _id: id(), workspaceId, boardId, description: '', priority: 'medium', dueAt: null, ...body, createdBy: state.user.id,
            position: destination.length ? Math.max(...destination.map(task => task.position)) + 1000 : 0, __v: 0 };
          state.tasks.push(task); result = { task, boardVersion: board.__v + 1 };
        } else {
          const task = boardTasks().find(item => item._id === taskId);
          if (!task) fail(404, 'Task not found');
          version(task, body.version);
          if (method === 'DELETE') { state.tasks = state.tasks.filter(item => item._id !== taskId); result = null; }
          else if (parts[6] === 'move') {
            if (!board.columns.some(column => column._id === body.columnId)) fail(400, 'Invalid column');
            const destination = boardTasks().filter(item => item.columnId === body.columnId && item._id !== taskId).sort((a, b) => a.position - b.position || a._id.localeCompare(b._id));
            const index = body.beforeTaskId === null ? destination.length : destination.findIndex(item => item._id === body.beforeTaskId);
            if (index < 0 || body.beforeTaskId === taskId) fail(400, 'Invalid destination anchor');
            destination.splice(index, 0, task);
            const changedTasks = [];
            destination.forEach((item, index) => {
              if (item._id === taskId || item.position !== index * 1000) { item.columnId = body.columnId; item.position = index * 1000; item.__v++; changedTasks.push(item); }
            });
            result = { task, changedTasks, boardVersion: board.__v + 1 };
          } else { const { version: _version, ...changes } = body; Object.assign(task, changes); task.__v++; result = { task, boardVersion: board.__v + 1 }; }
        }
      } else fail(404, 'Demo route not found');
      board.__v++; persist(); return copy(result);
    } catch (error) { state = original; throw error; }
  };
}
