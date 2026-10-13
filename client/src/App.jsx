import React, { useEffect, useMemo, useState } from 'react';
import { useApp } from './context.jsx';
import { AuthScreen, Messages, NameDialog, TaskDialog, ConfirmDialog, TaskCard } from './components.jsx';

export default function App() {
  const app = useApp(), [modal, setModal] = useState(null), [query, setQuery] = useState(''), [priority, setPriority] = useState('all'), [dragging, setDragging] = useState('');
  useEffect(() => { setModal(null); setQuery(''); setPriority('all'); setDragging(''); }, [app.workspaceId, app.boardId, app.user]);
  const tasks = app.snapshot?.tasks || [], columns = [...(app.snapshot?.board.columns || [])].sort((a, b) => a.position - b.position);
  const visible = useMemo(() => tasks.filter(task => (priority === 'all' || task.priority === priority) && `${task.title} ${task.description}`.toLowerCase().includes(query.toLowerCase())).sort((a, b) => a.position - b.position || a._id.localeCompare(b._id)), [tasks, priority, query]);
  const close = () => setModal(null);
  function drop(event, columnId, beforeTaskId = null) {
    const taskId = event.dataTransfer.getData('text/plain'); setDragging('');
    const task = tasks.find(task => task._id === taskId);
    if (task && taskId !== beforeTaskId && app.writable && !app.busy) app.moveTask(task, columnId, beforeTaskId);
  }
  if (app.checking) return <main className="connecting"><span className="brand-icon">A</span><h1>Agile Sync</h1><p role="status">Checking your session…</p><button onClick={app.demo}>Explore demo instead</button></main>;
  if (!app.user) return <AuthScreen />;
  return <div className="app-shell">
    <aside className="sidebar"><a className="brand" href="#"><span className="brand-icon">A</span>Agile Sync</a>
      <label className="workspace-select">WORKSPACE<select value={app.workspaceId} disabled={app.busy || !app.workspaces.length} onChange={event => app.chooseWorkspace(event.target.value)}>{!app.workspaces.length && <option value="">No workspaces yet</option>}{app.workspaces.map(item => <option value={item.workspace._id} key={item.workspace._id}>{item.workspace.name}</option>)}</select></label>
      <button className="sidebar-button" disabled={app.busy} onClick={() => setModal({ kind: 'workspace' })}>＋ New workspace</button>
      <div className="nav-heading"><span>YOUR BOARDS</span>{app.writable && <button disabled={app.busy} aria-label="Create board" onClick={() => setModal({ kind: 'board' })}>＋</button>}</div>
      <nav aria-label="Boards">{app.boards.map(board => <button className={`board-link ${app.boardId === board._id ? 'active' : ''}`} disabled={app.busy} key={board._id} onClick={() => app.chooseBoard(board._id)}><span aria-hidden="true">▤</span>{board.name}</button>)}</nav>
      <div className="sidebar-note"><span className="tiny-dot" />{app.mode === 'demo' ? 'Demo · saved in this browser' : app.syncStatus === 'live' ? 'Live synchronization' : app.syncStatus}<p>{app.mode === 'demo' ? 'Demo stays in this browser.' : 'Updates reconnect automatically.'}</p></div>
      <div className="profile"><span className="avatar">{app.user.name.slice(0, 1).toUpperCase()}</span><div><strong>{app.user.name}</strong><small>{app.membership?.role || 'Team account'}</small></div><button disabled={app.busy} onClick={app.signOut} aria-label={app.mode === 'demo' ? 'Exit demo' : 'Sign out'} title={app.mode === 'demo' ? 'Exit demo' : 'Sign out'}>↪</button></div>
    </aside>
    <main className="workspace-main"><header className="topbar"><span>{app.membership?.workspace.name || 'Your workspace'} <span className="muted"> / Boards</span></span><span className={`mode-badge ${app.mode}`}>{app.mode === 'demo' ? 'DEMO MODE · NO SERVER' : 'AUTHENTICATED'}</span></header>
      <div className="workspace-content"><Messages />{app.snapshot ? <>
        <section className="board-heading"><div><p className="eyebrow">A SHARED VIEW OF WHAT’S NEXT</p><h1>{app.snapshot.board.name}</h1><p className="muted">Small steps. Clear priorities. Keep work moving.</p></div><div className="heading-actions"><button disabled={app.busy || app.loading} onClick={app.refresh}>↻ Refresh</button>{app.writable && <><button disabled={app.busy} onClick={() => setModal({ kind: 'rename', initial: app.snapshot.board.name })}>Rename</button><button className="primary" disabled={app.busy} onClick={() => setModal({ kind: 'task', columnId: columns[0]._id })}>＋ Add task</button></>}</div></section>
        <section className="board-summary" aria-label="Board summary"><div><strong>{tasks.length}</strong><span>Total tasks</span></div><div><strong>{tasks.filter(task => task.priority === 'high').length}</strong><span>High priority</span></div><div><strong>{columns.length}</strong><span>Columns</span></div><div><strong className="role-label">{app.membership?.role}</strong><span>Your workspace role</span></div></section>
        <div className="board-toolbar"><div className="view-label">▤ Board view</div><div className="filters"><label className="sr-only" htmlFor="task-search">Search tasks</label><input id="task-search" type="search" placeholder="Search tasks…" value={query} onChange={event => setQuery(event.target.value)} /><label className="sr-only" htmlFor="priority-filter">Filter priority</label><select id="priority-filter" value={priority} onChange={event => setPriority(event.target.value)}><option value="all">All priorities</option><option value="high">High priority</option><option value="medium">Medium priority</option><option value="low">Low priority</option></select>{app.writable && <button disabled={app.busy} onClick={() => setModal({ kind: 'column' })}>＋ Column</button>}</div></div>
        <p className="board-instruction" role="status">{app.busy ? 'Saving changes…' : app.writable ? 'Drag cards to move them, or use Move & actions on each card.' : 'You have view-only access to this workspace.'}{visible.length !== tasks.length && ` Showing ${visible.length} of ${tasks.length} tasks.`}</p>
        <div className={`kanban ${dragging ? 'dragging' : ''}`} aria-label="Kanban board">{columns.map((column, index) => {
          const cards = visible.filter(task => task.columnId === column._id), allCards = tasks.filter(task => task.columnId === column._id).sort((a, b) => a.position - b.position || a._id.localeCompare(b._id));
          return <section className="kanban-column" key={column._id} aria-labelledby={`column-${column._id}`} onDragOver={event => { if (app.writable && !app.busy) event.preventDefault(); }} onDrop={event => { event.preventDefault(); drop(event, column._id); }}>
            <header className="column-heading"><h2 id={`column-${column._id}`}><span className={`column-dot color-${index % 4}`} />{column.name}<span className="count">{allCards.length}</span></h2>{app.writable && <button disabled={app.busy} title="Delete empty column" aria-label={`Delete column ${column.name}`} onClick={() => setModal({ kind: 'deleteColumn', column })}>×</button>}</header>
            {cards.map(task => <TaskCard key={task._id} task={task} columns={columns} columnTasks={allCards} setDragging={setDragging} drop={drop} edit={() => setModal({ kind: 'task', task })} remove={() => setModal({ kind: 'deleteTask', task })} />)}
            {!cards.length && <div className="column-empty">{allCards.length ? 'No matching tasks' : 'A little room for your next idea.'}</div>}{app.writable && <button className="add-card" disabled={app.busy} onClick={() => setModal({ kind: 'task', columnId: column._id })}>＋ Add task</button>}
          </section>;
        })}</div>
      </> : <section className="empty-workspace"><span className="empty-icon">▤</span><h1>{app.loading ? 'Loading your boards…' : app.workspaceId ? 'A clean slate for your team' : 'Give your team a home'}</h1><p className="muted">{app.loading ? 'Getting the latest workspace data.' : app.workspaceId ? 'Create your first board and turn ideas into tasks.' : 'Create a workspace to organize your boards and tasks.'}</p>{!app.loading && (!app.workspaceId || app.writable) && <button className="primary" disabled={app.busy} onClick={() => setModal({ kind: app.workspaceId ? 'board' : 'workspace' })}>＋ {app.workspaceId ? 'Create board' : 'Create workspace'}</button>}</section>}</div>
    </main>
    {modal && ['workspace', 'board', 'rename', 'column'].includes(modal.kind) && <NameDialog {...modal} close={close} />}
    {modal?.kind === 'task' && <TaskDialog {...modal} close={close} />}
    {modal?.kind === 'deleteTask' && <ConfirmDialog title="Delete task?" message={`“${modal.task.title}” will be permanently removed.`} action={() => app.deleteTask(modal.task)} close={close} />}
    {modal?.kind === 'deleteColumn' && <ConfirmDialog title="Delete column?" message={`“${modal.column.name}” can only be deleted when it is empty.`} action={() => app.deleteColumn(modal.column._id)} close={close} />}
  </div>;
}

