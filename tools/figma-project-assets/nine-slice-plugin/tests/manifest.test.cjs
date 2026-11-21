const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, existsSync } = require('node:fs');
const path = require('node:path');

test('canonical manifest points at built main and UI files', () => {
  const manifest = JSON.parse(readFileSync(path.resolve('manifest.json'), 'utf8'));
  for (const field of ['main', 'ui']) {
    const target = path.resolve(manifest[field]);
    assert.ok(target.startsWith(path.resolve('.') + path.sep), field + ' must stay inside the plugin');
    assert.ok(existsSync(target), field + ' target does not exist; run npm run build first: ' + manifest[field]);
  }
  assert.equal(manifest.main, 'dist/code.js');
  assert.equal(manifest.ui, 'dist/ui.html');
});
