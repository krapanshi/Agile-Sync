import { performance } from 'node:perf_hooks';

export async function runLoadTest({ baseUrl, cookie, workspaceId, requests = 200, concurrency = 8 }) {
  if (!Number.isInteger(requests) || requests < 1 || requests > 10000 || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) throw new Error('Invalid workload limits');
  if (!/^[a-f0-9]{24}$/i.test(workspaceId)) throw new Error('Invalid test workspace ID');
  const send = async (path, method = 'GET', body) => {
    const response = await fetch(`${baseUrl}/api${path}`, { method, signal: AbortSignal.timeout(10000), headers: {
      Cookie: cookie, 'Content-Type': 'application/json', 'X-Agile-Sync': '1'
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const data = response.status === 204 ? null : await response.json();
    return { status: response.status, data };
  };
  const checked = async (...args) => {
    const result = await send(...args);
    if (result.status >= 400) throw new Error(`Load fixture request failed (${result.status})`);
    return result.data;
  };
  const base = `/workspaces/${workspaceId}/boards`;
  let board, cleanup = 'not created';
  try {
    board = (await checked(base, 'POST', { name: `Load fixture ${Date.now()}` })).board;
    const path = `${base}/${board._id}`, tasks = [];
    for (let index = 0; index < concurrency; index++) tasks.push((await checked(`${path}/tasks`, 'POST', { title: `Fixture task ${index}`, columnId: board.columns[0]._id })).task);
    const samples = [], statuses = {}, failures = [];
    let next = 0, reads = 0, edits = 0, moves = 0;
    const started = performance.now();
    await Promise.all(Array.from({ length: concurrency }, (_, worker) => (async () => {
      while (next < requests) {
        const iteration = next++, start = performance.now();
        try {
          let result;
          if (iteration % 10 < 7) { reads++; result = await send(path); }
          else {
            // Read current versions; concurrent moves may cause expected 409 conflicts.
            const current = (await checked(path)).tasks.find(task => task._id === tasks[worker]._id);
            if (iteration % 10 < 9) { edits++; result = await send(`${path}/tasks/${current._id}`, 'PATCH', { version: current.__v, title: `Edited fixture ${iteration}` }); }
            else { moves++; result = await send(`${path}/tasks/${current._id}/move`, 'POST', { version: current.__v, columnId: board.columns[(iteration + worker) % board.columns.length]._id, beforeTaskId: null }); }
          }
          statuses[result.status] = (statuses[result.status] || 0) + 1;
          if (result.status >= 400 && result.status !== 409) failures.push(`HTTP ${result.status}`);
        } catch (error) { failures.push(error.name); }
        samples.push(performance.now() - start);
      }
    })()));
    const elapsedMs = performance.now() - started, sorted = samples.sort((a, b) => a - b);
    const report = { requests, concurrency, reads, edits, moves, statuses, unexpectedFailures: failures.length,
      elapsedMs, operationsPerSecond: requests / elapsedMs * 1000, p50Ms: sorted[Math.ceil(sorted.length * .5) - 1], p95Ms: sorted[Math.ceil(sorted.length * .95) - 1],
      notes: 'Timing covers workload operations including version-read requests for writes. Fixture setup/cleanup excluded. HTTP 409 conflicts are reported separately from unexpected failures.' };
    // Cleanup uses a fresh board version and only removes this run's own fixture.
    const latest = await checked(path); await checked(path, 'DELETE', { version: latest.board.__v }); cleanup = 'removed';
    return { ...report, fixtureCleanup: cleanup };
  } finally {
    if (board && cleanup !== 'removed') {
      try { const path = `${base}/${board._id}`, latest = await checked(path); await checked(path, 'DELETE', { version: latest.board.__v }); }
      catch { console.error(`Load fixture cleanup failed. Remove test board ${board._id} from the configured test workspace.`); }
    }
  }
}
