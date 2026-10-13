import React, { useEffect, useRef, useState } from 'react';
import { useApp } from './context.jsx';

export function Messages() {
  const { error, notice, clearError } = useApp();
  return <>{error && <div className="message error" role="alert"><span>{error}</span><button onClick={clearError} aria-label="Dismiss error">×</button></div>}{notice && <p className="message success" role="status">{notice}</p>}</>;
}

export function AuthScreen() {
  const app = useApp(), [register, setRegister] = useState(false);
  const [name, setName] = useState(''), [email, setEmail] = useState(''), [password, setPassword] = useState('');
  async function submit(event) {
    event.preventDefault();
    const success = await app.authenticate(register ? 'register' : 'login', { email, password, ...(register ? { name } : {}) });
    if (success) setPassword('');
  }
  return <main className="auth-layout">
    <section className="auth-story"><a className="brand" href="#"><span className="brand-icon">A</span>Agile Sync</a><div><p className="eyebrow">A LITTLE STRUCTURE. A LOT OF MOMENTUM.</p><h1>Make room for<br /><em>great work.</em></h1><p>Bring your team’s tasks together. Keep the next move clear.</p><div className="sample-board" aria-hidden="true"><div><span>TO DO</span><i>Shape the next idea</i><i>Plan the sprint</i></div><div><span>IN PROGRESS</span><i className="sample-active">Build something useful</i></div><div><span>DONE</span><i>Start with a shared goal ✓</i></div></div></div><small>Workspaces · Boards · Tasks</small></section>
    <section className="auth-panel"><div className="auth-card"><p className="eyebrow">YOUR NEXT SPRINT STARTS HERE</p><h2>{register ? 'Create your account' : 'Welcome back'}</h2><p className="muted">{register ? 'One account. A workspace for every team.' : 'Sign in to pick up where you left off.'}</p><Messages />
      <form onSubmit={submit}>{register && <label>Your name<input required maxLength={100} autoComplete="name" value={name} onChange={event => setName(event.target.value)} /></label>}
        <label>Email address<input required type="email" maxLength={254} autoComplete="email" value={email} onChange={event => setEmail(event.target.value)} /></label>
        <label>Password<input required type="password" minLength={12} maxLength={256} autoComplete={register ? 'new-password' : 'current-password'} value={password} onChange={event => setPassword(event.target.value)} /></label>
        <small className="muted">At least 12 characters.</small><button className="primary full" disabled={app.busy || app.checking}>{app.busy ? 'Please wait…' : register ? 'Create account' : 'Sign in'} <span>→</span></button>
      </form>
      <p className="switch-auth">{register ? 'Already have an account?' : 'New to Agile Sync?'} <button className="link" onClick={() => { setRegister(!register); setPassword(''); app.clearError(); }}>{register ? 'Sign in' : 'Create an account'}</button></p>
      <div className="demo-entry"><strong>Atlas setup can wait.</strong><p>Explore the board with sample tasks. Demo changes stay in this browser.</p><button className="secondary full" onClick={app.demo} disabled={app.busy}>Try the interactive demo →</button></div>
    </div></section>
  </main>;
}

export function Modal({ title, children, close }) {
  const ref = useRef(null), { busy } = useApp();
  useEffect(() => { const dialog = ref.current; dialog.showModal(); dialog.querySelector('input, textarea, select')?.focus(); return () => dialog.close(); }, []);
  return <dialog ref={ref} aria-labelledby="dialog-title" onCancel={event => { event.preventDefault(); if (!busy) close(); }}>
    <header className="dialog-header"><h2 id="dialog-title">{title}</h2><button disabled={busy} onClick={close} aria-label="Close dialog">×</button></header>{children}
  </dialog>;
}

export function NameDialog({ kind, initial = '', close }) {
  const app = useApp(), [name, setName] = useState(initial), [slug, setSlug] = useState('');
  const titles = { workspace: 'Create workspace', board: 'Create board', rename: 'Rename board', column: 'Add column' };
  async function submit(event) {
    event.preventDefault();
    const success = await ({ workspace: () => app.createWorkspace({ name: name.trim(), slug }), board: () => app.createBoard(name.trim()), rename: () => app.renameBoard(name.trim()), column: () => app.addColumn(name.trim()) })[kind]();
    if (success) close();
  }
  return <Modal title={titles[kind]} close={close}><form onSubmit={submit}>
    <label>Name<input autoFocus required maxLength={kind === 'board' || kind === 'rename' ? 120 : 100} value={name} onChange={event => { setName(event.target.value); if (kind === 'workspace') setSlug(event.target.value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80)); }} /></label>
    {kind === 'workspace' && <label>Workspace slug<input required maxLength={80} pattern="[a-z0-9]+(-[a-z0-9]+)*" value={slug} onChange={event => setSlug(event.target.value)} /><small>Lowercase words separated by hyphens.</small></label>}
    <Messages /><div className="form-actions"><button type="button" disabled={app.busy} onClick={close}>Cancel</button><button className="primary" disabled={app.busy}>{app.busy ? 'Saving…' : 'Save'}</button></div>
  </form></Modal>;
}

