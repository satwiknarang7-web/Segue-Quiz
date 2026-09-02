import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function collect(directory, extension) {
  const found = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...collect(full, extension));
    else if (entry.name.endsWith(extension)) found.push(full);
  }
  return found;
}

/**
 * server.js is the one file the other tests never import - they mount the app
 * directly rather than start a listener - so a syntax error in it would only
 * ever surface at run time. Parse every source file instead.
 */
test('every source file parses', () => {
  const files = [
    ...collect(path.join(root, 'src'), '.js'),
    ...collect(path.join(root, 'public', 'js'), '.js'),
    ...collect(path.join(root, 'scripts'), '.mjs'),
  ];

  assert.ok(files.length > 20, `expected to find the source tree, found ${files.length} files`);

  for (const file of files) {
    assert.doesNotThrow(
      () => execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' }),
      `${path.relative(root, file)} does not parse`,
    );
  }
});

test('no source file still refers to the old passcode auth', () => {
  const files = collect(path.join(root, 'src'), '.js');
  for (const file of files) {
    const contents = fs.readFileSync(file, 'utf8');
    assert.ok(
      !contents.includes('authService'),
      `${path.relative(root, file)} references the removed authService`,
    );
  }
});
