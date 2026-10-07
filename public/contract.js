// Shared validation for portable scenarios, editor input, and provider responses.
export const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const validApiKey = value => typeof value === 'string' && /^[\x21-\x7e]{1,512}$/.test(value);
export const byteLength = value => new TextEncoder().encode(JSON.stringify(value)).length;
const structuredText = value => (typeof value === 'string' && value.trim().length > 0)
  || (Array.isArray(value) && value.length > 0) || (isObject(value) && Object.keys(value).length > 0);
const fail = message => { throw new Error(message); };
export const MAX_SCENARIO_BYTES = 1000000; // Leave room for transport metadata within the 1 MiB HTTP limit.

function checkJsonValue(value) {
  const pending = [[value, 0]], seen = new WeakSet();
  while (pending.length) {
    const [item, depth] = pending.pop();
    if (depth > 64) fail('JSON nesting is limited to 64 levels.');
    if (typeof item === 'number' && (!Number.isFinite(item) || (Number.isInteger(item) && !Number.isSafeInteger(item)))) fail('A number is too large to preserve accurately. Put large IDs or numbers in quotes.');
    if (item && typeof item === 'object') {
      if (seen.has(item)) continue;
      seen.add(item);
      for (const child of Object.values(item)) pending.push([child, depth + 1]);
    } else if (item !== null && !['string', 'boolean', 'number'].includes(typeof item)) fail('Use JSON-compatible values.');
  }
}

export function parseJson(text) {
  if (new TextEncoder().encode(text).length > 2097152) fail('JSON input exceeds 2 MiB.');
  const value = JSON.parse(text), stack = [];
  // JSON.parse validates syntax, but silently accepts duplicate keys. Scan its
  // valid source so escaped spellings of the same key are detected as well.
  for (const match of text.matchAll(/"(?:\\[\s\S]|[^"\\])*"|[\[\]{}]/gu)) {
    const token = match[0];
    if (token === '{' || token === '[') {
      stack.push(token === '{' ? new Set() : null);
      if (stack.length > 64) fail('JSON nesting is limited to 64 levels.');
    } else if (token === '}' || token === ']') stack.pop();
    else if (stack.at(-1)) {
      let next = match.index + token.length;
      while (/[ \t\r\n]/.test(text[next] || 'x')) next++;
      if (text[next] !== ':') continue;
      const key = JSON.parse(token), keys = stack.at(-1);
      if (keys.has(key)) fail(`Duplicate JSON key "${key.slice(0, 80)}". Give each key a unique name.`);
      keys.add(key);
    }
  }
  checkJsonValue(value);
  return value;
}

const pastedJsonSpace = /[\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]/u;

// Rich-text paste can introduce spaces JSON does not accept as indentation.
// Normalize only outside strings; names, descriptions, and escapes stay intact.
export function parseJsonInput(text) {
  // Accept a complete JSON code block copied from documentation or a chat.
  const fenced = text.trim().match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i);
  if (fenced) text = fenced[1];
  if (!pastedJsonSpace.test(text)) return parseJson(text);
  let normalized = '', quoted = false, escaped = false;
  for (const character of text) {
    if (quoted) {
      normalized += character;
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quoted = false;
    } else {
      if (character === '"') quoted = true;
      normalized += pastedJsonSpace.test(character) ? ' ' : character;
    }
  }
  return parseJson(normalized);
}

// The state editor accepts prose directly; JSON strings also let an imported
// literal such as '{"fruit":"apple"}' keep its original string type.
export function parseStateInput(text) {
  try {
    const value = parseJsonInput(text);
    if (typeof value === 'string' || Array.isArray(value) || isObject(value)) return value;
  } catch {}
  return text;
}

export function formatStateInput(value) {
  if (typeof value === 'string' && parseStateInput(value) === value) return value;
  return JSON.stringify(value, null, 2);
}

// An explicit browser choice wins on later visits. Old drafts are deliberately
// separate from this preference, so changing the initial default preserves edits.
export function selectEndpointId(endpoints, savedId) {
  return (endpoints.find(item => item.id === savedId)
    || endpoints.find(item => item.default)
    || endpoints.find(item => item.ready)
    || endpoints[0])?.id || '';
}

