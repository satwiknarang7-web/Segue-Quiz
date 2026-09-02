/**
 * A very small PostgREST client — the HTTP API every Supabase project exposes
 * at /rest/v1. Plain fetch, so the project keeps its zero dependencies.
 *
 * It is called with the service_role key, which bypasses row level security.
 * That key belongs on the server only: SegueQuiz decides who may see what, and
 * the browser never talks to Supabase directly.
 */

export class PostgrestError extends Error {
  constructor(message, { status, table, body } = {}) {
    super(message);
    this.name = 'PostgrestError';
    this.status = status;
    this.table = table;
    this.body = body;
  }
}

export function createPostgrestClient({ url, serviceRoleKey, fetchImpl = fetch }) {
  const base = `${String(url).replace(/\/+$/, '')}/rest/v1`;

  const headers = {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    'Content-Type': 'application/json',
  };

  async function send(method, path, { body, prefer, table } = {}) {
    const response = await fetchImpl(`${base}${path}`, {
      method,
      headers: prefer ? { ...headers, Prefer: prefer } : headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new PostgrestError(
        `Supabase ${method} ${table ?? path} failed (${response.status}): ${text || 'no body'}`,
        { status: response.status, table, body: text },
      );
    }

    if (response.status === 204) return null;
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }

  return {
    /** Every row in a table. These tables hold one classroom's worth of data. */
    selectAll(table) {
      return send('GET', `/${encodeURIComponent(table)}?select=*`, { table });
    },

    /** Insert or replace one row, keyed on the primary key. */
    upsert(table, row) {
      return send('POST', `/${encodeURIComponent(table)}`, {
        table,
        body: [row],
        prefer: 'resolution=merge-duplicates,return=minimal',
      });
    },

    deleteWhere(table, column, value) {
      const query = `${encodeURIComponent(column)}=eq.${encodeURIComponent(value)}`;
      return send('DELETE', `/${encodeURIComponent(table)}?${query}`, {
        table,
        prefer: 'return=minimal',
      });
    },

    /** Cheap round trip used to check the connection at start-up. */
    async ping(table) {
      await send('GET', `/${encodeURIComponent(table)}?select=id&limit=1`, { table });
      return true;
    },
  };
}
