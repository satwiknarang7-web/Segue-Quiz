import { createStore } from '../store/index.js';

const toRow = (user) => ({
  id: user.id,
  name: user.name,
  email: user.email,
  password_salt: user.passwordSalt,
  password_hash: user.passwordHash,
  totp_secret: user.totpSecret,
  totp_confirmed: Boolean(user.totpConfirmed),
  recovery_codes: user.recoveryCodes ?? [],
  token_version: user.tokenVersion ?? 1,
  created_at: user.createdAt,
  last_sign_in_at: user.lastSignInAt ?? null,
});

const fromRow = (row) => ({
  id: row.id,
  name: row.name,
  email: row.email,
  passwordSalt: row.password_salt,
  passwordHash: row.password_hash,
  totpSecret: row.totp_secret,
  totpConfirmed: row.totp_confirmed,
  recoveryCodes: row.recovery_codes ?? [],
  tokenVersion: row.token_version,
  createdAt: new Date(row.created_at).toISOString(),
  lastSignInAt: row.last_sign_in_at ? new Date(row.last_sign_in_at).toISOString() : null,
});

const store = createStore({ file: 'users.json', table: 'users', toRow, fromRow });

const normaliseEmail = (email) => String(email ?? '').trim().toLowerCase();

export const userRepository = {
  count() {
    return store.all().length;
  },

  findById(id) {
    return store.findById(id);
  },

  findByEmail(email) {
    const key = normaliseEmail(email);
    return store.find((user) => user.email === key);
  },

  insert(user) {
    return store.insert(user);
  },

  update(id, updater) {
    return store.update(id, updater);
  },

  flushed() {
    return store.flushed();
  },

  normaliseEmail,
};
