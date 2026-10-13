import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { runLoadTest } from '../src/load-runner.js';

try {
  const { LOAD_TEST_URL, LOAD_TEST_EMAIL, LOAD_TEST_PASSWORD, LOAD_TEST_WORKSPACE_ID } = process.env;
  if (!LOAD_TEST_URL || !LOAD_TEST_EMAIL || !LOAD_TEST_PASSWORD || !LOAD_TEST_WORKSPACE_ID) throw new Error('Set all LOAD_TEST_* fields in server/.env for a dedicated test account/workspace');
  const url = new URL(LOAD_TEST_URL);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('LOAD_TEST_URL must be an HTTP(S) origin');
  const response = await fetch(`${url.origin}/api/auth/login`, { method: 'POST', signal: AbortSignal.timeout(10000),
    headers: { 'Content-Type': 'application/json', 'X-Agile-Sync': '1' }, body: JSON.stringify({ email: LOAD_TEST_EMAIL, password: LOAD_TEST_PASSWORD }) });
  if (!response.ok) throw new Error(`Test account login failed (${response.status})`);
  const cookie = response.headers.getSetCookie().find(value => value.startsWith('agile_session='))?.split(';')[0];
  if (!cookie) throw new Error('Test account session cookie missing');
  try {
    const report = await runLoadTest({ baseUrl: url.origin, cookie, workspaceId: LOAD_TEST_WORKSPACE_ID,
      requests: Number(process.env.LOAD_TEST_REQUESTS || 200), concurrency: Number(process.env.LOAD_TEST_CONCURRENCY || 8) });
    const directory = fileURLToPath(new URL('../../benchmarks/', import.meta.url)); await mkdir(directory, { recursive: true });
    await writeFile(`${directory}/load-live.json`, JSON.stringify({ mode: 'LIVE_HTTP', ...report }, null, 2)); console.log(JSON.stringify(report, null, 2));
    if (report.unexpectedFailures) process.exitCode = 1;
  } finally { await fetch(`${url.origin}/api/auth/logout`, { method: 'POST', signal: AbortSignal.timeout(10000), headers: { Cookie: cookie, 'X-Agile-Sync': '1' } }); }
} catch (error) { console.error(error.message.startsWith('Set all') ? error.message : 'Load test failed. Check test configuration, API availability, account permissions, and fixture cleanup.'); process.exitCode = 1; }