export function validateRequest(value, { maxQuestions = 64, kind = 'custom' } = {}) {
  if (!isObject(value)) fail('A request must be a JSON object.');
  if (!(typeof value.state === 'string' || Array.isArray(value.state) || isObject(value.state))) {
    fail('State must be text, a JSON object, or a JSON array.');
  }
  const portable = { state: value.state, questions: value.questions };
  checkJsonValue(portable);
  let size;
  try { size = byteLength(portable); } catch { fail('The request must contain serializable JSON without circular references.'); }
  if (size > MAX_SCENARIO_BYTES) fail('The complete scenario exceeds the 1 MB limit. Shorten its state, instructions, or options.');
  if (byteLength(value.state) > 131072) fail('State exceeds the playground limit of 128 KiB.');
  if (!isObject(value.questions)) fail('Questions must be an object keyed by question ID.');
  const entries = Object.entries(value.questions);
  if (!entries.length || entries.length > maxQuestions) fail(`Use between 1 and ${maxQuestions} questions for this endpoint.`);
  for (const [id, question] of entries) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(id)) fail(`Question ID "${id}" must start with a letter and use letters, digits, or underscores (64 characters maximum).`);
    if (!isObject(question) || !['noul', 'choice', 'score'].includes(question.type)) fail(`${id}: choose noul, choice, or score.`);
    if (!structuredText(question.instructions)) fail(`${id}: instructions cannot be empty.`);
    if (kind === 'imajev' && typeof question.instructions === 'string' && question.instructions.length > 2000) fail(`${id}: Imajev allows at most 2,000 characters of instructions.`);
    const criteria = question.criteria;
    if (question.type === 'choice') {
      if (!isObject(criteria) || Object.keys(criteria).length < 2 || Object.keys(criteria).length > 255) fail(`${id}: choice needs 2–255 named options.`);
      for (const [key, description] of Object.entries(criteria)) {
        if (!key.trim() || key.length > 128 || key === '__unknown__') fail(`${id}: option names must be 1–128 characters; __unknown__ is reserved.`);
        if (description !== null && typeof description !== 'string' && !Array.isArray(description) && !isObject(description)) fail(`${id}: option descriptions must be text, an object, an array, or null.`);
      }
    } else if (question.type === 'score') {
      if (!Array.isArray(criteria) || criteria.length < 2 || criteria.length > 10 || !criteria.every(structuredText)) fail(`${id}: score needs 2–10 non-empty levels, ordered from lowest to highest.`);
    } else if (criteria !== undefined) {
      if (!isObject(criteria) || Object.entries(criteria).some(([key, description]) => !['true', 'false'].includes(key) || !structuredText(description))) fail(`${id}: optional noul criteria use true and false descriptions.`);
    }
  }
  // Do not let imported scenarios select a URL, API key, or model.
  return portable;
}

export function scenarioDocument(value) {
  const request = validateRequest(value);
  if (value.version !== undefined && value.version !== 1) fail('This scenario version is not supported. Expected version 1.');
  const title = typeof value.title === 'string' ? value.title.trim() : 'Imported scenario';
  if (!title || title.length > 120) fail('Give the scenario a title of 1–120 characters.');
  const description = typeof value.description === 'string' ? value.description.trim() : '';
  if (description.length > 500) fail('Keep the description under 500 characters.');
  return { version: 1, title, description, ...request };
}

export function validateResponse(value, questions) {
  if (!isObject(value) || typeof value.model !== 'string' || !value.model.trim() || !isObject(value.answers)) fail('The endpoint did not return a model and answers object.');
  if (value.usage !== undefined && !isObject(value.usage)) fail('Invalid usage metadata.');
  for (const field of ['input_tokens', 'output_tokens']) {
    const count = value.usage?.[field];
    if (count !== undefined && count !== null && (!Number.isSafeInteger(count) || count < 0)) fail(`Invalid usage ${field}.`);
  }
  const probability = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
  for (const [id, question] of Object.entries(questions)) {
    const answer = Object.hasOwn(value.answers, id) ? value.answers[id] : null;
    if (!isObject(answer) || answer.type !== question.type) fail(`Missing or mismatched answer for ${id}.`);
    if (question.type === 'noul') {
      if (!probability(answer.noul)) fail(`Invalid noul value for ${id}.`);
    } else {
      const expected = question.type === 'choice' ? Object.keys(question.criteria) : question.criteria.map((_, index) => String(index));
      if (!isObject(answer.probabilities) || Object.keys(answer.probabilities).length !== expected.length
        || expected.some(key => !Object.hasOwn(answer.probabilities, key) || !probability(answer.probabilities[key]))) fail(`Invalid probability distribution for ${id}.`);
      if (Math.abs(Object.values(answer.probabilities).reduce((sum, p) => sum + p, 0) - 1) > 0.02) fail(`Probabilities for ${id} do not sum to one.`);
      if (question.type === 'choice' && !expected.includes(answer.choice)) fail(`Invalid choice for ${id}.`);
      if (question.type === 'score' && !(typeof answer.score === 'number' && Number.isFinite(answer.score) && answer.score >= 0 && answer.score <= expected.length - 1)) fail(`Invalid score for ${id}.`);
    }
    for (const key of ['confidence', 'unknown_probability']) {
      if (answer[key] !== undefined && !probability(answer[key])) fail(`Invalid ${key} for ${id}.`);
    }
    if (answer.abstained !== undefined && typeof answer.abstained !== 'boolean') fail(`Invalid abstention flag for ${id}.`);
    if (answer.calibration_version !== undefined && typeof answer.calibration_version !== 'string') fail(`Invalid calibration version for ${id}.`);
    if (answer.legend !== undefined && !isObject(answer.legend)) fail(`Invalid score legend for ${id}.`);
  }
  return value; // Keep original usage, confidence and calibration; never fabricate them.
}
