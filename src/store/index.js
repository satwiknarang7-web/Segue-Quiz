import path from 'node:path';

import { config } from '../config.js';
import { JsonStore } from './jsonStore.js';
import { SupabaseStore } from './supabaseStore.js';

/**
 * Picks where a collection lives. Both stores expose the same surface, so
 * nothing above this file knows or cares which one is in play.
 */

const stores = [];

export function createStore({ file, table, toRow, fromRow }) {
  const store = config.supabase.enabled
    ? new SupabaseStore({
        url: config.supabase.url,
        serviceRoleKey: config.supabase.serviceRoleKey,
        table,
        toRow,
        fromRow,
      })
    : new JsonStore(path.join(config.dataDir, file));

  stores.push(store);
  return store;
}

/**
 * Supabase-backed stores have to read their table before anything can be
 * served. With JSON files this is already done, so it resolves immediately.
 */
export async function initialiseStores() {
  const { url, serviceRoleKey } = config.supabase;

  // Half-configured is always a mistake, and silently falling back to JSON
  // would write the data somewhere the operator is not looking.
  if (Boolean(url) !== Boolean(serviceRoleKey)) {
    const missing = url ? 'SUPABASE_SERVICE_ROLE_KEY' : 'SUPABASE_URL';
    throw new Error(`${missing} is missing. Set both Supabase settings, or neither.`);
  }

  if (!config.supabase.enabled) return { backend: 'json', loaded: {} };

  const loaded = {};
  for (const store of stores) {
    loaded[store.table] = await store.load();
  }
  return { backend: 'supabase', loaded };
}

export const storageBackend = () => (config.supabase.enabled ? 'supabase' : 'json');
