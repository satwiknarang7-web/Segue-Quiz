import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import { config, usesHttps } from '../config.js';
import { HttpError, badRequest, conflict, notFound } from '../lib/errors.js';
import { createId, createJoinCode } from '../lib/ids.js';
import {
  buildOtpauthUri,
  createTotpSecret,
  formatSecretForDisplay,
  verifyTotp,
} from '../lib/totp.js';
import { asString } from '../lib/validate.js';
import { userRepository } from '../repositories/userRepository.js';

const scrypt = promisify(crypto.scrypt);

const COOKIE_NAME = 'sq_session';
const ACTIVE_TTL_MS = 12 * 60 * 60 * 1000;
/** A half-finished sign-in should not sit around; it only needs to survive the 2FA step. */
const PENDING_TTL_MS = 10 * 60 * 1000;

const RECOVERY_CODE_COUNT = 8;
const MIN_PASSWORD_LENGTH = 10;

// Throttling, so neither a password nor a six-digit code can be ground down.
const MAX_FAILURES = 8;
const LOCKOUT_MS = 5 * 60 * 1000;
const failures = new Map();

let secretsCache = null;

/**
 * Server-wide secrets: the session signing key and the maker sign-up code.
 *
 * Both come from the environment when set, which is what a deployment must
 * do: a hosted container has no durable disk, so a generated key would be
 * replaced on every restart and sign every maker straight back out.
 *
 * With no environment settings they are generated once into the data
 * directory, which is what makes running locally a single command.
 */
function secrets() {
  if (secretsCache) return secretsCache;

  const fromEnvironment = {
    sessionSecret: process.env.SEGUEQUIZ_SESSION_SECRET ?? '',
    signupCode: process.env.SEGUEQUIZ_SIGNUP_CODE ?? '',
  };

  let stored = {};
  const needsFile = !fromEnvironment.sessionSecret || !fromEnvironment.signupCode;

  if (needsFile) {
    const file = path.join(config.dataDir, 'secrets.json');
    try {
      stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      stored = {};
    }

    let dirty = false;
    if (typeof stored.sessionSecret !== 'string' || stored.sessionSecret.length < 32) {
      stored.sessionSecret = crypto.randomBytes(32).toString('hex');
      dirty = true;
    }
    if (typeof stored.signupCode !== 'string' || stored.signupCode.length === 0) {
      stored.signupCode = createJoinCode(8);
      dirty = true;
    }
    if (dirty) {
      fs.mkdirSync(config.dataDir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(stored, null, 2), 'utf8');
    }
  }

  secretsCache = {
    sessionSecret: fromEnvironment.sessionSecret || stored.sessionSecret,
    sessionSecretFromEnvironment: Boolean(fromEnvironment.sessionSecret),
    signupCode: fromEnvironment.signupCode || stored.signupCode,
    signupCodeFromEnvironment: Boolean(fromEnvironment.signupCode),
  };
  return secretsCache;
}

/* ------------------------------------------------------------------ *
 * Primitives
 * ------------------------------------------------------------------ */

const base64url = (buffer) => Buffer.from(buffer).toString('base64url');

const signPayload = (payload) =>
  crypto.createHmac('sha256', secrets().sessionSecret).update(payload).digest('base64url');

function safeEqual(a, b) {
  const left = crypto.createHash('sha256').update(String(a)).digest();
  const right = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(left, right);
}

async function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const derived = await scrypt(password, salt, 64);
  return { salt, hash: derived.toString('hex') };
}

async function passwordMatches(password, user) {
  const { hash } = await hashPassword(password, user.passwordSalt);
  return safeEqual(hash, user.passwordHash);
}

const hashRecoveryCode = (code) =>
  crypto.createHash('sha256').update(code.replace(/\s|-/g, '').toUpperCase()).digest('hex');

function createRecoveryCodes() {
  const plain = Array.from({ length: RECOVERY_CODE_COUNT }, () =>
    `${createJoinCode(5)}-${createJoinCode(5)}`,
  );
  return { plain, stored: plain.map((code) => ({ hash: hashRecoveryCode(code), usedAt: null })) };
}

