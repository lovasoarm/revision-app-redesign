const STORE_FILE = "revision-data.json";
const DB_NAME = "my-revision-app";
const DB_VERSION = 1;
const OBJECT_STORE = "kv";

export function createStorage() {
  let tauriStore = null;
  let browserDb = null;
  let mode = "localStorage · secours offline";

  function hasTauri() {
    return typeof window !== "undefined" && !!window.__TAURI__;
  }

  function openBrowserDb() {
    return new Promise((resolve, reject) => {
      if (!window.indexedDB) return reject(new Error("IndexedDB indisponible"));
      const request = window.indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(OBJECT_STORE)) {
          request.result.createObjectStore(OBJECT_STORE);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("Ouverture IndexedDB impossible"));
    });
  }

  function idbGet(key) {
    return new Promise((resolve, reject) => {
      const tx = browserDb.transaction(OBJECT_STORE, "readonly");
      const req = tx.objectStore(OBJECT_STORE).get(key);
      req.onsuccess = () => resolve(req.result === undefined ? null : req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function idbSetMany(entries) {
    return new Promise((resolve, reject) => {
      const tx = browserDb.transaction(OBJECT_STORE, "readwrite");
      const objectStore = tx.objectStore(OBJECT_STORE);
      entries.forEach(([key, value]) => objectStore.put(value, key));
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error("Transaction IndexedDB annulée"));
    });
  }

  function idbRemove(key) {
    return new Promise((resolve, reject) => {
      const tx = browserDb.transaction(OBJECT_STORE, "readwrite");
      tx.objectStore(OBJECT_STORE).delete(key);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  }

  async function init() {
    if (hasTauri()) {
      try {
        const api = window.__TAURI__;
        const plugin = api.store || (api.plugins && api.plugins.store);
        if (plugin && typeof plugin.load === "function") {
          tauriStore = await plugin.load(STORE_FILE);
          if (tauriStore) {
            mode = "Tauri Store · fichier local";
            return mode;
          }
        }
      } catch (error) {
        console.warn("Tauri Store indisponible, fallback offline utilisé", error);
      }
    }

    try {
      browserDb = await openBrowserDb();
      mode = "IndexedDB · stockage local offline";
    } catch (error) {
      browserDb = null;
      mode = "localStorage · secours offline";
    }
    return mode;
  }

  async function get(key) {
    if (tauriStore) {
      const value = await tauriStore.get(key);
      return value === undefined ? null : value;
    }
    if (browserDb) {
      const value = await idbGet(key);
      if (value !== null) return value;
      const legacyRaw = window.localStorage.getItem(key);
      if (legacyRaw !== null) {
        try {
          const legacyValue = JSON.parse(legacyRaw);
          await idbSetMany([[key, legacyValue]]);
          window.localStorage.removeItem(key);
          return legacyValue;
        } catch (_) {
          return null;
        }
      }
      return null;
    }
    const raw = window.localStorage.getItem(key);
    if (raw === null) return null;
    try { return JSON.parse(raw); } catch (_) { return null; }
  }

  async function set(key, value) {
    await setMany([[key, value]]);
  }

  async function setMany(entries) {
    if (tauriStore) {
      for (const [key, value] of entries) await tauriStore.set(key, value);
      if (typeof tauriStore.save === "function") await tauriStore.save();
      return;
    }
    if (browserDb) {
      await idbSetMany(entries);
      return;
    }
    entries.forEach(([key, value]) => window.localStorage.setItem(key, JSON.stringify(value)));
  }

  async function remove(key) {
    if (tauriStore) {
      await tauriStore.delete(key);
      if (typeof tauriStore.save === "function") await tauriStore.save();
      return;
    }
    if (browserDb) {
      await idbRemove(key);
      return;
    }
    window.localStorage.removeItem(key);
  }

  return {
    init,
    get,
    set,
    setMany,
    remove,
    isTauri: () => !!tauriStore || hasTauri(),
    isBrowserDb: () => !!browserDb,
    mode: () => mode,
  };
}



/**
 * Simple Storage wrapper for localStorage/seeding during tests.
 */
export class Storage {
  constructor(prefix = '') {
    this.prefix = prefix ? prefix + ':' : '';
    this._storage = (typeof window !== 'undefined' && window.localStorage) ? window.localStorage : new Map();
  }
  keyName(k){ return this.prefix + k; }
  set(k, v){
    const s = typeof this._storage.set === 'function';
    if (s) {
      // Map-like (Node test environment)
      try { this._storage.set(this.keyName(k), JSON.stringify(v)); } catch(e) { this._storage[this.keyName(k)] = JSON.stringify(v); }
    } else {
      this._storage.setItem(this.keyName(k), JSON.stringify(v));
    }
    return true;
  }
  get(k){
    try {
      const raw = (typeof this._storage.get === 'function') ? this._storage.get(this.keyName(k)) : this._storage.getItem(this.keyName(k));
      if (raw == null) return null;
      return JSON.parse(raw);
    } catch(e){
      return null;
    }
  }
  clear(){
    // simple clear for prefixed items
    if (typeof this._storage.keys === 'function') {
      // Map-like: clear keys with prefix
      for (const key of Array.from(this._storage.keys())) {
        if (String(key).startsWith(this.prefix)) this._storage.delete(key);
      }
    } else if (typeof this._storage.removeItem === 'function') {
      // localStorage-like
      const toRemove = [];
      for (let i = 0; i < this._storage.length; i++) {
        const k = this._storage.key(i);
        if (k && k.startsWith(this.prefix)) toRemove.push(k);
      }
      toRemove.forEach(k => this._storage.removeItem(k));
    }
  }
}
