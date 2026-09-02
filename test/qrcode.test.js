import test from 'node:test';
import assert from 'node:assert/strict';

import { createQrCode, renderQrPng, renderQrSvg } from '../src/lib/qrcode.js';

/* ------------------------------------------------------------------ *
 * A deliberately independent decoder.
 *
 * It rebuilds the function-module map from the specification rather than
 * from the encoder, reads the format information back out, un-masks the
 * matrix, de-interleaves the blocks and checks that every Reed-Solomon
 * syndrome is zero. A QR code that survives all of that is a valid QR
 * code, which is the closest we can get to "a phone can scan it" in a
 * unit test.
 * ------------------------------------------------------------------ */

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let value = 1;
  for (let i = 0; i < 255; i += 1) {
    EXP[i] = value;
    LOG[value] = i;
    value = (value << 1) ^ (value & 0x80 ? 0x11d : 0);
  }
  for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255];
})();

const mul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

const ALIGNMENT = [
  null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34],
  [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50],
];

// Published byte-mode character capacities, transcribed from the QR
// capacity tables. These are an independent cross-check of the encoder's
// block/error-correction tables.
const BYTE_CAPACITY = {
  L: [null, 17, 32, 53, 78, 106, 134, 154, 192, 230, 271],
  M: [null, 14, 26, 42, 62, 84, 106, 122, 152, 180, 213],
  Q: [null, 11, 20, 32, 46, 60, 74, 86, 108, 130, 151],
  H: [null, 7, 14, 24, 34, 44, 58, 64, 84, 98, 119],
};

const EC_SPECS = {
  L: [null, [7, 1], [10, 1], [15, 1], [20, 1], [26, 1], [18, 2], [20, 2], [24, 2], [30, 2], [18, 4]],
  M: [null, [10, 1], [16, 1], [26, 1], [18, 2], [24, 2], [16, 4], [18, 4], [22, 4], [22, 5], [26, 5]],
  Q: [null, [13, 1], [22, 1], [18, 2], [26, 2], [18, 4], [24, 4], [18, 6], [22, 6], [20, 8], [24, 8]],
  H: [null, [17, 1], [28, 1], [22, 2], [16, 4], [22, 4], [28, 4], [26, 5], [26, 6], [24, 8], [28, 8]],
};
const TOTAL_CODEWORDS = [null, 26, 44, 70, 100, 134, 172, 196, 242, 292, 346];
const LEVEL_BY_FORMAT_BITS = { 1: 'L', 0: 'M', 3: 'Q', 2: 'H' };

/** Which modules are function patterns, derived from the spec, not the encoder. */
function functionModuleMap(version) {
  const size = version * 4 + 17;
  const reserved = Array.from({ length: size }, () => new Array(size).fill(false));
  const reserve = (x, y) => {
    if (x >= 0 && x < size && y >= 0 && y < size) reserved[y][x] = true;
  };

  // Finder patterns, their separators and the adjacent format information:
  // 9x9 in the top-left, 8x9 in the top-right, 9x8 in the bottom-left.
  for (let y = 0; y <= 8; y += 1) {
    for (let x = 0; x <= 8; x += 1) reserve(x, y);
  }
  for (let y = 0; y <= 8; y += 1) {
    for (let x = 0; x <= 7; x += 1) reserve(size - 1 - x, y);
  }
  for (let y = 0; y <= 7; y += 1) {
    for (let x = 0; x <= 8; x += 1) reserve(x, size - 1 - y);
  }
  // Timing patterns.
  for (let i = 0; i < size; i += 1) {
    reserve(6, i);
    reserve(i, 6);
  }
  // Alignment patterns.
  const centres = ALIGNMENT[version];
  const last = centres.length - 1;
  for (let i = 0; i <= last; i += 1) {
    for (let j = 0; j <= last; j += 1) {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy += 1) {
        for (let dx = -2; dx <= 2; dx += 1) reserve(centres[i] + dx, centres[j] + dy);
      }
    }
  }
  // Version information blocks.
  if (version >= 7) {
    for (let i = 0; i < 6; i += 1) {
      for (let j = 0; j < 3; j += 1) {
        reserve(size - 11 + j, i);
        reserve(i, size - 11 + j);
      }
    }
  }
  return reserved;
}

