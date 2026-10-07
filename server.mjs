import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
import { createApp } from './lib/app.mjs';

export async function startServer({ host = '127.0.0.1', port = 3000, appOrigin, fetcher } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT must be between 0 and 65535.');
  const local = ['127.0.0.1', '::1', 'localhost'].includes(host);
  if (!local && !appOrigin) throw new Error('Set APP_ORIGIN to the browser URL when binding to a network interface.');
  if (appOrigin) {
    const url = new URL(appOrigin);
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== appOrigin) throw new Error('APP_ORIGIN must be an HTTP(S) origin without a path or trailing slash.');
  }
  const app = await createApp({ fetcher });
  const server = createServer(async (incoming, outgoing) => {
    const controller = new AbortController();
    outgoing.on('close', () => { if (!outgoing.writableFinished) controller.abort(); });
    try {
      const actualPort = server.address().port;
      const allowed = appOrigin ? [new URL(appOrigin).host] : [`localhost:${actualPort}`, `127.0.0.1:${actualPort}`, `[::1]:${actualPort}`];
      if (!allowed.includes(incoming.headers.host) || !incoming.url.startsWith('/') || incoming.url.startsWith('//')) {
        outgoing.writeHead(403, { 'content-type': 'application/json' }); outgoing.end('{"error":"Unexpected request host."}'); return;
      }
      const origin = appOrigin || `http://${incoming.headers.host}`;
      const request = new Request(`${origin}${incoming.url}`, {
        method: incoming.method, headers: incoming.headers, signal: controller.signal,
        ...(!['GET', 'HEAD'].includes(incoming.method) ? { body: Readable.toWeb(incoming), duplex: 'half' } : {}),
      });
      const response = await app(request);
      if (outgoing.destroyed) return;
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body) await pipeline(Readable.fromWeb(response.body), outgoing);
      else outgoing.end();
    } catch {
      if (!outgoing.headersSent && !outgoing.destroyed) outgoing.writeHead(400, { 'content-type': 'application/json' });
      if (!outgoing.destroyed) outgoing.end('{"error":"Invalid HTTP request."}');
    }
  });
  server.requestTimeout = 310000;
  server.headersTimeout = 15000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const host = process.env.HOST || '127.0.0.1';
    const server = await startServer({ host, port: Number(process.env.PORT || 3000), appOrigin: process.env.APP_ORIGIN });
    console.log(`Decision Model Playground: ${process.env.APP_ORIGIN || `http://${host === '::1' ? '[::1]' : host}:${server.address().port}`}`);
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
      server.close(() => process.exit(0));
      setTimeout(() => { server.closeAllConnections(); process.exit(0); }, 5000).unref();
    });
  } catch (error) { console.error(`Cannot start playground: ${error.message}`); process.exitCode = 1; }
}
