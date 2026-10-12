import { createReadStream, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { sendError } from './errors.js';
/**
 * Serves the built web app (apps/web/dist, made by `npm run build`) from the API server, so a
 * production install is one process on one port: /api/... and /mcp are the API, everything
 * else is the web app. Any address that isn't a file gets index.html -- the app routes in the
 * browser (#/reports/... links, reloads) -- unless it looks like a missing file (has an
 * extension), which stays a 404.
 *
 * Built assets (/assets/...) have content hashes in their names, so they're cached for a year;
 * index.html is never cached, so a new build is picked up on the next load.
 */
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
};

/** Paths that belong to the API: never answered with the web app. */
function isApiPath(pathname: string): boolean {
  return pathname === '/api' || pathname.startsWith('/api/') || pathname === '/mcp' || pathname.startsWith('/mcp/');
}

function fileAt(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** The same body Fastify sends for an unknown route. */
const notFound = (request: FastifyRequest, reply: FastifyReply) =>
  sendError(reply, 404, `Route ${request.method}:${request.url} not found`);

export function registerWebApp(app: FastifyInstance, distDir: string): void {
  const root = resolve(distDir);
  const indexHtml = join(root, 'index.html');

  const sendFile = (reply: FastifyReply, path: string, cacheControl: string) =>
    reply
      .header('Content-Type', CONTENT_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream')
      .header('Cache-Control', cacheControl)
      .header('X-Content-Type-Options', 'nosniff')
      .send(createReadStream(path));

  app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
    const pathname = request.url.split('?')[0];
    if ((request.method !== 'GET' && request.method !== 'HEAD') || isApiPath(pathname)) {
      return notFound(request, reply);
    }

    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      return notFound(request, reply);
    }
    // Only files inside the build folder: anything resolving outside it (../) is refused.
    const target = resolve(root, `.${decoded}`);
    if (decoded.includes('\0') || (target !== root && !target.startsWith(root + sep))) {
      return notFound(request, reply);
    }

    if (target !== root && fileAt(target)) {
      const immutable = decoded.startsWith('/assets/');
      return sendFile(reply, target, immutable ? 'public, max-age=31536000, immutable' : 'no-cache');
    }
    if (extname(decoded)) return notFound(request, reply);
    return sendFile(reply, indexHtml, 'no-cache');
  });
}
