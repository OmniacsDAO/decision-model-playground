import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { normalizeConnection, providerUrl, TYPESAFE } from '../public/connections.js';
import { callProvider, requestConnection } from '../lib/provider.mjs';
import { startServer } from '../server.mjs';
import { startFixture, sample, answer } from './helpers.mjs';

async function setup(t) { const f = await startFixture(); t.after(() => f.close()); return f; }

// Node fetch rewrites Sec-Fetch-Mode. Use raw HTTP to test browser metadata exactly.
function browserRequest(url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { method, headers }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: response.statusCode, headers: response.headers })));
      response.on('error', reject);
    });
    request.on('error', reject); request.end(body);
  });
}

test('base, versioned and full URLs preserve proxy prefixes', () => {
  for (const suffix of ['', '/', '/v1', '/v1/', '/v1/systemone']) {
    const connection = normalizeConnection({ id: 'custom', name: 'Server', kind: 'custom', model: 'model', baseUrl: `https://example.com/prefix${suffix}` });
    assert.equal(providerUrl(connection, 'evaluate'), 'https://example.com/prefix/v1/systemone');
    assert.equal(providerUrl(connection, 'check'), 'https://example.com/prefix/v1/models');
  }
});

test('credentials cannot enter saved connection settings or URL fields', () => {
  const base = { id: 'custom', name: 'Server', kind: 'custom', model: 'model', baseUrl: 'https://example.com' };
  for (const baseUrl of ['ftp://example.com', 'https://user:pass@example.com', 'https://example.com?token=x', 'https://example.com/#x', 'https://example.com/a\nb']) assert.throws(() => normalizeConnection({ ...base, baseUrl }));
  for (const key of ['apiKey', 'apiKeyEnv', 'password', 'token', 'authorization']) assert.throws(() => normalizeConnection({ ...base, [key]: 'test-credential' }));
});

test('cloud keys are pinned to TypeSafe and never borrowed by a custom endpoint', () => {
  assert.deepEqual(normalizeConnection({ ...TYPESAFE, baseUrl: 'https://example.com', model: 'other' }), TYPESAFE);
  const request = new Request('http://localhost', { headers: { 'x-typesafe-api-key': 'test-browser-A' } });
  const connection = requestConnection({ id: 'other', name: 'Other', kind: 'custom', model: 'm', baseUrl: 'https://example.com' }, request);
  assert.equal(connection.apiKey, '');
  assert.throws(() => requestConnection(TYPESAFE, new Request('http://localhost')), error => error.status === 401);
});

test('real HTTP evaluates all three types without returning credentials or transport input', async t => {
  const f = await setup(t);
  const response = await f.request('/api/evaluate', { connection: f.connection, scenario: { ...sample, model: 'ignored', endpoint: 'https://example.com' } });
  assert.equal(response.status, 200);
  const { run } = await response.json();
  assert.deepEqual(Object.keys(run.response.answers), ['is_apple', 'color', 'count']);
  assert.equal(run.request.model, 'fixture-model'); assert.equal(run.request.endpoint, undefined);
  assert.equal(run.endpoint.apiKey, undefined);
  assert.equal(f.calls[0].authorization, undefined);
});

test('no key is shared between callers, including discovery', async t => {
  const f = await setup(t);
  for (const path of ['/api/check', '/api/evaluate']) {
    const input = { connection: TYPESAFE, scenario: sample };
    assert.equal((await f.request(path, input)).status, 401);
    assert.equal((await f.request(path, input, { headers: { 'x-typesafe-api-key': 'test-browser-A' } })).status, 200);
    assert.equal((await f.request(path, input)).status, 401);
  }
  assert.equal(f.calls.length, 2);
});

test('TypeSafe key is not sent when custom endpoint is selected', async t => {
  const f = await setup(t);
  assert.equal((await f.request('/api/evaluate', { connection: f.connection, scenario: sample }, { headers: { 'x-typesafe-api-key': 'test-browser-A' } })).status, 200);
  assert.equal(f.calls[0].authorization, undefined);
});

test('provider errors and successful reflected keys are redacted', async t => {
  const f = await setup(t);
  const bad = await f.request('/api/check', { connection: TYPESAFE }, { headers: { 'x-typesafe-api-key': 'test-invalid-key' } });
  assert.equal(bad.status, 401); assert.ok(!(await bad.text()).includes('test-invalid-key'));
  f.mode = 'echo';
  const response = await f.request('/api/evaluate', { connection: f.connection, scenario: sample }, { headers: { 'x-endpoint-api-key': 'test-reflected-secret' } });
  assert.equal(response.status, 200); assert.ok(!(await response.text()).includes('test-reflected-secret'));
});

