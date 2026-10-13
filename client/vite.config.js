import { defineConfig } from 'vite';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
const socketBrowser = path.join(path.dirname(createRequire(import.meta.url).resolve('socket.io-client')), '../../dist/socket.io.esm.min.js');

// Resolve dependency files through Node to avoid Go/esbuild traversing protected
// ancestor directories in the Windows sandbox. This affects development only.
const localDependencies = {
  name: 'node-dependency-reader',
  setup(build) {
    build.onResolve({ filter: /.*/ }, args => {
      if (args.namespace !== 'node-dependency' && !['react', 'react-dom/client', 'socket.io-client'].includes(args.path) && !args.path.includes('node_modules') && !args.importer.includes('node_modules')) return;
      const parent = path.isAbsolute(args.importer || '') ? args.importer : path.join(args.resolveDir || process.cwd(), 'entry.js');
      const require = createRequire(parent);
      const resolved = args.path === 'socket.io-client' ? socketBrowser : require.resolve(args.path);
      return { path: resolved, namespace: 'node-dependency' };
    });
    build.onLoad({ filter: /.*/, namespace: 'node-dependency' }, async args => ({
      contents: await readFile(args.path, 'utf8'), loader: args.path.endsWith('.json') ? 'json' : 'js', resolveDir: path.dirname(args.path)
    }));
  }
};
export default defineConfig({
  resolve: { alias: { 'socket.io-client': socketBrowser } },
  optimizeDeps: { noDiscovery: true, include: ['react', 'react-dom/client', 'socket.io-client'], esbuildOptions: { tsconfigRaw: { compilerOptions: {} }, plugins: [localDependencies] } },
  server: {
    host: '127.0.0.1', port: 5173, strictPort: true,
    proxy: { '/api': 'http://127.0.0.1:4000', '/socket.io': { target: 'http://127.0.0.1:4000', ws: true } }
  },
  preview: {
    host: '127.0.0.1', port: 5173, strictPort: true,
    proxy: { '/api': 'http://127.0.0.1:4000', '/socket.io': { target: 'http://127.0.0.1:4000', ws: true } }
  }
});



