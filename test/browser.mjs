// Real-browser regression checks; no npm browser dependency or live model calls.
import assert from 'node:assert/strict';
import { access, readdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startFixture } from './helpers.mjs';
import { launchBrowser } from './browser-driver.mjs';

const cache = join(homedir(), 'Library/Caches/ms-playwright');
const cached = (await readdir(cache).catch(() => [])).filter(name => name.startsWith('chromium_headless_shell-')).sort().reverse();
const candidates = [process.env.BROWSER_BIN, ...cached.map(name => join(cache, name, 'chrome-headless-shell-mac-arm64/chrome-headless-shell')),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/chromium', '/usr/bin/google-chrome', '/usr/bin/chromium-browser'].filter(Boolean);
let executable;
for (const candidate of candidates) { try { await access(candidate); executable = candidate; break; } catch {} }
if (!executable) throw new Error('Install Chromium/Chrome or set BROWSER_BIN to its executable, then rerun npm run test:browser.');

const fixture = await startFixture();
let browser, checks = 0;
const pageErrors = [];
try {
  console.log(`Browser checks: Node ${process.version} on ${process.platform}/${process.arch}; ${executable}`);
  browser = await launchBrowser(executable, join(fixture.directory, 'browser'), {
    onEvent: message => { if (message.method === 'Runtime.exceptionThrown') pageErrors.push(message.params.exceptionDetails); },
  });
  const { cdp, sessionId, version } = browser;
  console.log(`Browser ready: ${version.product}; protocol ${version.protocolVersion}`);
  const evaluate = async (expression, targetSession = sessionId) => {
    const result = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, targetSession);
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const until = async (expression, targetSession = sessionId) => {
    const deadline = Date.now() + 10000;
    while (!(await evaluate(expression, targetSession))) { if (Date.now() > deadline) throw new Error(`Timed out: ${expression}`); await delay(25); }
  };
  const set = (selector, value, event = 'input', targetSession = sessionId) => evaluate(`(() => { const input = document.querySelector(${JSON.stringify(selector)}); input.value = ${JSON.stringify(value)}; input.dispatchEvent(new Event(${JSON.stringify(event)}, { bubbles: true })); })()`, targetSession);
  const click = (selector, targetSession = sessionId) => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`, targetSession);
  const read = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).value`);
  const openConnection = async action => {
    await evaluate('document.querySelector("#endpoint").focus()');
    await set('#endpoint', action, 'change'); await until('document.querySelector("#connections-dialog").open');
  };
  const closeConnection = () => click('#connections-dialog button[aria-label="Close endpoint settings"]');
  const ready = (targetSession = sessionId) => until('document.querySelector(".instructions-input") && !document.querySelector("#new-scenario").disabled', targetSession);
  const reload = async () => { const old = await evaluate('performance.timeOrigin'); await cdp('Page.reload', {}, sessionId); await until(`performance.timeOrigin !== ${old}`); await ready(); };
  const check = async (name, fn) => { await fn(); checks++; console.log(`PASS ${name}`); };
  await cdp('Runtime.enable', {}, sessionId); await cdp('Page.enable', {}, sessionId);
  await cdp('Page.addScriptToEvaluateOnNewDocument', { source: 'window.confirm = () => true;' }, sessionId);
  await cdp('Page.navigate', { url: fixture.url }, sessionId); await ready();

  let customId;
  await check('clean first visit has independent branding, examples, and no configured private endpoint', async () => {
    assert.equal(await evaluate('document.title'), 'Decision Model Playground');
    assert.equal(await evaluate('document.querySelectorAll("#endpoint option[data-endpoint]").length'), 1);
    assert.equal(await read('#endpoint'), 'typesafe');
    assert.equal(await evaluate('document.querySelector("#run-button").disabled'), true);
    assert.equal(await evaluate('document.querySelectorAll("[id*=llm]").length'), 0);
    assert.equal(await evaluate('document.querySelector("#connections-button")'), null);
    assert.equal(await evaluate('document.querySelectorAll("#examples button").length'), 5);
    if (process.env.PREVIEW_PATH) {
      await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 930, deviceScaleFactor: 1, mobile: false }, sessionId);
      const { data } = await cdp('Page.captureScreenshot', { format: 'png' }, sessionId);
      await writeFile(process.env.PREVIEW_PATH, Buffer.from(data, 'base64'));
    }
  });

  await check('the endpoint menu adds and selects a connection, validates URLs, and survives refresh', async () => {
    await openConnection(':add');
    assert.equal(await read('#endpoint'), 'typesafe');
    assert.equal(await evaluate('document.activeElement.id'), 'connection-name');
    assert.equal(await evaluate('document.querySelector("#connection-form").hidden'), false);
    await set('#connection-name', 'My test endpoint'); await set('#connection-url', 'https://user:password@example.com'); await set('#connection-model', 'fixture-model');
    await evaluate('document.querySelector("#connection-form").requestSubmit()');
    await until('document.querySelector("#connection-error").textContent.includes("credentials")');
    assert.equal(await read('#endpoint'), 'typesafe');
    await set('#connection-url', fixture.providerUrl + '/v1/systemone');
    await evaluate('document.querySelector("#connection-form").requestSubmit()');
    await until('document.querySelectorAll("#endpoint option[data-endpoint]").length === 2 && !document.querySelector("#connections-dialog").open');
    customId = await read('#endpoint'); assert.notEqual(customId, 'typesafe');
    assert.equal(await evaluate('document.querySelector("#run-button").disabled'), false);
    await delay(300); await reload(); assert.equal(await read('#endpoint'), customId);
    await click('#check-button'); await until('document.querySelector("#connection-status").textContent.startsWith("OK")');
  });

  await check('menu actions preserve the active endpoint and draft; Cancel and Escape restore focus', async () => {
    const state = await read('#state-input'), requestCount = fixture.calls.length;
    await openConnection(':add'); await set('#connection-name', 'Discard this'); await click('#cancel-connection');
    await until('document.activeElement.id === "endpoint"');
    assert.equal(await read('#endpoint'), customId); assert.equal(await read('#state-input'), state);
    assert.equal(await evaluate('localStorage.getItem("decision-model-playground.endpoint.v2")'), customId);
    await openConnection(':settings');
    assert.equal(await evaluate('document.querySelectorAll(".key-form").length'), 1);
    assert.equal(await evaluate('document.querySelector(".key-form").dataset.keyEndpoint'), customId);
    assert.equal(await evaluate('document.querySelector("#connection-form").hidden'), true);
    assert.equal(await evaluate('document.querySelector(".connection-details code").textContent'), fixture.providerUrl);
    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, sessionId);
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, sessionId);
    await until('!document.querySelector("#connections-dialog").open && document.activeElement.id === "endpoint"');
    assert.equal(await read('#endpoint'), customId); assert.equal(fixture.calls.length, requestCount);
    await reload(); assert.equal(await read('#endpoint'), customId); assert.equal(await read('#state-input'), state);
  });

  await check('all three decision types render and history stays in this browser', async () => {
    await click('#run-button'); await until('document.querySelectorAll(".answer-card").length === 3');
    await until('document.querySelector("#history-count").textContent === "1"');
    assert.equal(fixture.calls.at(-1).authorization, undefined);
    await reload(); assert.equal(await evaluate('document.querySelector("#history-count").textContent'), '1');
    await click('.history-row'); assert.equal(await evaluate('document.querySelectorAll(".answer-card").length'), 3);
  });

  await check('text, Unicode JSON paste, duplicate keys, and question-type drafts work', async () => {
    await click('#new-scenario'); await set('#state-input', 'Hello');
    await set('.question-type', 'choice', 'change');
    await set('.criteria-input', '{\n\u00a0"little":"A little",\n\u00a0"some":"Some breadth",\n\u00a0"a_lot":"A lot"\n}');
    assert.equal(await evaluate('document.querySelector("#run-button").disabled'), false);
    await click('#format-button'); const options = await read('.criteria-input');
    assert.equal(JSON.parse(options).a_lot, 'A lot');
    await set('.question-type', 'score', 'change'); await set('.criteria-input', '["Low", "High"]');
    await set('.question-type', 'choice', 'change'); assert.equal(await read('.criteria-input'), options);
    await set('.criteria-input', '{"same":null,"same":null}');
    assert.equal(await evaluate('document.querySelector("#run-button").disabled'), true);
    await set('.criteria-input', options); await click('#json-tab'); await click('#builder-tab');
    assert.equal(await read('#state-input'), 'Hello');
  });

  await check('save, reload, copy, export, and import preserve portable scenarios', async () => {
    await click('#save-button'); await set('#scenario-title', 'A saved experiment');
    await evaluate('document.querySelector("#save-form").requestSubmit()'); await until('!document.querySelector("#save-dialog").open');
    assert.equal(await evaluate('document.querySelectorAll("[data-saved]").length'), 1);
    await reload(); assert.equal(await evaluate('document.querySelector("#scenario-heading").textContent'), 'A saved experiment');
    await click('#save-button'); await click('#save-copy'); await until('!document.querySelector("#save-dialog").open');
    assert.equal(await evaluate('document.querySelectorAll("[data-saved]").length'), 2);
    await evaluate('window.__exports = []; URL.createObjectURL = blob => { window.__exports.push(blob); return "blob:test"; }; HTMLAnchorElement.prototype.click = () => {};');
    await click('#export-button');
    const document = JSON.parse(await evaluate('window.__exports.at(-1).text()'));
    assert.equal(document.version, 1); assert.equal(document.model, undefined); assert.equal(document.endpoint, undefined);
    await evaluate(`(() => { const transfer = new DataTransfer(); transfer.items.add(new File([${JSON.stringify(JSON.stringify(document))}], 'scenario.json', { type: 'application/json' })); const input = window.document.querySelector('#import-file'); input.files = transfer.files; input.dispatchEvent(new Event('change')); })()`);
    await until('document.querySelector("#toast").textContent.includes("imported")');
  });

  await check('TypeSafe keys survive refresh but do not enter history, scenarios or another browser', async () => {
    await set('#endpoint', 'typesafe', 'change'); await click('#key-button'); await set('#key-typesafe', 'test-browser-A');
    await click('[data-key-endpoint="typesafe"] button[type="submit"]');
    assert.equal(await evaluate('document.querySelector("#connections-dialog").open'), false);
    assert.equal(await evaluate('document.querySelector("#key-button").hidden'), true);
    await click('#run-button'); await until('document.querySelector(".answer-card.choice") !== null');
    assert.equal(fixture.calls.at(-1).authorization, 'Bearer test-browser-A');
    await reload(); assert.equal(await evaluate('document.querySelector("#run-button").disabled'), false);
    const snapshot = await evaluate('import("/workspace.js").then(async ({ openWorkspace }) => (await openWorkspace()).snapshot())');
    assert.ok(!JSON.stringify(snapshot).includes('test-browser-A'));
    assert.equal(await evaluate('JSON.stringify(localStorage).includes("test-browser-A")'), false);
    const { browserContextId } = await cdp('Target.createBrowserContext');
    const { targetId: separate } = await cdp('Target.createTarget', { url: 'about:blank', browserContextId });
    const { sessionId: separateSession } = await cdp('Target.attachToTarget', { targetId: separate, flatten: true });
    await cdp('Page.navigate', { url: fixture.url }, separateSession); await ready(separateSession);
    assert.equal(await evaluate('document.querySelector("#run-button").disabled && document.querySelectorAll("#endpoint option[data-endpoint]").length === 1 && document.querySelectorAll("[data-saved]").length === 0', separateSession), true);
    await cdp('Target.disposeBrowserContext', { browserContextId });
  });

  await check('switching endpoints never forwards the TypeSafe key; custom keys have their own slot', async () => {
    await set('#endpoint', customId, 'change'); await click('#run-button'); await until('document.querySelector(".answer-card.choice") !== null');
    assert.equal(fixture.calls.at(-1).authorization, undefined);
    await openConnection(':settings'); await set(`#key-${customId}`, 'test-custom-key');
    await click(`[data-key-endpoint="${customId}"] button[type="submit"]`);
    await click('#run-button'); await until('document.querySelector(".answer-card.choice") !== null');
    assert.equal(fixture.calls.at(-1).authorization, 'Bearer test-custom-key');
    await set('#endpoint', 'typesafe', 'change'); await openConnection(':settings'); await click('[data-key-endpoint="typesafe"] .remove-key');
    await closeConnection(); assert.equal(await evaluate('document.querySelector("#run-button").disabled'), true);
    await reload(); await set('#endpoint', 'typesafe', 'change'); assert.equal(await evaluate('document.querySelector("#run-button").disabled'), true);
  });

  await check('malformed responses and cancellation recover while keeping edits', async () => {
    await set('#endpoint', customId, 'change'); fixture.mode = 'malformed';
    await click('#run-button'); await until('!document.querySelector("#global-error").hidden');
    assert.match(await evaluate('document.querySelector("#error-message").textContent'), /Invalid provider response/);
    fixture.mode = 'ok'; fixture.delayMs = 600;
    await click('#run-button'); await until('document.querySelector("#run-button").textContent.includes("Cancel")');
    await set('#state-input', 'Edited while running'); await click('#run-button');
    await until('!document.querySelector("#run-button").textContent.includes("Cancel")');
    assert.equal(await read('#state-input'), 'Edited while running'); fixture.delayMs = 0;
    await delay(100); await click('#run-button'); await until('document.querySelector(".answer-card.choice") !== null');
  });

  await check('IndexedDB writes are atomic under concurrent saves and retain only 30 runs', async () => {
    const result = await evaluate(`(async () => {
      const { openWorkspace } = await import('/workspace.js'); const store = await openWorkspace();
      const original = await store.saveScenario({ id:'concurrent-record', title:'Original', state:'record', questions:{ q:{type:'noul',instructions:'Is it a record?'} } }, null);
      const results = await Promise.allSettled(['First', 'Second'].map(title => store.saveScenario({...original,title}, original.updatedAt)));
      const run = (await store.snapshot()).runs[0];
      await Promise.all(Array.from({length:35}, (_,i) => store.addRun({...run,id:'stress-'+i,createdAt:new Date(Date.now()+i).toISOString()})));
      return { statuses: results.map(item => item.status), count:(await store.snapshot()).runs.length };
    })()`);
    assert.equal(result.statuses.filter(status => status === 'fulfilled').length, 1);
    assert.equal(result.count, 30);
  });

  await check('unavailable tab storage still allows a key for the current page', async () => {
    await evaluate('Storage.prototype.setItem = () => { throw new DOMException("Blocked", "QuotaExceededError"); };');
    await set('#endpoint', 'typesafe', 'change'); await click('#key-button'); await set('#key-typesafe', 'test-browser-B');
    await click('[data-key-endpoint="typesafe"] button[type="submit"]');
    assert.match(await evaluate('document.querySelector("#toast").textContent'), /enter it again/);
    await click('#run-button');
    await until('document.querySelector(".answer-card.choice") !== null');
    assert.equal(fixture.calls.at(-1).authorization, 'Bearer test-browser-B');
    await reload(); await set('#endpoint', 'typesafe', 'change'); assert.equal(await evaluate('document.querySelector("#run-button").disabled'), true);
  });

  await check('mobile and desktop layouts fit without horizontal overflow', async () => {
    for (const width of [390, 760, 1440]) {
      await cdp('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);
      assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth + 1'), true, `Width ${width}`);
      for (const action of [':add', ':settings']) {
        await openConnection(action);
        assert.equal(await evaluate('document.querySelector("#connections-dialog").getBoundingClientRect().right <= innerWidth'), true);
        assert.equal(await evaluate('document.querySelector("#connections-dialog").scrollWidth <= document.querySelector("#connections-dialog").clientWidth'), true);
        await closeConnection();
      }
    }
  });

  await check('deleting the selected endpoint forgets its key and persists a valid fallback', async () => {
    await set('#endpoint', customId, 'change'); await openConnection(':settings');
    assert.equal(await evaluate('document.querySelectorAll(".key-form").length'), 1);
    await click('.delete-connection'); await until('!document.querySelector("#connections-dialog").open');
    assert.equal(await read('#endpoint'), 'typesafe');
    assert.equal(await evaluate('document.querySelector("#run-button").disabled'), true);
    assert.equal(await evaluate('JSON.stringify(sessionStorage).includes("test-custom-key")'), false);
    await reload(); assert.equal(await read('#endpoint'), 'typesafe');
    assert.equal(await evaluate('document.querySelectorAll("#endpoint option[data-endpoint]").length'), 1);
  });
  assert.deepEqual(pageErrors, []);
  console.log(`\n${checks} browser checks passed.`);
} finally {
  try { await browser?.close(); } finally { await fixture.close(); }
}