test('HTML errors, bad answers, redirects and rate limits are handled without retries', async t => {
  const f = await setup(t);
  for (const [mode, status] of [['html', 502], ['malformed', 502], ['redirect', 502], ['rate', 429]]) {
    f.mode = mode; const before = f.calls.length;
    const response = await f.request('/api/evaluate', { connection: f.connection, scenario: sample });
    assert.equal(response.status, status); assert.ok((await response.json()).error);
    assert.equal(f.calls.length, before + 1);
  }
});

test('timeout and cancellation free the connection for subsequent requests', async t => {
  const f = await setup(t); f.delayMs = 1500;
  assert.equal((await f.request('/api/check', { connection: f.connection })).status, 504);
  const controller = new AbortController();
  const pending = f.request('/api/evaluate', { connection: f.connection, scenario: sample }, { signal: controller.signal });
  await delay(50); controller.abort(); await assert.rejects(pending);
  await delay(70); f.delayMs = 0;
  assert.equal((await f.request('/api/check', { connection: f.connection })).status, 200);
});

test('concurrent calls are bounded per destination and credential, independently of client IDs', async t => {
  const f = await setup(t); f.delayMs = 150;
  const input = { connection: f.connection, scenario: sample };
  const first = f.request('/api/evaluate', input); await delay(30);
  assert.equal((await f.request('/api/evaluate', { ...input, connection: { ...f.connection, id: 'other-id' } })).status, 409);
  assert.equal((await first).status, 200);
  const results = await Promise.all(['test-browser-A', 'test-browser-B'].map(key => f.request('/api/evaluate', { connection: TYPESAFE, scenario: sample }, { headers: { 'x-typesafe-api-key': key } })));
  assert.deepEqual(results.map(response => response.status), [200, 200]);
});

