// Storage with two backends:
//  - "account": the Claude artifact `db` capability, private to you (data/users/<your id>/...).
//    Used when Lyceum runs as a Claude artifact; your data follows you across devices.
//  - "browser": IndexedDB in this browser. Used when Lyceum runs on its own (e.g. GitHub Pages).
// Collections: courses, lessons (lesson bodies: dialogue + notes), cards. Plus a small key-value area.

const COLLECTIONS = ['courses', 'lessons', 'cards'];
let backend = null;
let initPromise = null;

export function init() {
  if (!initPromise) initPromise = pick();
  return initPromise;
}

export async function kind() {
  await init();
  return backend.kind;
}

async function pick() {
  try {
    if (window.claude?.use) {
      const [db, user] = await Promise.all([window.claude.use('db'), window.claude.use('user')]);
      const uid = db && user ? await user.id() : null;
      if (db && uid) {
        backend = accountBackend(db, uid);
        return backend;
      }
    }
  } catch (e) {
    console.warn('Account storage unavailable, using browser storage', e);
  }
  backend = browserBackend();
  return backend;
}

/* ---------- account backend (artifact db) ---------- */

// A db document is capped at 256 KiB, so long lesson dialogues are split across several documents.
const CHUNK_BYTES = 180000;

function accountBackend(db, uid) {
  const root = db.doc(`data/users/${uid}/lyceum`);
  const col = (name) => root.collection(name);
  const kv = (k) => db.doc(`data/users/${uid}/kv-${k}`);
  const plain = (snap) => (snap.exists ? JSON.parse(JSON.stringify(snap.data())) : undefined);
  const size = (v) => new Blob([JSON.stringify(v)]).size;

  async function writeDoc(ref, data) {
    try {
      await ref.set(data);
    } catch (e) {
      if (e?.code === 'unavailable') {
        await new Promise((r) => setTimeout(r, 400 + Math.random() * 600));
        return ref.set(data);
      }
      throw friendly(e);
    }
  }

  async function putLesson(body) {
    const { messages = [], ...rest } = body;
    const chunks = [[]];
    let bytes = size(rest);
    for (const m of messages) {
      const s = size(m);
      if (bytes + s > CHUNK_BYTES && chunks[chunks.length - 1].length) {
        chunks.push([]);
        bytes = 0;
      }
      chunks[chunks.length - 1].push(m);
      bytes += s;
    }
    const c = col('lessons');
    const prev = plain(await c.doc(body.id).get());
    await writeDoc(c.doc(body.id), { ...rest, messages: chunks[0], chunks: chunks.length });
    for (let i = 1; i < chunks.length; i++) await writeDoc(c.doc(`${body.id}~${i}`), { messages: chunks[i] });
    for (let i = chunks.length; i < (prev?.chunks || 1); i++) await c.doc(`${body.id}~${i}`).delete();
  }

  async function getLesson(id) {
    const c = col('lessons');
    const main = plain(await c.doc(id).get());
    if (!main) return undefined;
    let messages = main.messages || [];
    for (let i = 1; i < (main.chunks || 1); i++) {
      const part = plain(await c.doc(`${id}~${i}`).get());
      if (part) messages = messages.concat(part.messages || []);
    }
    delete main.chunks;
    return { ...main, messages };
  }

  return {
    kind: 'account',
    async all(name) {
      const snap = await col(name).get();
      return snap.docs.filter((d) => !d.id.includes('~')).map((d) => JSON.parse(JSON.stringify(d.data())));
    },
    async get(name, id) {
      if (name === 'lessons') return getLesson(id);
      return plain(await col(name).doc(id).get());
    },
    async put(name, obj) {
      if (name === 'lessons') return putLesson(obj);
      return writeDoc(col(name).doc(obj.id), obj);
    },
    async putMany(name, items) {
      for (const it of items) await this.put(name, it);
    },
    async del(name, id) {
      if (name === 'lessons') {
        const main = plain(await col(name).doc(id).get());
        for (let i = 1; i < (main?.chunks || 1); i++) await col(name).doc(`${id}~${i}`).delete();
      }
      await col(name).doc(id).delete();
    },
    async kvGet(k) {
      return plain(await kv(k).get())?.value;
    },
    async kvSet(k, value) {
      return writeDoc(kv(k), { value });
    },
  };
}

function friendly(e) {
  if (!e || e instanceof Error) return e;
  const msgs = {
    quota_exceeded: 'Your Lyceum storage is full. Delete an old course to make room.',
    resource_exhausted: 'Saving too quickly. Wait a moment and try again.',
    revoked: 'This page lost access to your saved data. Reload the page.',
  };
  return new Error(msgs[e.code] || e.message || 'Could not save your changes.');
}

/* ---------- browser backend (IndexedDB) ---------- */

function browserBackend() {
  let dbp;
  const open = () =>
    (dbp ||= new Promise((resolve, reject) => {
      const req = indexedDB.open('lyceum', 2);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
        for (const s of COLLECTIONS) if (!d.objectStoreNames.contains(s)) d.createObjectStore(s, { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }));
  const tx = async (store, mode, fn) => {
    const d = await open();
    return new Promise((resolve, reject) => {
      const t = d.transaction(store, mode);
      const req = fn(t.objectStore(store));
      t.oncomplete = () => resolve(req ? req.result : undefined);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  };
  return {
    kind: 'browser',
    all: (name) => tx(name, 'readonly', (s) => s.getAll()),
    get: (name, id) => tx(name, 'readonly', (s) => s.get(id)),
    put: (name, obj) => tx(name, 'readwrite', (s) => s.put(obj)),
    putMany: (name, items) => tx(name, 'readwrite', (s) => { items.forEach((i) => s.put(i)); }),
    del: (name, id) => tx(name, 'readwrite', (s) => s.delete(id)),
    kvGet: (k) => tx('kv', 'readonly', (s) => s.get(k)),
    kvSet: (k, v) => tx('kv', 'readwrite', (s) => s.put(v, k)),
  };
}

/* ---------- public API ---------- */

export const all = async (n) => (await init()).all(n);
export const get = async (n, id) => (await init()).get(n, id);
export const put = async (n, o) => (await init()).put(n, o);
export const putMany = async (n, items) => (await init()).putMany(n, items);
export const del = async (n, id) => (await init()).del(n, id);
export const kvGet = async (k) => (await init()).kvGet(k);
export const kvSet = async (k, v) => (await init()).kvSet(k, v);
