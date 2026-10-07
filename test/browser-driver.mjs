import { spawn } from 'node:child_process';
import { stop } from './helpers.mjs';

// Chrome's first page can take much longer to start than an ordinary CDP command
// on a cold CI runner. Keep startup bounded separately from the actual UI checks.
export async function launchBrowser(executable, profile, {
  onEvent = () => {}, startupTimeoutMs = 60000, commandTimeoutMs = 30000, spawnProcess = spawn,
} = {}) {
  const child = spawnProcess(executable, [
    '--headless', '--remote-debugging-pipe', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--enable-automation',
    '--disable-background-networking', '--disable-component-update', '--disable-extensions',
    '--disable-dev-shm-usage', '--disable-search-engine-choice-screen',
    '--password-store=basic', '--use-mock-keychain', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  let sequence = 0, buffer = '', stderr = '', failure;
  const fail = message => {
    failure ??= new Error(`${message}${stderr.trim() ? `\nChrome stderr:\n${stderr.trim()}` : ''}`);
    for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(failure); }
    pending.clear();
  };
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8000); });
  child.on('error', cause => fail(`Could not start Chrome (${executable}): ${cause.message}`));
  child.on('exit', (code, signal) => fail(`Chrome exited (${signal || `code ${code}`}).`));
  child.stdio[3].on('error', cause => fail(`Chrome command pipe failed: ${cause.message}`));
  child.stdio[4].on('error', cause => fail(`Chrome response pipe failed: ${cause.message}`));
  child.stdio[4].on('end', () => fail('Chrome closed its response pipe.'));
  // Decode UTF-8 across pipe chunks before splitting CDP's NUL-delimited frames.
  child.stdio[4].setEncoding('utf8');
  child.stdio[4].on('data', chunk => {
    buffer += chunk;
    try {
      for (let end; (end = buffer.indexOf('\0')) >= 0;) {
        const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
        const request = pending.get(message.id);
        if (request) {
          pending.delete(message.id); clearTimeout(request.timer);
          message.error ? request.reject(new Error(`Chrome ${request.method}: ${JSON.stringify(message.error)}`)) : request.resolve(message.result);
        } else if (message.method) onEvent(message);
      }
    } catch (cause) { fail(`Invalid Chrome protocol message: ${cause.message}`); }
  });
  const cdp = (method, params = {}, sessionId, timeoutMs = commandTimeoutMs) => new Promise((resolve, reject) => {
    if (failure) { reject(failure); return; }
    const id = ++sequence;
    const timer = setTimeout(() => fail(`Chrome timed out during ${method} after ${timeoutMs} ms.`), timeoutMs);
    pending.set(id, { method, resolve, reject, timer });
    child.stdio[3].write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
  });
  const close = async () => { fail('Chrome connection closed.'); await stop(child); };
  try {
    const deadline = Date.now() + startupTimeoutMs;
    const startup = (method, params) => cdp(method, params, undefined, Math.max(1, deadline - Date.now()));
    // Wait for Chrome to answer before asking it to start a renderer.
    const version = await startup('Browser.getVersion');
    const { targetId } = await startup('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await startup('Target.attachToTarget', { targetId, flatten: true });
    return { cdp, sessionId, version, close };
  } catch (cause) { await close(); throw cause; }
}