/** Read the 15 format bits from the primary copy and undo the BCH masking. */
function readFormatInfo(modules) {
  const size = modules.length;
  const bit = (x, y) => (modules[y][x] ? 1 : 0);
  let raw = 0;
  for (let i = 0; i <= 5; i += 1) raw |= bit(8, i) << i;
  raw |= bit(8, 7) << 6;
  raw |= bit(8, 8) << 7;
  raw |= bit(7, 8) << 8;
  for (let i = 9; i < 15; i += 1) raw |= bit(14 - i, 8) << i;

  const unmasked = raw ^ 0x5412;
  // Verify the BCH(15,5) code word is intact.
  let remainder = unmasked;
  for (let i = 14; i >= 10; i -= 1) {
    if ((remainder >>> i) & 1) remainder ^= 0x537 << (i - 10);
  }
  assert.equal(remainder, 0, 'format information failed its BCH check');

  const data = unmasked >>> 10;
  return { ecLevel: LEVEL_BY_FORMAT_BITS[data >>> 3], mask: data & 0b111 };
}

/** Read the second copy of the format bits so both must agree. */
function readSecondaryFormatInfo(modules) {
  const size = modules.length;
  const bit = (x, y) => (modules[y][x] ? 1 : 0);
  let raw = 0;
  for (let i = 0; i < 8; i += 1) raw |= bit(size - 1 - i, 8) << i;
  for (let i = 8; i < 15; i += 1) raw |= bit(8, size - 15 + i) << i;
  const data = (raw ^ 0x5412) >>> 10;
  return { ecLevel: LEVEL_BY_FORMAT_BITS[data >>> 3], mask: data & 0b111 };
}

function readCodewords(modules, reserved, mask) {
  const size = modules.length;
  const shouldFlip = MASKS[mask];
  const bits = [];

  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vertical = 0; vertical < size; vertical += 1) {
      for (let column = 0; column < 2; column += 1) {
        const x = right - column;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vertical : vertical;
        if (reserved[y][x]) continue;
        const value = modules[y][x] !== shouldFlip(x, y); // XOR removes the mask
        bits.push(value ? 1 : 0);
      }
    }
  }

  const codewords = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j += 1) byte = (byte << 1) | bits[i + j];
    codewords.push(byte);
  }
  return codewords;
}

function deinterleave(codewords, version, ecLevel) {
  const [ecPerBlock, blockCount] = EC_SPECS[ecLevel][version];
  const totalData = TOTAL_CODEWORDS[version] - ecPerBlock * blockCount;
  const shortLength = Math.floor(totalData / blockCount);
  const longCount = totalData % blockCount;

  const lengths = Array.from({ length: blockCount }, (_, i) =>
    i >= blockCount - longCount ? shortLength + 1 : shortLength,
  );
  const dataBlocks = lengths.map(() => []);
  const ecBlocks = Array.from({ length: blockCount }, () => []);

  let cursor = 0;
  for (let i = 0; i < shortLength + 1; i += 1) {
    for (let b = 0; b < blockCount; b += 1) {
      if (i < lengths[b]) dataBlocks[b].push(codewords[cursor++]);
    }
  }
  for (let i = 0; i < ecPerBlock; i += 1) {
    for (let b = 0; b < blockCount; b += 1) ecBlocks[b].push(codewords[cursor++]);
  }
  return { dataBlocks, ecBlocks, ecPerBlock };
}

/** Every syndrome of an undamaged Reed-Solomon code word is zero. */
function assertSyndromesAreZero(dataBlocks, ecBlocks, ecPerBlock) {
  dataBlocks.forEach((data, index) => {
    const full = [...data, ...ecBlocks[index]];
    for (let s = 0; s < ecPerBlock; s += 1) {
      let value = 0;
      for (const coefficient of full) value = mul(value, EXP[s]) ^ coefficient;
      assert.equal(value, 0, `block ${index} failed Reed-Solomon syndrome ${s}`);
    }
  });
}

function decode(qr) {
  const reserved = functionModuleMap(qr.version);
  const format = readFormatInfo(qr.modules);
  assert.deepEqual(readSecondaryFormatInfo(qr.modules), format, 'format copies disagree');

  const codewords = readCodewords(qr.modules, reserved, format.mask);
  assert.equal(
    codewords.length,
    TOTAL_CODEWORDS[qr.version],
    'unexpected number of codewords recovered',
  );

  const { dataBlocks, ecBlocks, ecPerBlock } = deinterleave(codewords, qr.version, format.ecLevel);
  assertSyndromesAreZero(dataBlocks, ecBlocks, ecPerBlock);

  const data = dataBlocks.flat();
  const bits = data.flatMap((byte) => [...Array(8).keys()].map((i) => (byte >>> (7 - i)) & 1));
  const take = (count, offset) => bits.slice(offset, offset + count).reduce((a, b) => (a << 1) | b, 0);

  assert.equal(take(4, 0), 0b0100, 'expected byte mode');
  const countBits = qr.version <= 9 ? 8 : 16;
  const length = take(countBits, 4);

  const bytes = [];
  for (let i = 0; i < length; i += 1) bytes.push(take(8, 4 + countBits + i * 8));

  return { text: Buffer.from(bytes).toString('utf8'), ecLevel: format.ecLevel, mask: format.mask };
}

