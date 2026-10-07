import { scenarioDocument, validateRequest, isObject, selectEndpointId, parseStateInput, formatStateInput, parseJsonInput, validApiKey } from './contract.js';
import { openWorkspace } from './workspace.js';
import { TYPESAFE, normalizeConnection } from './connections.js';

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const pretty = value => JSON.stringify(value, null, 2);
const pct = value => `${(value * 100).toFixed(1)}%`;
const display = value => typeof value === 'string' ? value : JSON.stringify(value);
const defaultCriteria = type => type === 'choice' ? { option_a: 'Describe the first option', option_b: 'Describe the second option' } : type === 'score' ? ['Low', 'Medium', 'High'] : undefined;
const DRAFT_KEY = 'decision-model-playground.draft.v1';
const ENDPOINT_KEY = 'decision-model-playground.endpoint.v2';
const narrowScreen = window.matchMedia('(max-width: 760px)');
let workspace = { endpoints: [], examples: [], scenarios: [], runs: [] };
let store, relayToken = '', selectedEndpointId = '';
let current = { title: 'Untitled scenario', description: '' };
let mode = 'builder', dirty = false, activeRun = null, running = null, toastTimer;
const connectionState = new Map();
const browserKeys = new Map();
const keySlot = selected => `decision-model-playground.key.v1.${selected.id}@${selected.baseUrl}`;
const browserKeyFor = selected => selected?.browserKey ? browserKeys.get(keySlot(selected)) || '' : '';
const connectionReady = selected => Boolean(selected) && (!selected.needsKey || Boolean(browserKeyFor(selected)));
const credentialHeaders = selected => browserKeyFor(selected) ? { [selected.kind === 'typesafe' ? 'x-typesafe-api-key' : 'x-endpoint-api-key']: browserKeyFor(selected) } : {};
let draftTimer, runTimer, storageWarning = false, workspaceReady = false, saving = false, saveDraft = null, saveAttempt = null, connectionSaving = false;

