import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

/**
 * A tiny append-safe JSON collection.
 *
 * The whole collection lives in memory and is flushed to disk atomically
 * (write to a temp file, then rename). Writes are serialised through a
 * promise chain so two concurrent submissions can never interleave and
 * lose each other's records.
 */
export class JsonStore {
  #filePath;
  #records;
  #writeQueue = Promise.resolve();

  constructor(filePath) {
    this.#filePath = filePath;
    this.#records = this.#load();
  }

  #load() {
    try {
      const contents = fs.readFileSync(this.#filePath, 'utf8');
      const parsed = JSON.parse(contents);
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      if (error instanceof SyntaxError) {
        // Never destroy data we cannot parse - move it aside instead.
        const backup = `${this.#filePath}.corrupt-${Date.now()}`;
        fs.renameSync(this.#filePath, backup);
        console.warn(`[store] ${path.basename(this.#filePath)} was unreadable; moved to ${backup}`);
        return [];
      }
      throw error;
    }
  }

  #flush() {
    const snapshot = JSON.stringify(this.#records, null, 2);
    this.#writeQueue = this.#writeQueue.then(async () => {
      await fsp.mkdir(path.dirname(this.#filePath), { recursive: true });
      const tempPath = `${this.#filePath}.${process.pid}.tmp`;
      await fsp.writeFile(tempPath, snapshot, 'utf8');
      await fsp.rename(tempPath, this.#filePath);
    });
    return this.#writeQueue;
  }

  /** Resolves once every queued write has hit the disk. */
  flushed() {
    return this.#writeQueue;
  }

  all() {
    return this.#records.map((record) => structuredClone(record));
  }

  filter(predicate) {
    return this.#records.filter(predicate).map((record) => structuredClone(record));
  }

  find(predicate) {
    const match = this.#records.find(predicate);
    return match ? structuredClone(match) : null;
  }

  findById(id) {
    return this.find((record) => record.id === id);
  }

  insert(record) {
    this.#records.push(structuredClone(record));
    this.#flush();
    return structuredClone(record);
  }

  /** Replace a record wholesale; returns the stored copy. */
  update(id, updater) {
    const index = this.#records.findIndex((record) => record.id === id);
    if (index === -1) return null;
    const next = updater(structuredClone(this.#records[index]));
    this.#records[index] = structuredClone(next);
    this.#flush();
    return structuredClone(next);
  }

  remove(id) {
    const index = this.#records.findIndex((record) => record.id === id);
    if (index === -1) return false;
    this.#records.splice(index, 1);
    this.#flush();
    return true;
  }

  removeWhere(predicate) {
    const before = this.#records.length;
    this.#records = this.#records.filter((record) => !predicate(record));
    if (this.#records.length !== before) this.#flush();
    return before - this.#records.length;
  }
}