/* ------------------------------------------------------------------ *
 * Tests
 * ------------------------------------------------------------------ */

test('encodes and decodes a join URL at every error correction level', () => {
  const url = 'http://192.168.1.20:4000/take/7HQ4KD';
  for (const ecLevel of ['L', 'M', 'Q', 'H']) {
    const qr = createQrCode(url, { ecLevel });
    const decoded = decode(qr);
    assert.equal(decoded.text, url);
    assert.equal(decoded.ecLevel, ecLevel);
    assert.equal(decoded.mask, qr.mask);
  }
});

test('round-trips content across every supported version', () => {
  for (let version = 1; version <= 10; version += 1) {
    const payload = 'S'.repeat(BYTE_CAPACITY.M[version]);
    const qr = createQrCode(payload, { ecLevel: 'M' });
    assert.equal(qr.version, version, `version ${version} capacity boundary`);
    assert.equal(decode(qr).text, payload);
  }
});

test('matches the published byte-mode capacity tables', () => {
  for (const ecLevel of ['L', 'M', 'Q', 'H']) {
    for (let version = 1; version <= 10; version += 1) {
      const capacity = BYTE_CAPACITY[ecLevel][version];
      assert.equal(
        createQrCode('x'.repeat(capacity), { ecLevel }).version,
        version,
        `${capacity} bytes should fit version ${version}${ecLevel}`,
      );
      if (version < 10) {
        assert.equal(
          createQrCode('x'.repeat(capacity + 1), { ecLevel }).version,
          version + 1,
          `${capacity + 1} bytes should overflow version ${version}${ecLevel}`,
        );
      }
    }
  }
});

test('round-trips unicode content', () => {
  const text = 'Quiz: café ☕ — round 1';
  assert.equal(decode(createQrCode(text)).text, text);
});

test('draws the three finder patterns', () => {
  const qr = createQrCode('https://example.test/take/ABC123');
  const corners = [
    [0, 0],
    [qr.size - 7, 0],
    [0, qr.size - 7],
  ];
  for (const [ox, oy] of corners) {
    for (let dy = 0; dy < 7; dy += 1) {
      for (let dx = 0; dx < 7; dx += 1) {
        const ring = Math.max(Math.abs(dx - 3), Math.abs(dy - 3));
        assert.equal(qr.modules[oy + dy][ox + dx], ring !== 2, `finder at ${ox},${oy}`);
      }
    }
  }
});

test('draws alternating timing patterns', () => {
  const qr = createQrCode('https://example.test/take/ABC123');
  for (let i = 8; i < qr.size - 8; i += 1) {
    assert.equal(qr.modules[6][i], i % 2 === 0, `horizontal timing at ${i}`);
    assert.equal(qr.modules[i][6], i % 2 === 0, `vertical timing at ${i}`);
  }
});

test('rejects content that cannot fit', () => {
  assert.throws(() => createQrCode('x'.repeat(300)), /too long/i);
  assert.throws(() => createQrCode(''), /non-empty/i);
  assert.throws(() => createQrCode('hi', { ecLevel: 'Z' }), /error correction/i);
});

test('renders an SVG with a quiet zone', () => {
  const svg = renderQrSvg('https://example.test/take/ABC123', { size: 240, margin: 4 });
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="240" height="240"/);
  const qr = createQrCode('https://example.test/take/ABC123');
  assert.match(svg, new RegExp(`viewBox="0 0 ${qr.size + 8} ${qr.size + 8}"`));
  assert.match(svg, /<path fill="#0f172a" d="M/);
});

test('renders a valid PNG', () => {
  const png = renderQrPng('https://example.test/take/ABC123', { scale: 4, margin: 4 });
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(png.subarray(12, 16).toString('ascii'), 'IHDR');
  const qr = createQrCode('https://example.test/take/ABC123');
  const expected = (qr.size + 8) * 4;
  assert.equal(png.readUInt32BE(16), expected);
  assert.equal(png.readUInt32BE(20), expected);
  assert.equal(png.subarray(png.length - 8, png.length - 4).toString('ascii'), 'IEND');
});
