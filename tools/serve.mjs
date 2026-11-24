/**
 * Zero-dependency static file server for local development and testing.
 * Usage: node tools/serve.mjs [port]
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const port = Number(process.argv[2] || process.env.PORT || 8080);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.nii': 'application/octet-stream',
  '.dcm': 'application/octet-stream',
  '.zip': 'application/zip',
  '.pdf': 'application/pdf',
  '.md': 'text/markdown; charset=utf-8',
};

const server = createServer(async (request, response) => {
  const started = performance.now();
  const status = { code: 200 };
  response.on('finish', () => {
    const ms = Math.round(performance.now() - started);
    console.log(`${String(status.code).padEnd(4)} ${request.method} ${request.url} ${ms}ms`);
  });
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);
    let path = decodeURIComponent(url.pathname);
    if (path.endsWith('/')) path += 'index.html';
    const filePath = join(root, normalize(path));
    if (!filePath.startsWith(root)) {
      status.code = 403;
      response.writeHead(403).end('Forbidden');
      return;
    }
    const info = await stat(filePath).catch(() => null);
    if (!info || !info.isFile()) {
      status.code = 404;
      response.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
      return;
    }
    const body = await readFile(filePath);
    response.writeHead(200, {
      'content-type': MIME[extname(filePath).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    response.end(body);
  } catch (error) {
    status.code = 500;
    response.writeHead(500, { 'content-type': 'text/plain' }).end(String(error));
  }
});

server.listen(port, '0.0.0.0', () => {
  console.log(`Brain2DPrint dev server: http://localhost:${port}/`);
});