export function TaskDialog({ task, columnId, close }) {
  const app = useApp(), [title, setTitle] = useState(task?.title || ''), [description, setDescription] = useState(task?.description || '');
  const [priority, setPriority] = useState(task?.priority || 'medium'), [due, setDue] = useState(task?.dueAt?.slice(0, 10) || '');
  async function submit(event) {
    event.preventDefault();
    if (!app.writable) return;
    const data = { title: title.trim(), description, priority, dueAt: due ? new Date(`${due}T00:00:00.000Z`).toISOString() : null, ...(!task ? { columnId } : {}) };
    if (await app.saveTask(task, data)) close();
  }
  return <Modal title={!app.writable ? 'Task details' : task ? 'Edit task' : 'Create task'} close={close}><form onSubmit={submit}>
    <label>Task title<input readOnly={!app.writable} autoFocus required maxLength={200} value={title} onChange={event => setTitle(event.target.value)} /></label>
    <label>Description<textarea readOnly={!app.writable} rows={4} maxLength={10000} value={description} onChange={event => setDescription(event.target.value)} /></label>
    <div className="field-row"><label>Priority<select disabled={!app.writable} value={priority} onChange={event => setPriority(event.target.value)}><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select></label><label>Due date<input readOnly={!app.writable} type="date" min="0001-01-01" max="9999-12-31" value={due} onChange={event => setDue(event.target.value)} /></label></div>
    <Messages /><small className="muted">If another client changed this task, close and reopen it to review the latest version.</small>
    <div className="form-actions"><button type="button" disabled={app.busy} onClick={close}>{app.writable ? 'Cancel' : 'Close'}</button>{app.writable && <button className="primary" disabled={app.busy}>{app.busy ? 'Saving…' : 'Save task'}</button>}</div>
  </form></Modal>;
}

export function ConfirmDialog({ title, message, action, close }) {
  const app = useApp();
  return <Modal title={title} close={close}><p>{message}</p><Messages /><div className="form-actions"><button disabled={app.busy} onClick={close}>Cancel</button><button className="danger" disabled={app.busy} onClick={async () => { if (await action()) close(); }}>Delete</button></div></Modal>;
}

export function TaskCard({ task, columns, columnTasks, edit, remove, drop, setDragging }) {
  const app = useApp(), index = columnTasks.findIndex(item => item._id === task._id);
  const [target, setTarget] = useState(task.columnId);
  useEffect(() => setTarget(task.columnId), [task.columnId]);
  return <article className={`task-card priority-${task.priority}`} draggable={app.writable && !app.busy}
    onDragStart={event => { event.dataTransfer.setData('text/plain', task._id); event.dataTransfer.effectAllowed = 'move'; setDragging(task._id); }} onDragEnd={() => setDragging('')}
    onDragOver={event => { if (app.writable && !app.busy) event.preventDefault(); }} onDrop={event => { event.preventDefault(); event.stopPropagation(); drop(event, task.columnId, task._id); }}>
    <div className="task-meta"><span className={`priority-pill ${task.priority}`}>{task.priority} priority</span><span className="grip" aria-hidden="true">⠿</span></div>
    <button className="task-title" onClick={edit}>{task.title}</button>{task.description && <p className="task-description">{task.description}</p>}
    <div className="task-footer"><span>{task.dueAt ? `Due ${new Date(task.dueAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })}` : 'No due date'}</span><span className="avatar" title={task.assigneeId ? 'Assigned task' : 'Unassigned'}>{task.assigneeId ? 'A' : '–'}</span></div>
    {app.writable && <details className="task-controls"><summary>Move & actions</summary><div className="move-row"><label className="sr-only" htmlFor={`move-${task._id}`}>Destination for {task.title}</label><select id={`move-${task._id}`} value={target} onChange={event => setTarget(event.target.value)} disabled={app.busy}>{columns.map(column => <option key={column._id} value={column._id}>{column.name}</option>)}</select><button disabled={app.busy} onClick={() => app.moveTask(task, target)}>Move</button></div><div className="card-actions"><button disabled={app.busy || index === 0} onClick={() => app.moveTask(task, task.columnId, columnTasks[index - 1]._id)}>↑ Earlier</button><button disabled={app.busy || index === columnTasks.length - 1} onClick={() => app.moveTask(task, task.columnId, columnTasks[index + 2]?._id || null)}>↓ Later</button><button className="danger-text" disabled={app.busy} onClick={remove}>Delete</button></div></details>}
  </article>;
}

