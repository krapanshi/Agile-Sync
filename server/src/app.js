import express from 'express';
import { createAuthRouter, HttpError } from './auth/routes.js';
import { mongoStore } from './auth/store.js';
import { mongoBoardStore } from './boards/store.js';
import mongoose from 'mongoose';
import { fileURLToPath } from 'node:url';

export function createApp({ store = { ...mongoStore, ...mongoBoardStore }, production = process.env.NODE_ENV === 'production', appOrigin = process.env.APP_ORIGIN || 'http://localhost:5173',
  staticDirectory = production ? fileURLToPath(new URL('../../client/dist/', import.meta.url)) : null,
  ready = async () => { if (mongoose.connection.readyState !== 1) return false; await mongoose.connection.db.admin().ping(); return true; }
} = {}) {
  const app = express();
  app.disable('x-powered-by');
  const hops = Number(process.env.TRUST_PROXY_HOPS || 0);
  if (!Number.isInteger(hops) || hops < 0 || hops > 4) throw new Error('Invalid TRUST_PROXY_HOPS');
  app.set('trust proxy', hops);
  app.use(express.json({ limit: '100kb' }));
  app.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    res.set('X-Content-Type-Options', 'nosniff');
    next();
  });
  app.get('/api/health', (_req, res) => res.json({ status: 'ok', service: 'agile-sync-api' }));
  app.get('/api/ready', async (_req, res) => {
    let timer;
    try {
      const available = await Promise.race([ready(), new Promise(resolve => { timer = setTimeout(() => resolve(false), 1500); })]);
      res.status(available ? 200 : 503).json({ status: available ? 'ready' : 'unavailable' });
    } catch { res.status(503).json({ status: 'unavailable' }); }
    finally { clearTimeout(timer); }
  });
  app.use('/api', createAuthRouter(store, { production, appOrigin }));
  if (staticDirectory) app.use(express.static(staticDirectory));
  app.use((_req, res) => res.status(404).json({ error: 'Route not found' }));
  app.use((err, _req, res, _next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    if (err.code === 11000) return res.status(409).json({ error: 'An account, workspace, or membership already exists' });
    if (['ValidationError', 'CastError', 'StrictModeError'].includes(err.name)) return res.status(400).json({ error: 'Invalid request data' });
    if (err.status === 400 || err.status === 413) return res.status(err.status).json({ error: 'Invalid request' });
    console.error(`Request failed (${err.code || err.name || 'Error'})`);
    res.status(500).json({ error: 'Internal server error' });
  });
  return app;
}
export const app = createApp();
