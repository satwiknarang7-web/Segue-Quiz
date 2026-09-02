import test from 'node:test';
import assert from 'node:assert/strict';

import {
  base32Decode,
  base32Encode,
  buildOtpauthUri,
  createTotpSecret,
  generateTotp,
  verifyTotp,
} from '../src/lib/totp.js';

// The shared secret used throughout RFC 4226's appendix D test table.
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890', 'ascii'));

test('matches the RFC 4226 test vectors', () => {
  const expected = [
    '755224', '287082', '359152', '969429', '338314',
    '254676', '287922', '162583', '399871', '520489',
  ];

  // Counter n corresponds to the 30-second window starting at n * 30 seconds.
  const actual = expected.map((_, counter) => generateTotp(RFC_SECRET, counter * 30_000));
  assert.deepEqual(actual, expected);
});

test('base32 round-trips', () => {
  assert.equal(base32Decode(RFC_SECRET).toString('ascii'), '12345678901234567890');
  assert.equal(base32Encode(Buffer.from([0xde, 0xad, 0xbe, 0xef])), '32W353Y');
  assert.equal(base32Decode('32W353Y').subarray(0, 4).toString('hex'), 'deadbeef');
});

test('accepts a code from the neighbouring window but not a distant one', () => {
  const secret = createTotpSecret();
  const now = 1_700_000_000_000;

  assert.ok(verifyTotp(secret, generateTotp(secret, now), now));
  assert.ok(verifyTotp(secret, generateTotp(secret, now - 30_000), now), 'one window late');
  assert.ok(verifyTotp(secret, generateTotp(secret, now + 30_000), now), 'one window early');

  assert.ok(!verifyTotp(secret, generateTotp(secret, now - 120_000), now), 'four windows late');
  assert.ok(!verifyTotp(secret, generateTotp(secret, now + 120_000), now), 'four windows early');
});

test('rejects malformed codes without throwing', () => {
  const secret = createTotpSecret();
  for (const bad of ['', '12345', '1234567', 'abcdef', null, undefined, '  ']) {
    assert.equal(verifyTotp(secret, bad), false, `should reject ${JSON.stringify(bad)}`);
  }
});

test('a code for one secret does not work for another', () => {
  const a = createTotpSecret();
  const b = createTotpSecret();
  assert.ok(!verifyTotp(b, generateTotp(a)));
});

test('generates secrets with enough entropy', () => {
  const secret = createTotpSecret();
  assert.equal(base32Decode(secret).length, 20, '160-bit secret');
  assert.notEqual(secret, createTotpSecret());
});

test('builds an otpauth URI an authenticator app can read', () => {
  const uri = buildOtpauthUri({
    secret: RFC_SECRET,
    account: 'maker@example.test',
    issuer: 'SegueQuiz',
  });

  const parsed = new URL(uri);
  assert.equal(parsed.protocol, 'otpauth:');
  assert.equal(decodeURIComponent(parsed.pathname.slice(1)), 'SegueQuiz:maker@example.test');
  assert.equal(parsed.searchParams.get('secret'), RFC_SECRET);
  assert.equal(parsed.searchParams.get('issuer'), 'SegueQuiz');
  assert.equal(parsed.searchParams.get('digits'), '6');
  assert.equal(parsed.searchParams.get('period'), '30');
});