test('origin, Host and anti-forgery checks reject external browser requests', async t => {
  const f = await setup(t), input = { connection: f.connection, scenario: sample };
  assert.equal((await f.request('/api/evaluate', input, { headers: { origin: 'https://example.com' } })).status, 403);
  assert.equal((await f.request('/api/evaluate', input, { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  assert.equal((await f.request('/api/evaluate', input, { headers: { 'x-playground-token': '' } })).status, 403);
  const status = await new Promise((resolve, reject) => {
    const request = httpRequest(f.url + '/api/bootstrap', { headers: { host: 'attacker.example' } }, response => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject); request.end();
  });
  assert.equal(status, 403);
  assert.equal(f.calls.length, 0);
});

test('external links can open the homepage without making the API public across sites', async t => {
  const f = await setup(t);
  const navigation = { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' };
  for (const path of ['/', '/?from=external-link']) {
    // A browser navigation normally has no Origin header. Do not require
    // Sec-Fetch-User: redirects and in-app browsers may omit it.
    const response = await browserRequest(f.url + path, { headers: navigation });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/html/);
    assert.match(await response.text(), /Decision Model Playground/);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  }
  assert.equal(f.calls.length, 0);
});

test('navigation exception excludes APIs, subresources, frames, POSTs and foreign Origins', async t => {
  const f = await setup(t);
  const navigation = { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' };
  for (const path of ['/api/bootstrap', '/api/check', '/api/evaluate', '/healthz', '/app.js', '/styles.css', '/server.mjs']) {
    const response = await browserRequest(f.url + path, { headers: navigation });
    assert.equal(response.status, 403, path);
    assert.deepEqual(await response.json(), { error: 'Cross-site requests are not accepted.' });
  }
  for (const changed of [
    { 'sec-fetch-mode': 'cors' }, { 'sec-fetch-mode': 'no-cors' }, { 'sec-fetch-mode': '' },
    { 'sec-fetch-dest': 'iframe' }, { 'sec-fetch-dest': 'frame' }, { 'sec-fetch-dest': 'object' }, { 'sec-fetch-dest': 'embed' }, { 'sec-fetch-dest': '' },
    { origin: 'https://other.example' }, { origin: 'null' },
  ]) assert.equal((await browserRequest(f.url, { headers: { ...navigation, ...changed } })).status, 403, JSON.stringify(changed));
  for (const path of ['/', '/api/check', '/api/evaluate']) {
    const response = await browserRequest(f.url + path, { method: 'POST',
      headers: { ...navigation, origin: f.url, 'content-type': 'application/json', 'x-playground-token': f.token },
      body: JSON.stringify({ connection: f.connection, scenario: sample }) });
    assert.equal(response.status, 403, `POST ${path} even with a valid token`);
  }
  // Same-origin API calls still need both the request token and a valid Origin.
  for (const path of ['/api/check', '/api/evaluate']) for (const changed of [
    { 'x-playground-token': '' }, { 'x-playground-token': 'wrong' }, { origin: 'https://other.example' },
  ]) assert.equal((await f.request(path, { connection: f.connection, scenario: sample }, { headers: { 'sec-fetch-site': 'same-origin', ...changed } })).status, 403);
  assert.equal(f.calls.length, 0);
});

test('HTTPS public origin works through an HTTP proxy while retaining Host and API protection', async t => {
  const publicOrigin = 'https://playground.example'; let calls = 0;
  const server = await startServer({ port: 0, appOrigin: publicOrigin, fetcher: async (_, options) => {
    calls++; return Response.json(answer(JSON.parse(options.body)));
  } });
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const request = (path, { headers = {}, ...options } = {}) => browserRequest(`http://127.0.0.1:${server.address().port}${path}`,
    { ...options, headers: { host: 'playground.example', ...headers } });
  const navigation = { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' };
  assert.equal((await request('/', { headers: navigation })).status, 200);
  assert.equal((await request('/', { headers: { ...navigation, host: 'attacker.example' } })).status, 403);
  assert.equal((await request('/api/bootstrap', { headers: navigation })).status, 403);
  const bootstrap = await request('/api/bootstrap', { headers: { origin: publicOrigin, 'sec-fetch-site': 'same-origin' } });
  assert.equal(bootstrap.status, 200);
  const headers = { origin: publicOrigin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', 'x-playground-token': (await bootstrap.json()).token };
  const input = JSON.stringify({ connection: { id: 'test', name: 'Test', kind: 'custom', model: 'fixture-model', baseUrl: 'http://model.example' }, scenario: sample });
  const result = await request('/api/evaluate', { method: 'POST', headers, body: input });
  assert.equal(result.status, 200); assert.equal(calls, 1);
  assert.equal((await request('/api/evaluate', { method: 'POST', headers: { ...headers, ...navigation }, body: input })).status, 403);
  assert.equal((await request('/api/evaluate', { method: 'POST', headers: { ...headers, origin: 'http://playground.example' }, body: input })).status, 403);
  assert.equal(calls, 1);
});

test('only public assets are served; no data or key APIs exist', async t => {
  const f = await setup(t);
  for (const path of ['/server.mjs', '/.env', '/.key', '/package.json', '/api/workspace', '/api/scenarios', '/data/workspace.json']) assert.equal((await f.request(path)).status, 404);
  const response = await f.request('/'); assert.equal(response.status, 200);
  assert.match(await response.text(), /Decision Model Playground/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('malformed requests, oversized input and invalid contracts do not reach the provider', async t => {
  const f = await setup(t);
  assert.equal((await f.request('/api/evaluate', '{')).status, 400);
  assert.equal((await f.request('/api/evaluate', { state: 'x'.repeat(1048577) })).status, 413);
  assert.equal((await f.request('/api/evaluate', { connection: f.connection, scenario: { state: 1, questions: {} } })).status, 422);
  assert.equal((await f.request('/api/evaluate', {}, { headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.equal(f.calls.length, 0);
});

test('response size limit and optional uncertainty fields are preserved', async () => {
  const base = { ...TYPESAFE, apiKey: 'test-key' };
  await assert.rejects(callProvider(base, sample, { fetcher: async () => new Response('x'.repeat(2097153)) }), /2 MiB/);
  const output = answer(sample); output.answers.color.unknown_probability = 0.8; output.answers.color.abstained = true;
  assert.deepEqual(await callProvider(base, sample, { fetcher: async () => Response.json(output) }), output);
});

test('network binding requires an explicit browser origin', async () => {
  await assert.rejects(startServer({ host: '0.0.0.0', port: 0 }), /APP_ORIGIN/);
  await assert.rejects(startServer({ appOrigin: 'https://example.com/path' }), /origin/);
  await assert.rejects(startServer({ port: -1 }), /PORT/);
});
