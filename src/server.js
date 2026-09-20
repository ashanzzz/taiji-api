import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { once } from 'node:events';
import { HttpError, openAiError } from './errors.js';
import { authorizeRelay, checkOrigin } from './auth.js';

export function createApiServer(config, adapter, admin) {
  const server = createServer(async (request, response) => {
    const started = Date.now();
    let path = '/', release;
    secureHeaders(response);
    try {
      path = new URL(request.url, 'http://localhost').pathname;
      if (request.method === 'GET' && path === '/healthz') return sendJson(response, 200, { status: 'ok', version: '0.3.0' });
      if (path.startsWith('/admin/')) {
        checkOrigin(request);
        if (path !== '/admin/login') admin.auth.require(request);
        if (request.method === 'GET' && path === '/admin/playground') throw new HttpError(405, 'Use POST');
        if (path !== '/admin/playground') {
          const body = ['POST', 'PUT'].includes(request.method) ? await readBody(request, 1_000_000) : {};
          return sendJson(response, 200, await admin.route(path, request.method, body, request, response));
        }
      } else if (path.startsWith('/v1/')) authorizeRelay(request, config);
      else if (request.method === 'GET') return await serveStatic(path, response);
      else throw new HttpError(404, 'Not found');

      release = admin?.gate.enter();
      if (path === '/v1/models' && request.method === 'GET') return sendJson(response, 200, await adapter.listModels());
      if (!['/v1/chat/completions', '/admin/playground'].includes(path) || request.method !== 'POST') throw new HttpError(404, 'Not found');
      const body = await readBody(request, 8 * 1024 * 1024);
      const controller = new AbortController();
      request.once('aborted', () => controller.abort());
      response.once('close', () => { if (!response.writableFinished) controller.abort(); });
      if (body.stream) {
        const write = async chunk => {
          controller.signal.throwIfAborted();
          if (!response.headersSent) response.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no',
          });
          if (!response.write(chunk)) await once(response, 'drain', { signal: controller.signal });
        };
        await adapter.stream(body, controller.signal, write);
        response.end();
      } else sendJson(response, 200, await adapter.complete(body, controller.signal));
      admin?.log.add('chat', 'Chat request completed', { model: body.model || config.defaultModel, stream: Boolean(body.stream), elapsedMs: Date.now() - started });
    } catch (error) {
      const result = openAiError(error);
      if (!response.destroyed && !response.writableEnded) {
        if (response.headersSent) { response.write(`data: ${JSON.stringify(result.body)}\n\n`); response.end('data: [DONE]\n\n'); }
        else sendJson(response, result.status, result.body);
      }
      // Omit raw errors, prompts, credentials, and account data from the audit trail.
      if (path !== '/admin/state' && path !== '/admin/login') admin?.log.add('request_error', 'Request did not complete', { path, status: result.status, elapsedMs: Date.now() - started }, 'warn');
    } finally { release?.(); }
  });
  server.requestTimeout = 600000;
  server.headersTimeout = 30000;
  return server;
}

export async function readBody(request, max) {
  if (!request.headers['content-type']?.startsWith('application/json')) throw new HttpError(415, 'Use application/json');
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > max) throw new HttpError(413, 'Request body too large');
    chunks.push(chunk);
  }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, 'Invalid JSON'); }
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new HttpError(400, 'Expected a JSON object');
  return value;
}
function sendJson(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(body));
}
async function serveStatic(path, response) {
  const root = resolve('public');
  let decoded;
  try { decoded = decodeURIComponent(path); } catch { throw new HttpError(400, 'Invalid path'); }
  const file = resolve(root, decoded === '/' ? 'index.html' : `.${decoded}`);
  if (!file.startsWith(root + sep)) throw new HttpError(404, 'Not found');
  const type = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' }[extname(file)];
  if (!type) throw new HttpError(404, 'Not found');
  let data;
  try { data = await readFile(file); } catch { throw new HttpError(404, 'Not found'); }
  response.writeHead(200, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-cache' });
  response.end(data);
}
function secureHeaders(response) {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
}
