import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { detectLanAddress } from './lib/network.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const config = {
  rootDir,
  publicDir: path.join(rootDir, 'public'),
  dataDir: process.env.SEGUEQUIZ_DATA_DIR
    ? path.resolve(process.env.SEGUEQUIZ_DATA_DIR)
    : path.join(rootDir, 'data'),

  host: process.env.HOST ?? '0.0.0.0',
  port: Number(process.env.PORT ?? 4000),

  /**
   * The origin participants are sent to, and what the QR code encodes.
   *
   * PUBLIC_BASE_URL wins. Failing that, the common container hosts announce
   * their own public address, which saves having to set anything by hand.
   * Failing that, the LAN address - because a QR code pointing at localhost
   * is useless to the phone that scans it.
   */
  publicBaseUrl: (
    process.env.PUBLIC_BASE_URL ||
    process.env.RENDER_EXTERNAL_URL ||
    (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : '') ||
    (process.env.FLY_APP_NAME ? `https://${process.env.FLY_APP_NAME}.fly.dev` : '') ||
    ''
  ).replace(/\/+$/, ''),

  /** Allowance for network latency when deciding whether a submission was late. */
  submitGraceMs: 3_000,

  /** Request body cap; quizzes are small documents. */
  maxRequestBodyBytes: 256 * 1024,

  /**
   * Supabase is used when both of these are set; otherwise quizzes, attempts
   * and accounts stay in JSON files under dataDir. The service_role key
   * bypasses row level security, so it belongs on the server and nowhere else.
   */
  supabase: {
    url: process.env.SUPABASE_URL ?? '',
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',
    get enabled() {
      return Boolean(this.url && this.serviceRoleKey);
    },
  },

  limits: {
    titleMaxLength: 120,
    descriptionMaxLength: 500,
    questionMaxLength: 500,
    optionMaxLength: 200,
    participantNameMaxLength: 60,
    minOptions: 2,
    maxOptions: 6,
    minTimeLimitSeconds: 10,
    maxTimeLimitSeconds: 4 * 60 * 60,
    minPoints: 1,
    maxPoints: 100,
  },
};

/** The origin participants should be sent to, in priority order. */
export function resolveBaseUrl() {
  if (config.publicBaseUrl) return config.publicBaseUrl;
  const lanAddress = detectLanAddress();
  return `http://${lanAddress ?? 'localhost'}:${config.port}`;
}

export function buildJoinUrl(quizId) {
  return `${resolveBaseUrl()}/take/${quizId}`;
}

/**
 * Whether participants reach this app over TLS. When they do, the session
 * cookie is marked Secure; when they do not - a LAN address over plain HTTP -
 * marking it Secure would stop the browser storing it at all.
 */
export function usesHttps() {
  if (process.env.SEGUEQUIZ_SECURE_COOKIES === 'true') return true;
  if (process.env.SEGUEQUIZ_SECURE_COOKIES === 'false') return false;
  return resolveBaseUrl().startsWith('https://');
}

/** True when the app looks like it is running on a hosting platform. */
export function isHostedDeployment() {
  return Boolean(
    process.env.RENDER || process.env.RAILWAY_PUBLIC_DOMAIN || process.env.FLY_APP_NAME,
  );
}
