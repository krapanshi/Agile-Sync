import { createRuntime } from './realtime.js';
import { connectDatabase, disconnectDatabase } from './db/connection.js';
import { requireDatabaseIndexes } from './db/indexes.js';

const port = Number(process.env.PORT || 4000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer between 1 and 65535');
try {
  if (process.env.NODE_ENV === 'production') {
    const origin = new URL(process.env.APP_ORIGIN);
    if (origin.protocol !== 'https:' || origin.origin !== process.env.APP_ORIGIN) throw Object.assign(new Error(), { code: 'INVALID_APP_ORIGIN' });
  }
  await connectDatabase();
  await requireDatabaseIndexes();
  const runtime = createRuntime();
  const host = process.env.HOST || (process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1');
  const server = runtime.server.listen(port, host, () => console.log(`Agile Sync API listening on port ${port}`));
  server.on('error', async error => {
    console.error(`Server failed (${error.code || error.name})`);
    await disconnectDatabase();
    process.exitCode = 1;
  });
  let closing = false;
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      if (closing) return;
      closing = true;
      const timeout = setTimeout(() => process.exit(1), 10000);
      timeout.unref();
      runtime.close().then(async () => { await disconnectDatabase(); clearTimeout(timeout); });
    });
  }
} catch (error) {
  console.error(`Startup failed (${error.code || error.name}). Check server/.env, Atlas network access, and run db:indexes. Production requires an HTTPS APP_ORIGIN.`);
  await disconnectDatabase();
  process.exitCode = 1;
}
