// A lightweight check for accidental secrets and machine-specific files.
// Reports file names and rules only, never matching credential contents.
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { relative, join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const skip = new Set(['.git', 'node_modules', 'coverage', 'test-results']);
const forbidden = /^(?:\.env(?:\..*)?|\.key|\.npmrc|\.pypirc|\.DS_Store|credentials(?:\..*)?|id_rsa|id_ed25519)$|\.(?:pem|p12|key|log|safetensors|gguf)$/i;
const rules = [
  ['provider key', /\bapikey_[a-f0-9]{20,}/i],
  ['secret token', /\b(?:sk-(?:proj-)?|gh[pousr]_)[a-zA-Z0-9_-]{24,}/],
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['absolute home path', /\/(?:Users|home)\/[a-zA-Z0-9_.-]+\//],
  ['credential in URL', /https?:\/\/[^\s"'<>/]+:[^\s"'<>/]+@/],
];
const problems = [];
let files = 0;
async function scan(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    const path = join(directory, entry.name), name = relative(root, path);
    if (entry.isSymbolicLink()) { problems.push(`${name}: symbolic links are not expected in this repository`); continue; }
    if (entry.isDirectory()) {
      if (['data', 'logs', '.venv', '.cache'].includes(entry.name)) problems.push(`${name}: runtime directory`);
      else await scan(path);
      continue;
    }
    files++;
    if (forbidden.test(entry.name)) { problems.push(`${name}: private or generated file`); continue; }
    if (!/\.(?:mjs|js|json|html|css|md|txt|yml|yaml|svg)$/.test(name)) continue;
    // The regression suite intentionally contains URL rejection fixtures.
    const text = await readFile(path, 'utf8');
    for (const [rule, pattern] of rules) {
      if (rule === 'credential in URL' && name.startsWith('test/')) continue;
      if (pattern.test(text)) problems.push(`${name}: ${rule}`);
    }
  }
}
await scan(root);
if (problems.length) { console.error(problems.join('\n')); process.exitCode = 1; }
else console.log(`Repository check passed: ${files} files; no matching secrets or machine-specific files.`);
