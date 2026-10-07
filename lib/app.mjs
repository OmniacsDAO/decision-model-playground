import { readFile } from 'node:fs/promises';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { normalizeConnection } from '../public/connections.js';
import { isObject, parseJson, validateRequest, validateResponse } from '../public/contract.js';
import { callProvider, requestConnection, readLimited, HttpError } from './provider.mjs';

const assets = new Map([
  ['/', ['index.html', 'text/html']], ['/app.js', ['app.js', 'text/javascript']],
  ['/contract.js', ['contract.js', 'text/javascript']], ['/connections.js', ['connections.js', 'text/javascript']],
  ['/workspace.js', ['workspace.js', 'text/javascript']], ['/styles.css', ['styles.css', 'text/css']],
  ['/favicon.svg', ['favicon.svg', 'image/svg+xml']],
]);
const headers = {
  'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
  'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
};
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers });

export async function createApp({ fetcher = fetch } = {}) {
  const token = randomBytes(32).toString('hex');
  const examples = JSON.parse(await readFile(new URL('../public/examples.json', import.meta.url), 'utf8'));
  const busy = new Set();
  return async request => {
    try {
      const url = new URL(request.url), path = url.pathname;
      if (request.headers.get('sec-fetch-site') === 'cross-site') throw new HttpError(403, 'Cross-site requests are not accepted.');
      const origin = request.headers.get('origin');
      if (origin && origin !== url.origin) throw new HttpError(403, 'Cross-origin requests are not accepted.');
      if (request.method === 'GET') {
        if (path === '/healthz') return json({ status: 'ok' });
        if (path === '/api/bootstrap') return json({ token, examples });
        const asset = assets.get(path);
        if (asset) return new Response(await readFile(new URL(`../public/${asset[0]}`, import.meta.url)), { headers: { ...headers, 'content-type': `${asset[1]}; charset=utf-8` } });
      }
      if (request.method !== 'POST' || !['/api/evaluate', '/api/check'].includes(path)) throw new HttpError(404, 'Not found.');
      if (request.headers.get('x-playground-token') !== token) throw new HttpError(403, 'Reload the playground to reconnect to its server.');
      if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new HttpError(415, 'Send application/json.');
      let input;
      try { input = parseJson(await readLimited(request.body)); }
      catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(400, 'Invalid request JSON.'); }
      if (!isObject(input)) throw new HttpError(400, 'Expected a JSON object.');
      const connection = requestConnection(input.connection, request);
      let evaluation;
      if (path === '/api/evaluate') {
        try { evaluation = validateRequest(input.scenario, connection); }
        catch (error) { throw new HttpError(422, error.message); }
      }
      const identity = createHash('sha256').update(`${connection.baseUrl}\n${connection.apiKey}`).digest('hex');
      if (busy.has(identity)) throw new HttpError(409, 'This connection already has a request running.');
      if (busy.size >= 16) throw new HttpError(429, 'The playground is busy. Try again shortly.');
      busy.add(identity);
      try {
        const started = performance.now();
        const response = await callProvider(connection, evaluation, { fetcher, signal: request.signal });
        const elapsedMs = Math.round(performance.now() - started);
        if (!evaluation) {
          if (!isObject(response)) throw new HttpError(502, 'Model discovery must return a JSON object.');
          const models = Array.isArray(response.data) ? response.data.map(item => item?.id).filter(id => typeof id === 'string') : [];
          return json({ reachable: true, elapsedMs, model: typeof response.model === 'string' ? response.model : connection.model,
            loaded: response.loaded === false ? false : models.length ? models.includes(connection.model) : null });
        }
        try { validateResponse(response, evaluation.questions); }
        catch (error) { throw new HttpError(502, `Invalid provider response: ${error.message}`); }
        const { apiKey, ...safeConnection } = connection;
        return json({ run: { id: randomUUID(), createdAt: new Date().toISOString(),
          title: typeof input.title === 'string' ? input.title.slice(0, 120) : 'Untitled scenario',
          endpoint: normalizeConnection(safeConnection), elapsedMs,
          request: { model: connection.model, ...evaluation }, response } });
      } finally { busy.delete(identity); }
    } catch (error) {
      if (error instanceof HttpError) return json({ error: error.message }, error.status);
      // Do not log request bodies, URLs or exceptions that might contain keys.
      console.error('Playground request failed.');
      return json({ error: 'The playground could not complete this request.' }, 500);
    }
  };
}
