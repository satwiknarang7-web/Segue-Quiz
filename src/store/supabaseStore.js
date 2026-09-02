import { createPostgrestClient } from './postgrest.js';

/**
 * A collection backed by a Supabase table, with the same surface as JsonStore.
 *
 * Rows are loaded into memory once at start-up and every mutation is applied
 * there first, then written through to Postgres on a serialised queue. That is
 * exactly how JsonStore already behaves with its file, which is why the whole
 * application above this layer stays synchronous and unchanged.
 *
 * The trade: this process is the live copy. Editing rows in the Supabase
 * dashboard, or running a second instance against the same project, will not
 * be seen until a restart. See the README for what changing that would take.
 */
export class SupabaseStore {
  #client;
  #table;
  #toRow;
  #fromRow;
  #records = [];
  #writeQueue = Promise.resolve();
  #loaded = false;

  #requiredColumns;

  constructor({ url, serviceRoleKey, table, toRow, fromRow, fetchImpl, requiredColumns = [] }) {
    this.#client = createPostgrestClient({ url, serviceRoleKey, fetchImpl });
    this.#table = table;
    this.#toRow = toRow;
    this.#fromRow = fromRow;
    this.#requiredColumns = requiredColumns;
  }

  /**
   * Ask Postgres for the columns this build needs. A database that has not had
   * the latest migration run answers with an error naming the missing column,
   * which is a far better failure than writes silently breaking later.
   */
  async assertColumns() {
    if (this.#requiredColumns.length === 0) return true;

    try {
      await this.#client.selectColumns(this.#table, this.#requiredColumns);
      return true;
    } catch (error) {
      throw new Error(
        `The "${this.#table}" table is missing a column this version needs ` +
          `(${this.#requiredColumns.join(', ')}). Run the migrations in supabase/migrations. ` +
          `Postgres said: ${error.message}`,
      );
    }
  }

  get table() {
    return this.#table;
  }

  /** Pull the table into memory. Must finish before the server accepts traffic. */
  async load() {
    const rows = await this.#client.selectAll(this.#table);
    this.#records = (rows ?? []).map((row) => this.#fromRow(row));
    this.#loaded = true;
    return this.#records.length;
  }

  #assertLoaded() {
    if (!this.#loaded) {
      throw new Error(`Supabase table "${this.#table}" was used before it finished loading.`);
    }
  }

  #enqueue(work) {
    this.#writeQueue = this.#writeQueue.then(work).catch((error) => {
      // A failed write must not poison the queue or crash the process; the
      // in-memory copy is still correct and the next write may well succeed.
      console.error(`[supabase] write to ${this.#table} failed:`, error.message);
    });
    return this.#writeQueue;
  }

  flushed() {
    return this.#writeQueue;
  }

  all() {
    this.#assertLoaded();
    return this.#records.map((record) => structuredClone(record));
  }

  filter(predicate) {
    this.#assertLoaded();
    return this.#records.filter(predicate).map((record) => structuredClone(record));
  }

  find(predicate) {
    this.#assertLoaded();
    const match = this.#records.find(predicate);
    return match ? structuredClone(match) : null;
  }

  findById(id) {
    return this.find((record) => record.id === id);
  }

  insert(record) {
    this.#assertLoaded();
    this.#records.push(structuredClone(record));
    this.#enqueue(() => this.#client.upsert(this.#table, this.#toRow(record)));
    return structuredClone(record);
  }

  update(id, updater) {
    this.#assertLoaded();
    const index = this.#records.findIndex((record) => record.id === id);
    if (index === -1) return null;

    const next = updater(structuredClone(this.#records[index]));
    this.#records[index] = structuredClone(next);
    this.#enqueue(() => this.#client.upsert(this.#table, this.#toRow(next)));
    return structuredClone(next);
  }

  remove(id) {
    this.#assertLoaded();
    const index = this.#records.findIndex((record) => record.id === id);
    if (index === -1) return false;

    this.#records.splice(index, 1);
    this.#enqueue(() => this.#client.deleteWhere(this.#table, 'id', id));
    return true;
  }

  removeWhere(predicate) {
    this.#assertLoaded();
    const doomed = this.#records.filter(predicate);
    if (doomed.length === 0) return 0;

    this.#records = this.#records.filter((record) => !predicate(record));
    for (const record of doomed) {
      this.#enqueue(() => this.#client.deleteWhere(this.#table, 'id', record.id));
    }
    return doomed.length;
  }
}
