import test from 'node:test';
import assert from 'node:assert/strict';
import { parseJson, parseJsonInput, parseStateInput, formatStateInput, validateRequest } from '../public/contract.js';
import { sample } from './helpers.mjs';

test('duplicate names, escaped aliases, overflow and unsafe integers are rejected', () => {
  for (const text of ['{"x":1,"x":2}', '{"x":1,"\\u0078":2}', '{"nested":[{"x":1,"x":2}]}']) assert.throws(() => parseJsonInput(text), /Duplicate JSON key/);
  for (const text of ['{"id":9007199254740993}', '{"x":1e999}', '{"x":-1e999}']) assert.throws(() => parseJsonInput(text), /quotes/);
  assert.deepEqual(parseJsonInput('{"a":{"x":1},"b":{"x":2}}'), { a: { x: 1 }, b: { x: 2 } });
  assert.deepEqual(parseJsonInput('```json\n{"id":"9007199254740993"}\n```'), { id: '9007199254740993' });
  assert.throws(() => parseJson('{\u00a0"x":1}')); // Wire JSON stays strict.
});

test('scenario byte, nesting and circular-reference limits fail before a provider call', () => {
  assert.throws(() => validateRequest({ ...sample, questions: { q: { type: 'noul', instructions: { text: 'x'.repeat(1100000) } } } }), /complete scenario/);
  assert.throws(() => validateRequest({ ...sample, state: '😀'.repeat(40000) }), /128 KiB/);
  assert.throws(() => parseJsonInput('['.repeat(65) + '0' + ']'.repeat(65)), /nesting/);
  const cycle = {}; cycle.self = cycle;
  assert.throws(() => validateRequest({ ...sample, state: cycle }), /circular/);
});

test('5,000 seeded Unicode JSON round trips preserve values and literal text', t => {
  let seed = 123456789;
  const next = n => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) % n; };
  const strings = ['hello', 'quote" and \\', 'line\nnext', '\u00a0\u202f\ufeff', 'नमस्ते 🧪', '__proto__', '</textarea><script>alert(1)</script>', '```json\n{}\n```'];
  const value = depth => {
    const type = next(depth ? 6 : 4);
    if (type === 0) return null; if (type === 1) return Boolean(next(2)); if (type === 2) return (next(20000) - 10000) / 10;
    if (type === 3) return strings[next(strings.length)];
    if (type === 4) return Array.from({ length: next(5) }, () => value(depth - 1));
    return Object.fromEntries(Array.from({ length: next(5) }, (_, i) => [strings[next(strings.length)] + i, value(depth - 1)]));
  };
  const started = performance.now();
  for (let i = 0; i < 5000; i++) {
    const original = value(4), text = JSON.stringify(original, null, 2);
    assert.deepEqual(parseJsonInput(text.replace(/^ +/gm, indent => '\u00a0'.repeat(indent.length))), original);
    const state = original !== null && typeof original === 'object' ? original : text;
    assert.deepEqual(parseStateInput(formatStateInput(state)), state);
  }
  t.diagnostic(`5,000 round trips: ${Math.round(performance.now() - started)} ms`);
});

