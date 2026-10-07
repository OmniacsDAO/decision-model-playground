import { parseJson, validApiKey } from '../public/contract.js';
import { normalizeConnection, providerUrl } from '../public/connections.js';

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export async function readLimited(stream, maximum = 1048576) {
  if (!stream) return '';
  const reader = stream.getReader(), chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maximum) throw new HttpError(413, 'The request or response is too large.');
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export function requestConnection(input, request) {
  let connection;
  try { connection = normalizeConnection(input); } catch (error) { throw new HttpError(422, error.message); }
  const header = connection.kind === 'typesafe' ? 'x-typesafe-api-key' : 'x-endpoint-api-key';
  const apiKey = request.headers.get(header)?.trim() || '';
  if (apiKey && !validApiKey(apiKey)) throw new HttpError(422, 'Use a key of up to 512 characters without spaces.');
  if (connection.needsKey && !apiKey) throw new HttpError(401, 'Add your TypeSafe API key in Connections for this tab.');
  return { ...connection, apiKey };
}

function redact(value, key) {
  if (!key) return value;
  if (typeof value === 'string') return value.split(key).join('[redacted]');
  if (Array.isArray(value)) return value.map(item => redact(item, key));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [redact(name, key), redact(item, key)]));
  return value;
}

export async function callProvider(connection, evaluation, { fetcher = fetch, signal } = {}) {
  const timeout = AbortSignal.timeout(connection.timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const headers = { accept: 'application/json' };
  if (connection.apiKey) headers.authorization = `Bearer ${connection.apiKey}`;
  if (evaluation) headers['content-type'] = 'application/json';
  try {
    const response = await fetcher(providerUrl(connection, evaluation ? 'evaluate' : 'check'), {
      method: evaluation ? 'POST' : 'GET', headers, redirect: 'error', signal: combined,
      ...(evaluation ? { body: JSON.stringify({ ...evaluation, model: connection.model }) } : {}),
    });
    let text;
    try { text = await readLimited(response.body, 2097152); }
    catch (error) { if (error instanceof HttpError) throw new HttpError(502, 'The provider response exceeds 2 MiB.'); throw error; }
    let payload;
    try { payload = redact(parseJson(text), connection.apiKey); }
    catch { if (response.ok) throw new HttpError(502, 'The provider returned invalid JSON. Check its URL and proxy configuration.'); }
    if (!response.ok) {
      // Only show JSON error details. HTML, redirects and network errors can expose credentials or proxy internals.
      const detail = payload?.error?.message ?? payload?.error ?? payload?.detail;
      const message = typeof detail === 'string' ? ` ${detail.slice(0, 600)}` : '';
      const prefix = { 401: 'API key rejected', 403: 'Access denied', 429: 'Provider rate limit', 422: 'Provider rejected the request' }[response.status] || 'Provider request failed';
      throw new HttpError(response.status >= 400 && response.status <= 599 ? response.status : 502, `${prefix} (HTTP ${response.status}).${message}`);
    }
    return payload;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (signal?.aborted) throw new HttpError(499, 'Request cancelled.');
    if (timeout.aborted) throw new HttpError(504, `The endpoint did not finish within ${connection.timeoutMs / 1000} seconds. It may still be processing.`);
    throw new HttpError(502, 'Cannot reach the endpoint from the playground server. Check its address and network access. Redirects are not followed.');
  }
}
