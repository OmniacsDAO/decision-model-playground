import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../server.mjs';

export const sample = { title: 'A simple record', state: 'The fruit is a red apple.', questions: {
  is_apple: { type: 'noul', instructions: 'Is the fruit an apple?' },
  color: { type: 'choice', instructions: 'What color is it?', criteria: { red: 'Red', blue: 'Blue' } },
  count: { type: 'score', instructions: 'How many apples?', criteria: ['None', 'One', 'Two'] },
} };

export function answer(input) {
  return { model: input.model || 'fixture-model', usage: { input_tokens: 12 },
    answers: Object.fromEntries(Object.entries(input.questions).map(([id, question]) => {
      if (question.type === 'noul') return [id, { type: 'noul', noul: 0.9 }];
      const labels = question.type === 'score' ? question.criteria.map((_, i) => String(i)) : Object.keys(question.criteria);
      return [id, { type: question.type, probabilities: Object.fromEntries(labels.map((label, i) => [label, i ? 0 : 1])), confidence: 1,
        ...(question.type === 'choice' ? { choice: labels[0] } : { score: 0 }) }];
    })) };
}

export async function startFixture() {
  const fixture = { calls: [], delayMs: 0, mode: 'ok', directory: await mkdtemp(join(tmpdir(), 'decision-playground-test-')) };
  const provider = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const input = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
    fixture.calls.push({ path: request.url, authorization: request.headers.authorization, input });
    const finish = () => {
      if (response.destroyed) return;
      if (fixture.mode === 'html') { response.writeHead(502, { 'content-type': 'text/html' }); response.end('<html>Proxy failed</html>'); return; }
      if (fixture.mode === 'redirect') { response.writeHead(307, { location: '/other' }); response.end(); return; }
      if (fixture.mode === 'rate') { response.writeHead(429, { 'content-type': 'application/json' }); response.end('{"error":"Slow down"}'); return; }
      const cloud = request.url.startsWith('/typesafe/');
      if (cloud && !['Bearer test-browser-A', 'Bearer test-browser-B'].includes(request.headers.authorization)) {
        response.writeHead(401, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: `Rejected ${request.headers.authorization || 'missing'}` })); return;
      }
      response.setHeader('content-type', 'application/json');
      const output = !input ? { model: cloud ? 'jev-latest' : 'fixture-model', loaded: true } : fixture.mode === 'malformed' ? { model: 'fixture-model', answers: {} } : answer(input);
      if (fixture.mode === 'echo') output.echo = { [request.headers.authorization]: request.headers.authorization };
      response.end(JSON.stringify(output));
    };
    if (fixture.delayMs) { const timer = setTimeout(finish, fixture.delayMs); response.once('close', () => clearTimeout(timer)); }
    else finish();
  });
  provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
  fixture.providerUrl = `http://127.0.0.1:${provider.address().port}`;
  const server = await startServer({ port: 0, fetcher: (url, init) => {
    const destination = new URL(url);
    if (destination.origin === 'https://api.typesafe.ai') url = `${fixture.providerUrl}/typesafe${destination.pathname}`;
    else if (destination.origin !== fixture.providerUrl) throw new Error('Tests cannot call outside providers.');
    return fetch(url, init);
  } });
  fixture.url = `http://127.0.0.1:${server.address().port}`;
  fixture.connection = { id: 'fixture', name: 'Test endpoint', kind: 'custom', model: 'fixture-model', baseUrl: fixture.providerUrl, timeoutMs: 1000 };
  fixture.token = (await (await fetch(fixture.url + '/api/bootstrap')).json()).token;
  fixture.request = (path, input, options = {}) => fetch(fixture.url + path, {
    method: input === undefined ? 'GET' : 'POST', ...options,
    headers: { origin: fixture.url, 'content-type': 'application/json', 'x-playground-token': fixture.token, ...options.headers },
    ...(input === undefined ? {} : { body: typeof input === 'string' ? input : JSON.stringify(input) }),
  });
  fixture.close = async () => {
    server.closeAllConnections(); provider.closeAllConnections();
    await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => provider.close(resolve))]);
    await rm(fixture.directory, { recursive: true, force: true });
  };
  return fixture;
}

export async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, 'close'); child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  try { await closed; } finally { clearTimeout(timer); }
}
