import { scenarioDocument, validateRequest, validateResponse } from './contract.js';
import { normalizeConnection } from './connections.js';

const DATABASE = 'decision-model-playground';
const tables = ['scenarios', 'runs', 'connections'];

export function nextScenario(document, previous, count, expectedUpdatedAt) {
  const clean = scenarioDocument(document);
  if (typeof document.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(document.id)) throw new Error('Invalid scenario ID.');
  if (previous && JSON.stringify(scenarioDocument(previous)) === JSON.stringify(clean)) return previous;
  if ((previous && previous.updatedAt !== expectedUpdatedAt) || (!previous && typeof expectedUpdatedAt === 'string')) {
    throw new Error('This scenario changed or was deleted in another tab. Reload it, or use Save a copy.');
  }
  if (!previous && count >= 100) throw new Error('The library holds 100 scenarios. Export or delete some first.');
  return { ...clean, id: document.id, updatedAt: new Date(Math.max(Date.now(), previous ? Date.parse(previous.updatedAt) + 1 : 0)).toISOString() };
}

// Read/modify/write happens in one IndexedDB transaction, including across tabs.
export async function openWorkspace() {
  const db = await new Promise((resolve, reject) => {
    let request;
    try { request = indexedDB.open(DATABASE, 1); } catch { reject(new Error('Browser storage is unavailable. Enable site storage to save scenarios and connections.')); return; }
    request.onupgradeneeded = () => { for (const table of tables) request.result.createObjectStore(table, { keyPath: 'id' }); };
    request.onsuccess = () => { const db = request.result; db.onversionchange = () => db.close(); resolve(db); };
    request.onerror = () => reject(new Error('Cannot open browser storage. Enable site storage, then reload.'));
    request.onblocked = () => reject(new Error('Close other playground tabs to finish the storage upgrade.'));
  });
  const transact = (table, mutate) => new Promise((resolve, reject) => {
    const tx = db.transaction(table, mutate ? 'readwrite' : 'readonly'), store = tx.objectStore(table);
    let value, failure;
    const request = store.getAll();
    request.onsuccess = () => {
      try { value = mutate ? mutate(request.result, store) : request.result; }
      catch (error) { failure = error; tx.abort(); }
    };
    tx.oncomplete = () => resolve(value);
    tx.onabort = () => reject(failure || new Error('Browser storage could not save this change. Export your scenario or free some site storage.'));
    tx.onerror = () => {};
  });
  return {
    async snapshot() {
      const [scenarios, runs, connections] = await Promise.all(tables.map(table => transact(table)));
      for (const item of scenarios) scenarioDocument(item);
      for (const run of runs) { validateRequest(run.request); validateResponse(run.response, run.request.questions); }
      return {
        scenarios: scenarios.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
        runs: runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
        connections: connections.map(normalizeConnection),
      };
    },
    saveScenario(document, expectedUpdatedAt) {
      return transact('scenarios', (items, store) => {
        const next = nextScenario(document, items.find(item => item.id === document.id), items.length, expectedUpdatedAt);
        store.put(next); return next;
      });
    },
    deleteScenario: id => transact('scenarios', (_, store) => store.delete(id)),
    clearRuns: () => transact('runs', (_, store) => store.clear()),
    addRun(run) {
      validateRequest(run.request); validateResponse(run.response, run.request.questions);
      return transact('runs', (items, store) => {
        store.put(run);
        const sorted = [run, ...items.filter(item => item.id !== run.id)].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        for (const old of sorted.slice(30)) store.delete(old.id);
      });
    },
    addConnection(input) {
      const item = normalizeConnection(input);
      if (item.kind === 'typesafe') throw new Error('TypeSafe is already available.');
      return transact('connections', (items, store) => {
        if (items.length >= 29) throw new Error('Up to 29 custom connections can be saved.');
        if (items.some(existing => existing.id === item.id)) throw new Error('This connection already exists.');
        store.add(item); return item;
      });
    },
    deleteConnection: id => transact('connections', (_, store) => store.delete(id)),
  };
}
