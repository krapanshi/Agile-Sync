import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { createHttpClient } from './api.js';
import { createDemoClient } from './demo.js';
import { newestSnapshot, subscribeBoard } from './realtime.js';

const Context = createContext(null);
const storage = () => { try { return window.localStorage; } catch { return undefined; } };
export function AppProvider({ children }) {
  const [mode, setMode] = useState('live'), [user, setUser] = useState(null), [checking, setChecking] = useState(true);
  const [workspaces, setWorkspaces] = useState([]), [workspaceId, setWorkspaceId] = useState('');
  const [boards, setBoards] = useState([]), [boardId, setBoardId] = useState(''), [snapshot, setSnapshot] = useState(null);
  const [loading, setLoading] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const gate = useRef(false), revision = useRef(0);
  const [syncStatus, setSyncStatus] = useState('offline');
  const applySnapshot = data => setSnapshot(previous => newestSnapshot(previous, data));
  const api = useMemo(() => mode === 'demo' ? createDemoClient(storage()) : createHttpClient(), [mode]);
  const report = error => { if (error.name === 'AbortError') return; setError(error.message); if (error.status === 401) setUser(null); };
  useEffect(() => {
    let active = true;
    setChecking(true); setUser(null); setWorkspaces([]); setWorkspaceId(''); setBoards([]); setBoardId(''); setSnapshot(null); setError('');
    api('/auth/me').then(data => { if (active) setUser(data.user); }).catch(error => { if (active && error.status !== 401) setError(error.message); }).finally(() => { if (active) setChecking(false); });
    return () => { active = false; revision.current++; };
  }, [api]);
  useEffect(() => {
    if (!user) return;
    let active = true;
    api('/workspaces').then(data => { if (active) { setWorkspaces(data.workspaces); setWorkspaceId(previous => data.workspaces.some(item => item.workspace._id === previous) ? previous : data.workspaces[0]?.workspace._id || ''); } }).catch(error => { if (active) report(error); });
    return () => { active = false; };
  }, [api, user]);
  useEffect(() => {
    revision.current++; setBoards([]); setBoardId(''); setSnapshot(null);
    if (!workspaceId || !user) { setLoading(false); return; }
    let active = true; setLoading(true);
    api(`/workspaces/${workspaceId}/boards`).then(data => { if (active) { setBoards(data.boards); setBoardId(data.boards[0]?._id || ''); } }).catch(error => { if (active) report(error); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [workspaceId, api, user]);
  useEffect(() => {
    revision.current++; setSnapshot(null);
    if (!boardId || !workspaceId || !user) return;
    let active = true; setLoading(true);
    api(`/workspaces/${workspaceId}/boards/${boardId}`).then(data => { if (active) applySnapshot(data); }).catch(error => { if (active) report(error); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [boardId, workspaceId, api, user]);
  useEffect(() => {
    if (mode !== 'live' || !user || !workspaceId) { setSyncStatus(mode === 'demo' ? 'demo' : 'offline'); return; }
    let active = true, fetching = false, dirty = false;
    async function refreshRemote() {
      dirty = true;
      if (fetching) return;
      fetching = true;
      try {
        while (active && dirty) {
          dirty = false;
          const listed = await api(`/workspaces/${workspaceId}/boards`);
          if (!active) return;
          setBoards(previous => listed.boards.map(board => {
            const existing = previous.find(item => item._id === board._id);
            return existing && existing.__v > board.__v ? existing : board;
          }));
          if (boardId) {
            const data = await api(`/workspaces/${workspaceId}/boards/${boardId}`);
            if (active) applySnapshot(data);
          } else if (listed.boards.length) setBoardId(listed.boards[0]._id);
        }
      } catch (error) {
        if (active) { report(error); if (error.status === 404) { setSnapshot(null); setBoardId(''); } }
      } finally { fetching = false; }
    }
    const stop = subscribeBoard({ workspaceId, boardId, changed: refreshRemote,
      status: value => { if (active) setSyncStatus(value); },
      revoked: () => { if (active) { setUser(null); setSnapshot(null); setWorkspaces([]); setError('Your session expired or was revoked. Please sign in again.'); } }
    });
    return () => { active = false; stop(); };
  }, [mode, user, workspaceId, boardId, api]);
  const membership = workspaces.find(item => item.workspace._id === workspaceId);
  const writable = ['owner', 'admin', 'member'].includes(membership?.role);
  async function run(work, message = '') {
    if (gate.current) return false;
    gate.current = true; setBusy(true); setError(''); setNotice('');
    const current = revision.current;
    try { await work(); if (current === revision.current) setNotice(message); return true; }
    catch (error) {
      if (current === revision.current) {
        report(error);
        if (error.status === 409 && boardId) { try { applySnapshot(await api(`/workspaces/${workspaceId}/boards/${boardId}`)); } catch (refreshError) { report(refreshError); } }
      }
      return false;
    } finally { gate.current = false; setBusy(false); }
  }
  const base = `/workspaces/${workspaceId}/boards/${boardId}`;
  async function mutate(suffix, method, body) {
    const current = revision.current;
    await api(base + suffix, { method, body });
    const data = await api(base);
    if (current === revision.current) { applySnapshot(data); setBoards(previous => previous.map(board => board._id === boardId && board.__v <= data.board.__v ? data.board : board)); }
  }
  const value = {
    mode, user, checking, workspaces, workspaceId, membership, boards, boardId, snapshot, writable, loading, busy, error, notice, syncStatus,
    clearError: () => setError(''),
    chooseWorkspace: value => { if (!gate.current) { revision.current++; setBoards([]); setBoardId(''); setSnapshot(null); setWorkspaceId(value); setError(''); } },
    chooseBoard: value => { if (!gate.current) { revision.current++; setBoardId(value); setError(''); } },
    demo: () => setMode('demo'),
    signOut: () => run(async () => { if (mode === 'demo') setMode('live'); else { await api('/auth/logout', { method: 'POST' }); setUser(null); setWorkspaces([]); setSnapshot(null); } }),
    authenticate: (kind, body) => run(async () => { const data = await api(`/auth/${kind}`, { method: 'POST', body }); setUser(data.user); }),
    createWorkspace: body => run(async () => { const data = await api('/workspaces', { method: 'POST', body }); setWorkspaces(previous => [...previous, data]); setBoardId(''); setSnapshot(null); setWorkspaceId(data.workspace._id); }, 'Workspace created'),
    createBoard: name => run(async () => { const data = await api(`/workspaces/${workspaceId}/boards`, { method: 'POST', body: { name } }); setBoards(previous => [...previous, data.board]); setBoardId(data.board._id); }, 'Board created'),
    renameBoard: name => run(() => mutate('', 'PATCH', { name, version: snapshot.board.__v }), 'Board renamed'),
    addColumn: name => run(() => mutate('/columns', 'POST', { name, version: snapshot.board.__v }), 'Column added'),
    deleteColumn: columnId => run(() => mutate(`/columns/${columnId}`, 'DELETE', { version: snapshot.board.__v }), 'Column deleted'),
    saveTask: (task, data) => run(() => mutate(task ? `/tasks/${task._id}` : '/tasks', task ? 'PATCH' : 'POST', { ...data, ...(task ? { version: task.__v } : {}) }), task ? 'Task updated' : 'Task created'),
    deleteTask: task => run(() => mutate(`/tasks/${task._id}`, 'DELETE', { version: task.__v }), 'Task deleted'),
    moveTask: (task, columnId, beforeTaskId = null) => run(() => mutate(`/tasks/${task._id}/move`, 'POST', { columnId, beforeTaskId, version: task.__v }), 'Task moved'),
    refresh: () => run(async () => { if (boardId) applySnapshot(await api(base)); }, 'Board refreshed')
  };
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export const useApp = () => useContext(Context);