function newScenarioId() {
  // getRandomValues also works on a plain HTTP LAN address.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  const hex = [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function toast(message) {
  clearTimeout(toastTimer); $('#toast').textContent = message; $('#toast').hidden = false;
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 4500);
}
function error(message = '') { $('#error-message').textContent = message; $('#global-error').hidden = !message; }
async function api(path, options = {}) {
  const { signal, timeoutMs = 15000, ...init } = options;
  const controller = new AbortController();
  let timedOut = false;
  const cancel = () => controller.abort();
  if (signal?.aborted) cancel();
  signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  try {
    const response = await fetch(path, { ...init, signal: controller.signal, headers: { 'content-type': 'application/json', 'x-playground-token': relayToken, ...init.headers } });
    let value;
    try { value = await response.json(); }
    catch (cause) {
      if (controller.signal.aborted) throw cause;
      const source = /cloudflare/i.test(response.headers.get('server') || '') ? 'Cloudflare' : 'The playground';
      const content = response.headers.get('content-type')?.includes('text/html') ? 'an HTML page' : 'an unreadable response';
      const hint = response.status >= 500 ? 'Check the playground server and its proxy or tunnel.' : 'Check the playground URL and proxy routing.';
      throw new Error(`${source} returned ${content} (HTTP ${response.status}). ${hint}`);
    }
    if (!isObject(value)) throw new Error(`Unexpected playground response (HTTP ${response.status}). Check the playground URL.`);
    if (!response.ok) throw new Error(value.error || `Request failed (${response.status}).`);
    return value;
  } catch (cause) {
    if (timedOut) throw new Error('The playground request timed out. It may still finish; check the connection before retrying.');
    if (cause instanceof TypeError && !controller.signal.aborted) throw new Error('Cannot reach the playground. Check the server or connection, then try again.');
    throw cause;
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
}
const post = (path, data, options = {}) => api(path, { method: 'POST', body: JSON.stringify(data), ...options });
const endpoint = () => workspace.endpoints.find(item => item.id === selectedEndpointId);
const connections = () => workspace.endpoints;
function renderEndpointOptions(preferred = selectedEndpointId) {
  const options = connections().map(item => `<option value="${escape(item.id)}" data-endpoint>${escape(item.name)}</option>`).join('');
  $('#endpoint').innerHTML = `<optgroup label="Endpoints">${options}</optgroup><optgroup label="Manage"><option value=":add">＋ Add endpoint…</option><option value=":settings">Endpoint settings…</option></optgroup>`;
  selectedEndpointId = selectEndpointId(connections(), preferred);
  $('#endpoint').value = selectedEndpointId;
}
function selectEndpoint(id) {
  selectedEndpointId = selectEndpointId(connections(), id);
  $('#endpoint').value = selectedEndpointId;
  try { localStorage.setItem(ENDPOINT_KEY, selectedEndpointId); } catch {}
  error(); renderEndpoint();
}
function parse(text, label) { try { return parseJsonInput(text); } catch (error) { throw new Error(`${label}: ${error.message}`); } }
function readBuilder() {
  const state = parseStateInput($('#state-input').value);
  const entries = $$('.question-card').map(card => {
    const id = card.querySelector('.question-id').value.trim();
    const type = card.querySelector('.question-type').value;
    const input = card.querySelector('.instructions-input');
    const instructions = parseStateInput(input.value);
    const criteriaText = card.querySelector('.criteria-input').value.trim();
    const field = type === 'choice' ? 'options' : type === 'score' ? 'levels' : 'criteria';
    return [id, { type, instructions, ...(criteriaText ? { criteria: parse(criteriaText, `${id} ${field}`) } : {}) }];
  });
  if (new Set(entries.map(([id]) => id)).size !== entries.length) throw new Error('Question IDs must be unique.');
  return { state, questions: Object.fromEntries(entries) };
}
function readRequest(checkEndpoint = false) {
  const request = mode === 'json' ? parse($('#request-json').value, 'Request JSON') : readBuilder();
  return validateRequest(request, checkEndpoint ? endpoint() || {} : {});
}
function questionCard(id, question, open = false) {
  const card = document.createElement('details'); card.className = 'question-card'; card.open = open;
  card.dataset.type = question.type; card.criteriaDrafts = {};
  const instructions = formatStateInput(question.instructions);
  card.innerHTML = `<summary><span class="question-name" title="${escape(id)}">${escape(id)}</span><span class="question-preview" title="${escape(display(question.instructions))}">${escape(display(question.instructions).slice(0, 130))}</span><span class="type-pill ${escape(question.type)}">${escape(question.type)}</span></summary>
    <div class="question-fields"><div class="question-top"><label><span class="field-label">Question ID</span><input class="question-id" value="${escape(id)}" spellcheck="false" maxlength="64"></label>
    <label><span class="field-label">Type</span><select class="question-type">${['noul', 'choice', 'score'].map(type => `<option ${type === question.type ? 'selected' : ''}>${type}</option>`).join('')}</select></label>
    <button class="icon-button remove-question" type="button" title="Remove question" aria-label="Remove question ${escape(id)}">×</button></div>
    <label><span class="field-label" title="Text or JSON, detected automatically">Instructions</span><textarea class="instructions-input" rows="2">${escape(instructions)}</textarea></label>
    <label><span class="field-label criteria-label"></span><textarea class="criteria-input" spellcheck="false" rows="${question.type === 'noul' ? 2 : 4}">${question.criteria === undefined ? '' : escape(pretty(question.criteria))}</textarea><span class="field-note criteria-hint"></span></label></div>`;
  updateCriteriaLabels(card);
  return card;
}
function updateCriteriaLabels(card) {
  const type = card.querySelector('.question-type').value;
  card.querySelector('.criteria-label').textContent = { noul: 'Criteria · optional JSON', choice: 'Options · JSON object', score: 'Levels · JSON array' }[type];
  card.querySelector('.criteria-hint').textContent = { noul: 'Optional: {"true": "What yes means", "false": "What no means"}', choice: 'Map each option name to a description. Use null for a bare label.', score: '2–10 descriptions, ordered from lowest to highest. Scores start at 0.' }[type];
  card.querySelector('.criteria-input').placeholder = type === 'noul' ? 'No extra criteria' : '';
}
function renderBuilder(request, preserveTypes = false) {
  const drafts = new Map(preserveTypes ? $$('.question-card').map(card => [card.querySelector('.question-id').value, card.criteriaDrafts]) : []);
  $('#state-input').value = formatStateInput(request.state);
  $('#questions').replaceChildren(...Object.entries(request.questions).map(([id, question]) => {
    const card = questionCard(id, question); card.criteriaDrafts = drafts.get(id) || {}; return card;
  }));
  updateCount();
}
function updateCount() {
  const stateText = $('#state-input').value, state = parseStateInput(stateText);
  $('#state-kind').textContent = Array.isArray(state) ? 'JSON array' : isObject(state) ? 'JSON object' : 'Text';
  $('#state-hint').textContent = typeof state === 'string' && /^[\[{]/.test(stateText.trimStart())
    ? 'This will be sent as text; it was not accepted as structured JSON.'
    : 'Text or JSON. Detected automatically.';
  let count = $$('.question-card').length;
  if (mode === 'json') { try { count = Object.keys(parseJsonInput($('#request-json').value).questions || {}).length; } catch { count = '?'; } }
  $('#question-count').textContent = count;
  const limit = endpoint()?.maxQuestions || 64;
  $('#add-question').disabled = !workspaceReady || Number(count) >= limit;
  $('#add-question').title = `Up to ${limit} questions on the selected endpoint`;
  let problem = '';
  if (workspaceReady && !running) { try { readRequest(true); } catch (cause) { problem = cause.message; } }
  const status = $('#request-status');
  status.textContent = running ? `Running · ${((performance.now() - running.started) / 1000).toFixed(1)}s` : !workspaceReady ? 'Workspace not ready' : problem || `${count}/${limit} questions · ${dirty ? 'edited' : 'ready'}`;
  status.title = status.textContent;
  status.classList.toggle('invalid', Boolean(problem) && !running);
  status.classList.toggle('running', Boolean(running));
  $('#run-button').disabled = !running && (!workspaceReady || !connectionReady(endpoint()) || Boolean(problem));
  $('#run-button').title = running ? 'Stop waiting for this run' : problem || 'Run decision (⌘ / Ctrl + Enter)';
  $('#save-button').disabled = !workspaceReady;
  $('#export-button').disabled = !workspaceReady;
  $('#format-button').disabled = !workspaceReady;
  $('#new-scenario').disabled = !workspaceReady;
  $('#import-button').disabled = !workspaceReady;
  $('#state-input').disabled = !workspaceReady;
  $('#request-json').disabled = !workspaceReady;
}
function renderLibrary() {
  const symbols = ['◈', '↗', '∿', '⑂', '✓'];
  const search = $('#scenario-search').value.trim().toLowerCase();
  const matches = item => `${item.title} ${item.description || ''} ${Object.keys(item.questions).join(' ')}`.toLowerCase().includes(search);
  const examples = workspace.examples.filter(matches), saved = workspace.scenarios.filter(matches);
  $('#example-count').textContent = String(workspace.examples.length).padStart(2, '0');
  $('#examples').innerHTML = examples.map(item => `<button class="scenario-item ${current.id === item.id ? 'active' : ''}" data-example="${escape(item.id)}" title="${escape(item.title)}" ${current.id === item.id ? 'aria-current="true"' : ''}><span class="scenario-symbol">${symbols[workspace.examples.indexOf(item) % symbols.length]}</span><span><strong>${escape(item.title)}</strong></span></button>`).join('') || '<p class="sidebar-empty">No matches.</p>';
  $('#saved-scenarios').innerHTML = saved.length ? saved.map(item => `<div class="saved-row"><button class="scenario-item ${current.id === item.id ? 'active' : ''}" data-saved="${escape(item.id)}" title="${escape(item.title)}" ${current.id === item.id ? 'aria-current="true"' : ''}><span class="scenario-symbol">◇</span><span><strong>${escape(item.title)}</strong></span></button><button class="icon-button delete-scenario" data-id="${escape(item.id)}" aria-label="Delete ${escape(item.title)}">×</button></div>`).join('') : `<p class="sidebar-empty">${search ? 'No matches.' : 'Save a scenario to keep it here.'}</p>`;
}
function setMode(next) {
  mode = next; $('#builder-view').hidden = next !== 'builder'; $('#json-view').hidden = next !== 'json';
  for (const tab of ['builder', 'json']) { $(`#${tab}-tab`).classList.toggle('active', tab === next); $(`#${tab}-tab`).setAttribute('aria-pressed', String(tab === next)); }
}
function loadScenario(scenario, { confirm = true } = {}) {
  if (saving) return false;
  if (running) { toast('Finish or cancel the current run before changing scenarios.'); return false; }
  if (confirm && dirty && !window.confirm('Replace the current unsaved edits? Save or export them first if you want to keep them.')) return false;
  current = structuredClone(scenario); dirty = false; activeRun = null; saveDraft = null; saveAttempt = null; error();
  $('#scenario-heading').textContent = current.title;
  $('#scenario-description').textContent = current.description || 'Add context and ask a question.';
  $('#scenario-category').textContent = (current.category || 'YOUR SCENARIO').toUpperCase();
  setMode('builder'); renderBuilder(current); $('#request-json').value = pretty({ state: current.state, questions: current.questions });
  renderLibrary(); renderResults(); persistDraft();
  if (narrowScreen.matches) setSidebar(false);
  return true;
}
function draftSnapshot() {
  return { current, mode, dirty, saveDraft, saveAttempt, state: $('#state-input').value, stateFormat: 'auto', raw: $('#request-json').value,
    questions: $$('.question-card').map(card => ({ id: card.querySelector('.question-id').value, type: card.querySelector('.question-type').value, instructions: card.querySelector('.instructions-input').value, instructionsFormat: 'auto', criteria: card.querySelector('.criteria-input').value, criteriaDrafts: card.criteriaDrafts, open: card.open })) };
}
function persistDraft() {
  $('#draft-status').textContent = dirty ? 'SAVING DRAFT…' : 'WORKSPACE READY';
  clearTimeout(draftTimer); draftTimer = setTimeout(() => {
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify(draftSnapshot())); $('#draft-status').textContent = dirty ? 'DRAFT SAVED IN BROWSER' : 'WORKSPACE READY'; }
    catch { $('#draft-status').textContent = 'DRAFT NOT SAVED'; if (!storageWarning) { toast('Browser draft storage is unavailable. Export JSON to keep a copy.'); storageWarning = true; } }
  }, 250);
}
function edited() { dirty = true; error(); updateCount(); markStale(); persistDraft(); }
function renderEndpoint() {
  const selected = endpoint();
  $('#model-name').textContent = selected?.model || 'No model';
  $('#model-name').title = selected ? `${selected.model} · ${selected.baseUrl}` : '';
  $('#endpoint').title = selected?.baseUrl || 'Choose or add an endpoint';
  const check = connectionState.get(selected?.id);
  $('#connection-status').textContent = check?.message || (connectionReady(selected) ? 'Check' : selected ? 'Key needed' : 'Offline');
  $('#connection-dot').className = `status-dot ${check?.status || 'neutral'}`;
  $('#check-button').disabled = !connectionReady(selected) || Boolean(check?.pending) || Boolean(running);
  $('#check-button').hidden = !connectionReady(selected);
  $('#key-button').hidden = !selected?.needsKey || Boolean(browserKeyFor(selected));
  $('#endpoint').disabled = Boolean(running) || !workspaceReady;
  updateCount(); markStale();
}
function markStale() {
  const target = $('#stale-note'); if (!target || !activeRun) return;
  let changed = true;
  try { changed = JSON.stringify(readRequest()) !== JSON.stringify({ state: activeRun.request.state, questions: activeRun.request.questions }); } catch {}
  const other = endpoint()?.id !== activeRun.endpoint.id;
  target.hidden = !changed && !other;
  target.textContent = changed ? 'Request changed · showing the previous run.' : 'Different endpoint selected · run again to compare.';
}
function probabilityBar(label, value, winner) {
  return `<div class="probability-row"><div class="probability-label ${winner ? 'winner' : ''}"><span>${escape(label)}</span><code>${pct(value)}</code></div><div class="probability-track"><div class="probability-fill ${winner ? 'winner' : ''}" style="width:${Math.max(0, Math.min(100, value * 100))}%"></div></div></div>`;
}
function answerCard(id, answer, question) {
  let content = '';
  if (answer.type === 'noul') {
    content = `<div class="answer-value">${pct(answer.noul)} <small>toward yes</small></div><div class="noul-track"><span style="width:${answer.noul * 100}%"></span></div><div class="noul-labels"><span>No · 0</span><span>0.5</span><span>Yes · 1</span></div>`;
  } else {
    const winner = answer.type === 'choice' ? answer.choice : Object.entries(answer.probabilities).reduce((best, item) => item[1] > best[1] ? item : best)[0];
    const levels = question?.criteria;
    content = answer.type === 'choice' ? `<div class="answer-value">${escape(answer.choice)}</div>` : `<div class="answer-value">${answer.score.toFixed(2)} <small>/ ${Array.isArray(levels) ? levels.length - 1 : Object.keys(answer.probabilities).length - 1}</small></div><p class="answer-description">Weighted level</p>`;
    content += Object.entries(answer.probabilities).map(([label, probability]) => {
      const description = answer.type === 'score' ? (answer.legend?.[label] ?? levels?.[Number(label)]) : null;
      return probabilityBar(description ? `${label} · ${display(description)}` : label, probability, label === winner);
    }).join('');
  }
  const metadata = [];
  if (typeof answer.confidence === 'number') metadata.push(`<span title="Reported by this model; not a guarantee of correctness">Confidence ${pct(answer.confidence)}</span>`);
  if (typeof answer.unknown_probability === 'number') metadata.push(`<span>Unknown ${pct(answer.unknown_probability)}</span>`);
  if (answer.abstained) metadata.push('<span class="abstained">Abstained · insufficient evidence</span>');
  return `<article class="answer-card ${escape(answer.type)}"><div class="answer-heading"><h4>${escape(id)}</h4><span class="type-pill ${escape(answer.type)}">${escape(answer.type)}</span></div>${content}${metadata.length ? `<div class="answer-meta">${metadata.join('')}</div>` : ''}${answer.calibration_version ? `<div class="calibration">cal: ${escape(answer.calibration_version)}</div>` : ''}</article>`;
}
const emptyResults = $('#results').innerHTML;
function renderResults() {
  $('#result-summary').hidden = !activeRun;
  $('#copy-response').disabled = !activeRun;
  if (!activeRun) {
    $('#results').innerHTML = emptyResults; $('#response-json').textContent = 'Awaiting response.';
    $('.results-footer').hidden = true;
    return;
  }
  const run = activeRun, usage = run.response.usage || {};
  $('#result-summary').innerHTML = `<dl class="result-metrics"><div><dt>API</dt><dd>${run.elapsedMs}<small> ms</small></dd></div><div><dt>QUESTIONS</dt><dd>${Object.keys(run.request.questions).length}</dd></div><div title="Provider-reported input tokens. Imajev counts the largest question pass, not a sum."><dt>TOKENS IN</dt><dd>${Number.isFinite(usage.input_tokens) ? usage.input_tokens : '—'}</dd></div></dl><div class="result-origin"><span class="status-dot good"></span><strong title="${escape(run.response.model)}">${escape(run.endpoint.name)} / ${escape(run.response.model)}</strong><time title="${escape(new Date(run.createdAt).toLocaleString())}">${new Date(run.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time></div><div class="stale-note" id="stale-note" hidden></div>`;
  $('#results').innerHTML = Object.entries(run.request.questions).map(([id, question]) => answerCard(id, run.response.answers[id], question)).join('');
  $('#response-json').textContent = pretty(run.response);
  $('.results-footer').hidden = false;
  $('.results-footer').textContent = 'Confidence is model-dependent. Unknown mass is shown separately.'; markStale();
}
function renderHistory() {
  $('#history-count').textContent = workspace.runs.length;
  const latest = workspace.runs[0];
  $('#history-latest').textContent = latest ? `${latest.title} · ${latest.elapsedMs} ms` : 'No runs yet';
  $('#clear-history').disabled = !workspace.runs.length;
  $('#history').innerHTML = workspace.runs.length ? `<div class="history-list">${workspace.runs.map(run => `<button class="history-row" data-run="${escape(run.id)}" title="Restore run from ${escape(new Date(run.createdAt).toLocaleString())}"><strong>${escape(run.title)}</strong><span>${escape(run.endpoint.name)}</span><code>${run.elapsedMs} ms ↗</code><time>${new Date(run.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></button>`).join('')}</div>` : '<p class="history-empty">No runs yet.</p>';
}
async function runDecision() {
  if (running) { running.controller.abort(); return; }
  if (!workspaceReady) return;
  try {
    error(); const selected = endpoint(); if (!connectionReady(selected)) throw new Error(selected?.needsKey ? 'Add your API key for this endpoint.' : 'Choose or add an endpoint using the endpoint menu.');
    const request = readRequest(true);
    const controller = new AbortController(); running = { controller, endpoint: selected, started: performance.now() };
    activeRun = null;
    $('#response-json').textContent = 'Waiting for the model…';
    $('#run-button').innerHTML = '<span aria-hidden="true">■</span> Cancel'; $('#run-button').classList.add('is-running');
    $('#copy-response').disabled = true;
    $('#results').innerHTML = `<div class="empty-state loading"><div class="console-line"><span class="console-prompt">❯</span> evaluating<span class="cursor" aria-hidden="true"></span></div><h4>${escape(selected.name)}</h4><p>${Object.keys(request.questions).length} questions sent. Waiting for the model.</p></div>`;
    $('.results-panel').setAttribute('aria-busy', 'true');
    $('.results-footer').hidden = false; $('.results-footer').textContent = 'Request in flight. You can keep editing.';
    $('#result-summary').hidden = true; renderEndpoint();
    runTimer = setInterval(updateCount, 200);
    const { run } = await post('/api/evaluate', { connection: selected, title: current.title, scenario: request }, { headers: credentialHeaders(selected), signal: controller.signal, timeoutMs: selected.timeoutMs + 10000 });
    if (controller.signal.aborted) throw new DOMException('Cancelled', 'AbortError');
    activeRun = run; workspace.runs = [run, ...workspace.runs].slice(0, 30);
    renderHistory(); renderResults();
    try { await store.addRun(run); } catch (cause) { toast(`Result received; history was not saved. ${cause.message}`); }
  } catch (cause) {
    if (cause.name === 'AbortError') toast('Stopped waiting. The model may still finish the request.');
    else error(cause.message);
    renderResults();
  } finally {
    clearInterval(runTimer); running = null;
    $('.results-panel').setAttribute('aria-busy', 'false');
    $('#run-button').classList.remove('is-running');
    $('#run-button').innerHTML = '<span aria-hidden="true">▶</span> Run <kbd>⌘ ↵</kbd>';
    renderEndpoint(); updateCount();
  }
}
function exportJson(value, name) {
  const url = URL.createObjectURL(new Blob([pretty(value)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function setSidebar(open) {
  document.body.classList.toggle('sidebar-open', open);
  $('#sidebar-toggle').setAttribute('aria-expanded', String(open));
}
$('#sidebar-toggle').addEventListener('click', () => setSidebar(!document.body.classList.contains('sidebar-open')));
narrowScreen.addEventListener('change', () => setSidebar(!narrowScreen.matches));
$('main').addEventListener('click', () => { if (narrowScreen.matches) setSidebar(false); });
$('#scenario-search').addEventListener('input', renderLibrary);
$('#dismiss-error').addEventListener('click', () => error());
$('#format-button').addEventListener('click', () => {
  try {
    const inputs = mode === 'json' ? [$('#request-json')] : [
      ...(typeof parseStateInput($('#state-input').value) !== 'string' ? [$('#state-input')] : []),
      ...$$('.instructions-input').filter(input => typeof parseStateInput(input.value) !== 'string'),
      ...$$('.criteria-input').filter(input => input.value.trim()),
    ];
    if (!inputs.length) { toast('No JSON fields to format.'); return; }
    // Parse every field first so an error cannot leave a partially formatted draft.
    const formatted = inputs.map(input => pretty(parse(input.value, 'JSON')));
    inputs.forEach((input, index) => { input.value = formatted[index]; });
    edited(); toast('JSON formatted.');
  } catch (cause) { error(cause.message); }
});
window.addEventListener('pagehide', () => {
  clearTimeout(draftTimer);
  if (workspaceReady) { try { localStorage.setItem(DRAFT_KEY, JSON.stringify(draftSnapshot())); } catch {} }
});

async function saveScenario(copy = false) {
  if (saving) return;
  saving = true;
  const controls = [...$('#save-form').querySelectorAll('button,input,textarea')];
  controls.forEach(control => { control.disabled = true; });
  try {
    $('#save-error').textContent = '';
    const document = scenarioDocument({ title: $('#scenario-title').value, description: $('#scenario-notes').value, ...readRequest() });
    const existing = workspace.scenarios.some(item => item.id === current.id);
    const fingerprint = JSON.stringify({ copy, baseId: current.id, document });
    if (saveAttempt?.fingerprint !== fingerprint) saveAttempt = { fingerprint, id: !copy && existing ? current.id : newScenarioId(), expectedUpdatedAt: !copy && existing ? current.updatedAt : null };
    persistDraft();
    const scenario = await store.saveScenario({ ...document, id: saveAttempt.id }, saveAttempt.expectedUpdatedAt);
    workspace.scenarios = [scenario, ...workspace.scenarios.filter(item => item.id !== scenario.id)];
    current = scenario; dirty = false; saveDraft = null; saveAttempt = null;
    $('#scenario-heading').textContent = current.title; $('#scenario-description').textContent = current.description;
    $('#scenario-category').textContent = 'YOUR SCENARIO';
    renderLibrary(); updateCount(); persistDraft(); $('#save-dialog').close(); toast('Scenario saved to your workspace.');
  } catch (cause) { $('#save-error').textContent = cause.message; }
  finally { saving = false; controls.forEach(control => { control.disabled = false; }); }
}
$('#run-button').addEventListener('click', runDecision);
document.addEventListener('keydown', event => {
  if (saving && event.key === 'Escape') { event.preventDefault(); return; }
  if (event.repeat || $('dialog[open]')) return;
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); runDecision(); }
  else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') { event.preventDefault(); $('#save-button').click(); }
  else if (event.key === '/' && !event.metaKey && !event.ctrlKey && !event.altKey && !event.target.closest('input,textarea,select,[contenteditable]')) { event.preventDefault(); setSidebar(true); $('#scenario-search').focus(); }
  else if (event.key === 'Escape' && narrowScreen.matches) setSidebar(false);
});
$('#endpoint').addEventListener('change', () => {
  const value = $('#endpoint').value;
  if (value === ':add' || value === ':settings') {
    // Menu actions never replace the active provider or its saved preference.
    $('#endpoint').value = selectedEndpointId;
    openConnection(value === ':add' ? 'add' : 'settings');
  } else selectEndpoint(value);
});
$('#check-button').addEventListener('click', async () => {
  const selected = endpoint(); if (!connectionReady(selected)) return;
  const keyAtStart = browserKeyFor(selected);
  error(); connectionState.set(selected.id, { pending: true, status: 'neutral', message: 'Checking…' }); renderEndpoint();
  try {
    const result = await post('/api/check', { connection: selected }, { headers: credentialHeaders(selected), timeoutMs: selected.timeoutMs + 5000 });
    if (browserKeyFor(selected) !== keyAtStart) return;
    connectionState.set(selected.id, { status: result.loaded === false ? 'bad' : 'good', message: result.loaded === false ? 'Not loaded' : `OK · ${result.elapsedMs} ms` });
    if (result.model !== selected.model && selected.kind === 'imajev') toast(`This server reports ${result.model}; the connection is configured as ${selected.model}.`);
  } catch (cause) { if (browserKeyFor(selected) === keyAtStart) { connectionState.set(selected.id, { status: 'bad', message: 'Failed' }); error(`${selected.name}: ${cause.message}`); } }
  finally { renderEndpoint(); }
});
function renderConnection() {
  const item = endpoint(); if (!item) return;
  $('#connection-heading').textContent = item.name;
  $('#connections-list').innerHTML = `<div class="connection-details"><code>${escape(item.baseUrl)}</code><p>${escape(item.model)} · ${item.maxQuestions} questions max</p>
    <form class="key-form" data-key-endpoint="${escape(item.id)}">
      <label class="field-label" for="key-${escape(item.id)}">${item.needsKey ? 'Your TypeSafe API key' : 'API key · optional'}</label>
      <div class="key-input-row"><input id="key-${escape(item.id)}" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="512" required placeholder="${browserKeyFor(item) ? 'Key set in this tab — paste to replace' : 'Paste a key for this endpoint'}"><button type="submit" class="button primary tiny">Use key</button>${browserKeyFor(item) ? '<button type="button" class="button quiet tiny remove-key">Remove key</button>' : ''}</div>
      <p class="error-text key-error" role="alert"></p>
    </form>${item.kind === 'typesafe' ? '' : `<div class="connection-actions"><button class="button quiet tiny delete-connection" data-id="${escape(item.id)}">Delete endpoint</button></div>`}</div>`;
}
const keyConnection = form => connections().find(item => item.id === form.dataset.keyEndpoint);
function openConnection(view = 'settings') {
  if (!workspaceReady || connectionSaving || (view === 'settings' && !endpoint())) return;
  const adding = view === 'add';
  $('#connection-form').hidden = !adding; $('#connections-list').hidden = adding;
  $('#connection-error').textContent = '';
  if (adding) {
    $('#connection-form').reset(); $('#connection-heading').textContent = 'Add endpoint';
    $('#connections-list').replaceChildren();
  } else renderConnection();
  $('#connection-note').textContent = adding ? 'Saved in this browser.' : 'Keys stay in this tab and are used only for this endpoint.';
  $('#connections-dialog').showModal();
  (adding ? $('#connection-name') : $(`#key-${endpoint().id}`))?.focus();
}
function setConnectionSaving(value) {
  connectionSaving = value; $('#connections-dialog').setAttribute('aria-busy', String(value));
  $$('#connections-dialog button, #connections-dialog input, #connections-dialog select').forEach(input => { input.disabled = value; });
}
function forgetKey(selected) {
  if (running?.endpoint.id === selected.id) running.controller.abort();
  browserKeys.delete(keySlot(selected)); connectionState.delete(selected.id);
  try { sessionStorage.removeItem(keySlot(selected)); }
  catch { toast('Key disabled here. Clear site data to remove the saved copy.'); }
}
$('#key-button').addEventListener('click', () => openConnection());
$('#cancel-connection').addEventListener('click', () => $('#connections-dialog').close());
$('#connections-dialog').addEventListener('cancel', event => { if (connectionSaving) event.preventDefault(); });
$('#connections-dialog').addEventListener('close', () => {
  $$('#connections-list input').forEach(input => { input.value = ''; });
  $('#endpoint').focus();
});
$('#connections-list').addEventListener('submit', event => {
  const form = event.target.closest('.key-form'); if (!form) return;
  event.preventDefault();
  const selected = keyConnection(form); if (!selected) return;
  const key = form.querySelector('input').value.trim();
  if (!validApiKey(key)) { form.querySelector('.key-error').textContent = 'Use a key of up to 512 characters without spaces.'; return; }
  if (running?.endpoint.id === selected.id) running.controller.abort();
  browserKeys.set(keySlot(selected), key);
  let remembered = true;
  try { sessionStorage.setItem(keySlot(selected), key); } catch { remembered = false; }
  connectionState.delete(selected.id); error(); renderEndpoint(); $('#connections-dialog').close();
  toast(remembered ? 'Key added for this tab.' : 'Key usable now; enter it again after refresh because tab storage is unavailable.');
});
$('#connections-list').addEventListener('click', async event => {
  const remove = event.target.closest('.remove-key');
  if (remove) { const selected = keyConnection(remove.closest('.key-form')); if (selected) { forgetKey(selected); renderConnection(); renderEndpoint(); $(`#key-${selected.id}`)?.focus(); } return; }
  const button = event.target.closest('.delete-connection');
  if (!button || !window.confirm('Delete this endpoint from this browser? Saved scenarios stay available.')) return;
  const selected = connections().find(item => item.id === button.dataset.id); if (!selected) return;
  setConnectionSaving(true);
  try {
    await store.deleteConnection(selected.id); forgetKey(selected);
    workspace.endpoints = workspace.endpoints.filter(item => item.id !== selected.id);
    renderEndpointOptions(); selectEndpoint(selectedEndpointId); $('#connections-dialog').close(); toast('Endpoint deleted.');
  } catch (cause) { toast(cause.message); }
  finally { setConnectionSaving(false); }
});
$('#connection-form').addEventListener('submit', async event => {
  event.preventDefault();
  const button = $('#connection-form button[type="submit"]'); if (button.disabled) return;
  setConnectionSaving(true); $('#connection-error').textContent = '';
  try {
    const connection = normalizeConnection({ id: newScenarioId(), name: $('#connection-name').value, baseUrl: $('#connection-url').value.trim(), model: $('#connection-model').value, kind: $('#connection-kind').value });
    const saved = await store.addConnection(connection); workspace.endpoints.push(saved);
    $('#connection-form').reset();
    renderEndpointOptions(running ? selectedEndpointId : saved.id); selectEndpoint(selectedEndpointId);
    $('#connections-dialog').close(); toast('Endpoint added and selected.');
  } catch (cause) { $('#connection-error').textContent = cause.message; }
  finally { setConnectionSaving(false); }
});
$('#examples').addEventListener('click', event => { const button = event.target.closest('[data-example]'); if (button) loadScenario(workspace.examples.find(item => item.id === button.dataset.example)); });
$('#saved-scenarios').addEventListener('click', async event => {
  const button = event.target.closest('[data-saved]');
  if (button) loadScenario(workspace.scenarios.find(item => item.id === button.dataset.saved));
  const remove = event.target.closest('.delete-scenario');
  if (remove && window.confirm('Delete this saved scenario? Existing run history will be kept.')) {
    try { await store.deleteScenario(remove.dataset.id); workspace.scenarios = workspace.scenarios.filter(item => item.id !== remove.dataset.id); renderLibrary(); toast('Scenario deleted.'); }
    catch (cause) { error(cause.message); }
  }
});
$('#new-scenario').addEventListener('click', () => loadScenario({ version: 1, title: 'Untitled scenario', description: '', state: '', questions: { decision: { type: 'noul', instructions: 'What would you like to know about this state?' } } }));
$('#questions').addEventListener('input', event => {
  const card = event.target.closest('.question-card'); if (!card) return;
  if (event.target.matches('.question-id')) { card.querySelector('.question-name').textContent = event.target.value; card.querySelector('.question-name').title = event.target.value; }
  if (event.target.matches('.instructions-input')) { card.querySelector('.question-preview').textContent = event.target.value.slice(0, 130); card.querySelector('.question-preview').title = event.target.value; }
  edited();
});
$('#questions').addEventListener('change', event => {
  if (!event.target.matches('.question-type')) return;
  const card = event.target.closest('.question-card'), type = event.target.value;
  card.criteriaDrafts[card.dataset.type] = card.querySelector('.criteria-input').value;
  card.dataset.type = type;
  card.querySelector('.type-pill').textContent = type; card.querySelector('.type-pill').className = `type-pill ${type}`;
  card.querySelector('.criteria-input').value = card.criteriaDrafts[type] ?? pretty(defaultCriteria(type)) ?? ''; updateCriteriaLabels(card); edited();
});
$('#questions').addEventListener('click', event => { const button = event.target.closest('.remove-question'); if (button) { button.closest('.question-card').remove(); edited(); } });
$('#add-question').addEventListener('click', () => {
  const ids = $$('.question-id').map(input => input.value); let number = ids.length + 1;
  while (ids.includes(`question_${number}`)) number++;
  const card = questionCard(`question_${number}`, { type: 'noul', instructions: '' }, true); $('#questions').append(card); card.querySelector('.instructions-input').focus(); edited();
});
$('#state-input').addEventListener('input', edited); $('#request-json').addEventListener('input', edited);
$('#json-tab').addEventListener('click', () => {
  if (mode === 'json') return;
  try { $('#request-json').value = pretty(readRequest()); setMode('json'); error(); persistDraft(); } catch (cause) { error(cause.message); }
});
$('#builder-tab').addEventListener('click', () => {
  if (mode === 'builder') return;
  try { const request = readRequest(); setMode('builder'); renderBuilder(request, true); error(); persistDraft(); } catch (cause) { error(cause.message); }
});
for (const [id, jsonView] of [['results-tab', false], ['response-tab', true]]) $(`#${id}`).addEventListener('click', () => {
  $('#results').hidden = jsonView; $('#response-view').hidden = !jsonView;
  $('#results-tab').classList.toggle('active', !jsonView); $('#response-tab').classList.toggle('active', jsonView);
  $('#results-tab').setAttribute('aria-pressed', String(!jsonView)); $('#response-tab').setAttribute('aria-pressed', String(jsonView));
});
$('#save-button').addEventListener('click', () => { $('#scenario-title').value = saveDraft?.title ?? current.title; $('#scenario-notes').value = saveDraft?.description ?? current.description ?? ''; $('#save-error').textContent = ''; $('#save-dialog').showModal(); });
$('#save-dialog').addEventListener('cancel', event => { if (saving) event.preventDefault(); });
$('#save-form').addEventListener('input', () => { saveDraft = { title: $('#scenario-title').value, description: $('#scenario-notes').value }; edited(); });
$('#close-save').addEventListener('click', () => $('#save-dialog').close());
$('#save-form').addEventListener('submit', event => { event.preventDefault(); saveScenario(); });
$('#save-copy').addEventListener('click', () => saveScenario(true));
$('#export-button').addEventListener('click', () => {
  try { const scenario = scenarioDocument({ ...current, ...saveDraft, ...readRequest() }); exportJson(scenario, `${scenario.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 70) || 'scenario'}.json`); }
  catch (cause) { error(cause.message); }
});
$('#import-button').addEventListener('click', () => $('#import-file').click());
$('#import-file').addEventListener('change', async event => {
  const file = event.target.files[0]; if (!file) return;
  try { if (file.size > 1048576) throw new Error('Import a scenario smaller than 1 MiB.'); const scenario = scenarioDocument(parse(await file.text(), 'Imported file')); if (loadScenario(scenario)) { dirty = true; updateCount(); toast('Scenario imported. Save it to keep it in the library.'); } }
  catch (cause) { error(cause.message); }
  event.target.value = '';
});
$('#history').addEventListener('click', event => {
  const button = event.target.closest('[data-run]'); if (!button) return;
  const run = workspace.runs.find(item => item.id === button.dataset.run);
  if (loadScenario({ version: 1, title: run.title, description: `Recorded ${new Date(run.createdAt).toLocaleString()}`, state: run.request.state, questions: run.request.questions })) { activeRun = run; renderResults(); toast('Recorded request restored. Choose a connection to run it again.'); }
});
$('#clear-history').addEventListener('click', async () => {
  if (!window.confirm('Clear the recorded runs? Saved scenarios will be kept.')) return;
  try { await store.clearRuns(); workspace.runs = []; renderHistory(); } catch (cause) { error(cause.message); }
});
$('#copy-response').addEventListener('click', async () => {
  if (!activeRun) return;
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(pretty(activeRun.response));
    else { const input = document.createElement('textarea'); input.value = pretty(activeRun.response); document.body.append(input); input.select(); const copied = document.execCommand('copy'); input.remove(); if (!copied) throw new Error(); }
    toast('Response copied.');
  } catch { exportJson(activeRun.response, 'decision-response.json'); toast('Response downloaded.'); }
});

async function initialize() {
  setSidebar(!narrowScreen.matches); updateCount();
  try {
    const bootstrap = await api('/api/bootstrap'); relayToken = bootstrap.token;
    store = await openWorkspace();
    const snapshot = await store.snapshot();
    workspace = { examples: bootstrap.examples, endpoints: [{ ...TYPESAFE }, ...snapshot.connections], scenarios: snapshot.scenarios, runs: snapshot.runs };
    workspaceReady = true;
    for (const selected of connections().filter(item => item.browserKey)) {
      try { const key = sessionStorage.getItem(keySlot(selected)); if (validApiKey(key)) browserKeys.set(keySlot(selected), key); } catch {}
    }
    let draft, savedEndpoint, rawDraft;
    const preserveBrokenDraft = () => {
      try { if (rawDraft) localStorage.setItem(`${DRAFT_KEY}.recovery`, rawDraft); } catch {}
      toast('The browser draft could not be restored. Saved scenarios are still available; a recovery copy was kept when storage allowed.');
    };
    try { rawDraft = localStorage.getItem(DRAFT_KEY); draft = JSON.parse(rawDraft); } catch { if (rawDraft) preserveBrokenDraft(); }
    try { savedEndpoint = localStorage.getItem(ENDPOINT_KEY); } catch {}
    renderEndpointOptions(savedEndpoint);
    loadScenario(workspace.examples[0], { confirm: false });
    if (draft) {
      try {
        if (!isObject(draft.current) || typeof draft.state !== 'string' || typeof draft.raw !== 'string' || !Array.isArray(draft.questions) || draft.questions.length > 64
          || draft.questions.some(item => !isObject(item) || !['id', 'instructions', 'criteria'].every(key => typeof item[key] === 'string'))) throw new Error('Invalid browser draft');
        scenarioDocument(draft.current);
        current = draft.current; dirty = Boolean(draft.dirty); setMode(draft.mode === 'json' ? 'json' : 'builder');
        $('#scenario-heading').textContent = current.title; $('#scenario-description').textContent = current.description || '';
        $('#scenario-category').textContent = (current.category || 'YOUR SCENARIO').toUpperCase();
        $('#state-input').value = draft.stateFormat === 'text' ? formatStateInput(draft.state) : draft.state;
        $('#request-json').value = draft.raw;
        saveDraft = isObject(draft.saveDraft) && typeof draft.saveDraft.title === 'string' && typeof draft.saveDraft.description === 'string' ? draft.saveDraft : null;
        saveAttempt = isObject(draft.saveAttempt) && typeof draft.saveAttempt.id === 'string' && typeof draft.saveAttempt.fingerprint === 'string' ? draft.saveAttempt : null;
        $('#questions').replaceChildren(...draft.questions.map(item => {
          const card = questionCard(item.id, { type: ['noul', 'choice', 'score'].includes(item.type) ? item.type : 'noul', instructions: '' }, item.open);
          card.querySelector('.instructions-input').value = item.instructionsFormat === 'auto' || item.structured === true ? item.instructions : formatStateInput(item.instructions);
          card.querySelector('.criteria-input').value = item.criteria;
          card.criteriaDrafts = Object.fromEntries(['noul', 'choice', 'score'].filter(type => typeof item.criteriaDrafts?.[type] === 'string').map(type => [type, item.criteriaDrafts[type]]));
          card.querySelector('.question-preview').textContent = item.instructions.slice(0, 130); return card;
        }));
      } catch { preserveBrokenDraft(); loadScenario(workspace.examples[0], { confirm: false }); }
    }
    renderLibrary(); renderEndpoint(); renderHistory(); persistDraft();
  } catch (cause) { workspaceReady = false; error(`${cause.message} Reload to reconnect.`); updateCount(); $('#endpoint').disabled = true; $('#check-button').disabled = true; }
}
initialize();
