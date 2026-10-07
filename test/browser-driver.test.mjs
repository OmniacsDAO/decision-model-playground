import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import test from 'node:test';
import { launchBrowser } from './browser-driver.mjs';

function fakeChrome(handle) {
  const child = new EventEmitter(), commands = [];
  child.exitCode = null; child.signalCode = null;
  child.stderr = new PassThrough();
  child.stdio = [null, null, child.stderr, new Writable({
    write(chunk, encoding, done) {
      const command = JSON.parse(chunk.toString().slice(0, -1)); commands.push(command.method);
      queueMicrotask(() => handle(command, reply, child)); done();
    },
  }), new PassThrough()];
  const reply = (command, result) => child.stdio[4].write(JSON.stringify({ id: command.id, result }) + '\0');
  child.kill = signal => {
    child.signalCode = signal;
    queueMicrotask(() => { child.emit('exit', null, signal); child.stdio[4].end(); child.emit('close', null, signal); });
    return true;
  };
  return { child, commands, spawnProcess: () => child };
}
const response = method => ({
  'Browser.getVersion': { product: 'TestChrome', protocolVersion: '1.3' },
  'Target.createTarget': { targetId: 'test-page' },
  'Target.attachToTarget': { sessionId: 'test-session' },
}[method] || {});

test('slow Chrome startup has its own deadline and waits for readiness before creating a page', async () => {
  const fake = fakeChrome((command, reply) => {
    if (command.method === 'Browser.getVersion' || command.method === 'Target.createTarget') {
      setTimeout(() => reply(command, response(command.method)), 120);
    } else reply(command, response(command.method));
  });
  const browser = await launchBrowser('fake-chrome', 'unused-profile', { ...fake, startupTimeoutMs: 2000, commandTimeoutMs: 40 });
  try {
    assert.deepEqual(fake.commands, ['Browser.getVersion', 'Target.createTarget', 'Target.attachToTarget']);
    assert.equal(browser.sessionId, 'test-session');
    await browser.cdp('Runtime.enable', {}, browser.sessionId);
  } finally { await browser.close(); }
  assert.equal(fake.child.signalCode, 'SIGTERM');
});

test('a stuck first renderer fails within the startup budget and cleans up Chrome', async () => {
  const fake = fakeChrome((command, reply, child) => {
    if (command.method === 'Browser.getVersion') reply(command, response(command.method));
    else child.stderr.write('Renderer did not start\n');
  });
  await assert.rejects(launchBrowser('fake-chrome', 'unused-profile', { ...fake, startupTimeoutMs: 80 }), /Target.createTarget.*\nChrome stderr:\nRenderer did not start/);
  assert.equal(fake.child.signalCode, 'SIGTERM');
});

test('browser crashes reject pending commands immediately with the exit status and stderr', async () => {
  const fake = fakeChrome((command, reply, child) => {
    if (command.method !== 'Runtime.evaluate') reply(command, response(command.method));
    else {
      child.stderr.write('Renderer crashed\n'); child.exitCode = 17;
      child.emit('exit', 17, null); child.stdio[4].end(); child.emit('close', 17, null);
    }
  });
  const browser = await launchBrowser('fake-chrome', 'unused-profile', fake);
  try {
    await assert.rejects(browser.cdp('Runtime.evaluate'), /Chrome exited \(code 17\).*\nChrome stderr:\nRenderer crashed/);
    await assert.rejects(browser.cdp('Runtime.evaluate'), /Chrome exited/);
  } finally { await browser.close(); }
});

test('normal commands retain a deadline after a successful launch', async () => {
  const fake = fakeChrome((command, reply) => {
    if (command.method !== 'Runtime.evaluate') reply(command, response(command.method));
  });
  const browser = await launchBrowser('fake-chrome', 'unused-profile', { ...fake, commandTimeoutMs: 40 });
  try { await assert.rejects(browser.cdp('Runtime.evaluate'), /Runtime.evaluate after 40 ms/); }
  finally { await browser.close(); }
});

test('CDP preserves Unicode when a pipe splits a UTF-8 character', async () => {
  const fake = fakeChrome((command, reply, child) => {
    if (command.method !== 'Runtime.evaluate') reply(command, response(command.method));
    else {
      const bytes = Buffer.from(JSON.stringify({ id: command.id, result: { text: 'café 🍎' } }) + '\0');
      const split = bytes.indexOf(Buffer.from('🍎')) + 1;
      child.stdio[4].write(bytes.subarray(0, split)); child.stdio[4].write(bytes.subarray(split));
    }
  });
  const browser = await launchBrowser('fake-chrome', 'unused-profile', fake);
  try { assert.deepEqual(await browser.cdp('Runtime.evaluate'), { text: 'café 🍎' }); }
  finally { await browser.close(); }
});

test('a missing browser executable reports the launch failure instead of waiting for a timeout', async () => {
  await assert.rejects(launchBrowser('decision-playground-missing-browser-binary', 'unused-profile'), /Could not start Chrome.*ENOENT/);
});