function parseCookies(header = '') {
  const jar = {};
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    jar[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return jar;
}

/* ------------------------------------------------------------------ *
 * Sessions
 *
 * Two stages: "pending" is issued once a password is accepted and only
 * unlocks the 2FA step; "active" is issued once the second factor is
 * proven and is what the organiser routes require.
 * ------------------------------------------------------------------ */

function buildCookie(user, stage) {
  const ttl = stage === 'active' ? ACTIVE_TTL_MS : PENDING_TTL_MS;
  const payload = base64url(
    JSON.stringify({
      userId: user.id,
      stage,
      version: user.tokenVersion,
      expiresAt: Date.now() + ttl,
    }),
  );

  const value = `${payload}.${signPayload(payload)}`;
  return [
    `${COOKIE_NAME}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    ...(usesHttps() ? ['Secure'] : []),
    `Max-Age=${Math.floor(ttl / 1000)}`,
  ].join('; ');
}

function readSession(req) {
  const raw = parseCookies(req.headers?.cookie ?? '')[COOKIE_NAME];
  if (!raw) return null;

  const separator = raw.lastIndexOf('.');
  if (separator === -1) return null;

  const payload = raw.slice(0, separator);
  const signature = raw.slice(separator + 1);
  if (!safeEqual(signature, signPayload(payload))) return null;

  let claims;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }

  if (!claims?.userId || claims.expiresAt < Date.now()) return null;

  const user = userRepository.findById(claims.userId);
  if (!user) return null;
  // Bumping tokenVersion signs every existing session out.
  if (user.tokenVersion !== claims.version) return null;

  return { user, stage: claims.stage };
}

/* ------------------------------------------------------------------ *
 * Throttling
 * ------------------------------------------------------------------ */

function assertNotLockedOut(key) {
  const record = failures.get(key);
  if (!record) return;
  if (Date.now() > record.resetAt) {
    failures.delete(key);
    return;
  }
  if (record.count >= MAX_FAILURES) {
    throw new HttpError(429, 'Too many attempts. Wait a few minutes and try again.');
  }
}

function recordFailure(key) {
  const record = failures.get(key);
  if (!record || Date.now() > record.resetAt) {
    failures.set(key, { count: 1, resetAt: Date.now() + LOCKOUT_MS });
    return;
  }
  record.count += 1;
}

/* ------------------------------------------------------------------ *
 * Public surface
 * ------------------------------------------------------------------ */

function publicUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    twoFactorEnabled: user.totpConfirmed,
    createdAt: user.createdAt,
  };
}

function enrolmentDetails(user) {
  const otpauthUri = buildOtpauthUri({
    secret: user.totpSecret,
    account: user.email,
    issuer: 'SegueQuiz',
  });
  return {
    otpauthUri,
    secret: formatSecretForDisplay(user.totpSecret),
    qrUrl: '/api/auth/2fa/qr.svg',
  };
}

export const accountService = {
  COOKIE_NAME,

  describeSignupCode() {
    const { signupCode, signupCodeFromEnvironment, sessionSecretFromEnvironment } = secrets();
    return {
      signupCode,
      fromEnvironment: signupCodeFromEnvironment,
      sessionSecretFromEnvironment,
      open: config.openSignup,
    };
  },

  readSession,

  /** The signed-in maker, or null when the second factor is still outstanding. */
  currentUser(req) {
    const session = readSession(req);
    return session?.stage === 'active' ? session.user : null;
  },

  signOutCookie() {
    const secure = usesHttps() ? ' Secure;' : '';
    return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax;${secure} Max-Age=0`;
  },

  async signUp({ name, email, password, signupCode }, clientKey) {
    assertNotLockedOut(clientKey);

    const cleanName = asString(name, 'name', { max: 80 });
    const cleanEmail = userRepository.normaliseEmail(asString(email, 'email', { max: 160 }));
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
      throw badRequest('Enter a valid email address.');
    }

    if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
      throw badRequest(`Choose a password of at least ${MIN_PASSWORD_LENGTH} characters.`);
    }

    if (!config.openSignup) {
      if (!signupCode || !safeEqual(String(signupCode).trim(), secrets().signupCode)) {
        recordFailure(clientKey);
        throw new HttpError(403, 'That maker code is not right. Ask whoever runs this server for it.');
      }
    }

    if (userRepository.findByEmail(cleanEmail)) {
      throw conflict('An account already exists for that email. Sign in instead.');
    }

    const { salt, hash } = await hashPassword(password);
    const isFirstAccount = userRepository.count() === 0;

    const user = userRepository.insert({
      id: createId(),
      name: cleanName,
      email: cleanEmail,
      passwordSalt: salt,
      passwordHash: hash,
      totpSecret: createTotpSecret(),
      totpConfirmed: false,
      recoveryCodes: [],
      tokenVersion: 1,
      createdAt: new Date().toISOString(),
      lastSignInAt: null,
    });

    return {
      user: publicUser(user),
      isFirstAccount,
      enrolment: enrolmentDetails(user),
      cookie: buildCookie(user, 'pending'),
    };
  },

  async signIn({ email, password }, clientKey) {
    assertNotLockedOut(clientKey);

    const user = userRepository.findByEmail(email);
    // Same message either way, so this cannot be used to enumerate accounts.
    const rejection = new HttpError(401, 'That email and password do not match.');

    if (!user) {
      recordFailure(clientKey);
      // Spend comparable time so a missing account is not obvious from latency.
      await hashPassword(String(password ?? ''), 'decoy-salt');
      throw rejection;
    }

    if (!(await passwordMatches(String(password ?? ''), user))) {
      recordFailure(clientKey);
      throw rejection;
    }

    return {
      cookie: buildCookie(user, 'pending'),
      // Somebody who never finished enrolling is sent back to finish it.
      needsEnrolment: !user.totpConfirmed,
      enrolment: user.totpConfirmed ? null : enrolmentDetails(user),
    };
  },

  /** The pending user, for the 2FA screens. Throws if there is no half-session. */
  requirePending(req) {
    const session = readSession(req);
    if (!session) throw new HttpError(401, 'Start again from the sign-in page.');
    return session;
  },

  enrolmentFor(user) {
    return enrolmentDetails(user);
  },

  /** Finish sign-up: prove the authenticator works, then hand over recovery codes. */
  activateTwoFactor(req, code, clientKey) {
    assertNotLockedOut(clientKey);
    const { user } = accountService.requirePending(req);

    if (user.totpConfirmed) throw conflict('Two-factor authentication is already switched on.');

    if (!verifyTotp(user.totpSecret, code)) {
      recordFailure(clientKey);
      throw badRequest('That code is not right. Check your authenticator app and try again.');
    }

    const { plain, stored } = createRecoveryCodes();
    const updated = userRepository.update(user.id, (current) => ({
      ...current,
      totpConfirmed: true,
      recoveryCodes: stored,
      lastSignInAt: new Date().toISOString(),
    }));

    failures.delete(clientKey);
    return {
      user: publicUser(updated),
      recoveryCodes: plain,
      cookie: buildCookie(updated, 'active'),
    };
  },

  /** Second step of sign-in: an authenticator code, or a one-time recovery code. */
  verifySecondFactor(req, code, clientKey) {
    assertNotLockedOut(clientKey);
    const { user } = accountService.requirePending(req);

    if (!user.totpConfirmed) {
      throw new HttpError(409, 'Finish setting up two-factor authentication first.');
    }

    const candidate = String(code ?? '').trim();
    if (verifyTotp(user.totpSecret, candidate)) {
      const updated = userRepository.update(user.id, (current) => ({
        ...current,
        lastSignInAt: new Date().toISOString(),
      }));
      failures.delete(clientKey);
      return { user: publicUser(updated), cookie: buildCookie(updated, 'active'), usedRecoveryCode: false };
    }

    const wanted = hashRecoveryCode(candidate);
    const match = user.recoveryCodes.find((entry) => entry.usedAt === null && entry.hash === wanted);

    if (match) {
      const updated = userRepository.update(user.id, (current) => ({
        ...current,
        lastSignInAt: new Date().toISOString(),
        recoveryCodes: current.recoveryCodes.map((entry) =>
          entry.hash === wanted ? { ...entry, usedAt: new Date().toISOString() } : entry,
        ),
      }));
      failures.delete(clientKey);
      const remaining = updated.recoveryCodes.filter((entry) => entry.usedAt === null).length;
      return { user: publicUser(updated), cookie: buildCookie(updated, 'active'), usedRecoveryCode: true, remaining };
    }

    recordFailure(clientKey);
    throw badRequest('That code is not right.');
  },

  requireUser(req) {
    const user = accountService.currentUser(req);
    if (!user) throw new HttpError(401, 'Sign in to do that.');
    return user;
  },

  describe(req) {
    const session = readSession(req);
    if (!session) return { authenticated: false, stage: 'anonymous' };
    if (session.stage !== 'active') {
      return {
        authenticated: false,
        stage: 'pending',
        needsEnrolment: !session.user.totpConfirmed,
      };
    }
    return { authenticated: true, stage: 'active', user: publicUser(session.user) };
  },

  findById(id) {
    const user = userRepository.findById(id);
    if (!user) throw notFound('That account does not exist.');
    return user;
  },
};
