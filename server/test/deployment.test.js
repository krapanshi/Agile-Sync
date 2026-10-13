import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';

async function serverFor(t, options) {
  const server = createApp(options).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}
test('readiness reports dependency health separately from process liveness', async t => {
  const unavailable = await serverFor(t, { ready: async () => false });
  assert.equal((await fetch(`${unavailable}/api/health`)).status, 200);
  assert.equal((await fetch(`${unavailable}/api/ready`)).status, 503);
  const available = await serverFor(t, { ready: async () => true });
  assert.equal((await fetch(`${available}/api/ready`)).status, 200);
});
test('production serves frontend without turning unknown API routes into HTML', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'agile-sync-static-'));
  await writeFile(path.join(directory, 'index.html'), '<!doctype html><title>Agile Sync fixture</title>');
  await writeFile(path.join(directory, '.env'), 'private-fixture');
  t.after(async () => { await unlink(path.join(directory, 'index.html')); await unlink(path.join(directory, '.env')); await rmdir(directory); });
  const url = await serverFor(t, { production: true, staticDirectory: directory });
  const home = await fetch(url); assert.equal(home.status, 200); assert.match(await home.text(), /Agile Sync fixture/);
  const unknown = await fetch(`${url}/api/unknown`); assert.equal(unknown.status, 404); assert.match(unknown.headers.get('content-type'), /json/);
  assert.equal((await fetch(`${url}/.env`)).status, 404);
});
