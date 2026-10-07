import { isObject } from './contract.js';

export const TYPESAFE = Object.freeze({
  id: 'typesafe', name: 'TypeSafe', kind: 'typesafe', model: 'jev-latest',
  baseUrl: 'https://api.typesafe.ai', maxQuestions: 64, timeoutMs: 60000,
  browserKey: true, needsKey: true,
});

export function normalizeConnection(value) {
  if (!isObject(value)) throw new Error('Choose a connection.');
  // Cloud credentials can only reach the official service, regardless of client input.
  if (value.kind === 'typesafe') return { ...TYPESAFE };
  if (!['custom', 'imajev'].includes(value.kind)) throw new Error('Choose a compatible API or Imajev.');
  if (typeof value.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(value.id) || value.id === TYPESAFE.id) throw new Error('Invalid connection ID.');
  if (typeof value.name !== 'string' || !value.name.trim() || value.name.length > 80) throw new Error('Give the endpoint a name of 1–80 characters.');
  if (typeof value.model !== 'string' || !value.model.trim() || value.model.length > 200) throw new Error('Enter the model ID (up to 200 characters).');
  if (['apiKey', 'token', 'password', 'authorization', 'apiKeyEnv'].some(key => Object.hasOwn(value, key))) throw new Error('Enter keys in the separate key field, never in connection settings.');
  let url;
  try { if (typeof value.baseUrl !== 'string' || value.baseUrl.length > 2048) throw new Error(); url = new URL(value.baseUrl); }
  catch { throw new Error('Enter a valid HTTP or HTTPS endpoint URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Use HTTP(S) without credentials, query parameters, or a fragment in the URL.');
  if (/[\x00-\x20\\]/.test(value.baseUrl) || /%0[ad]/i.test(url.pathname)) throw new Error('The endpoint URL contains invalid characters.');
  url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/v1(?:\/systemone)?$/, '');
  const maxQuestions = value.maxQuestions ?? (value.kind === 'imajev' ? 8 : 64);
  const timeoutMs = value.timeoutMs ?? 60000;
  if (!Number.isInteger(maxQuestions) || maxQuestions < 1 || maxQuestions > (value.kind === 'imajev' ? 8 : 64)) throw new Error('Invalid question limit.');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300000) throw new Error('Timeout must be 1000–300000 milliseconds.');
  return {
    id: value.id, name: value.name.trim(), kind: value.kind, model: value.model.trim(),
    baseUrl: url.href.replace(/\/$/, ''), maxQuestions, timeoutMs, browserKey: true, needsKey: false,
  };
}

export function providerUrl(connection, operation) {
  return `${connection.baseUrl}/v1/${operation === 'check' ? 'models' : 'systemone'}`;
}
