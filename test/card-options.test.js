import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCardOptions } from '../src/card-options.js';

const DEFAULTS = {
  theme: 'dark',
  spin: false,
  accent: '1ed760',
  progress: true,
  equalizer: true,
  ticker: true,
};

test('parseCardOptions defaults, and reads every documented value', () => {
  assert.deepEqual(parseCardOptions({}), DEFAULTS);
  assert.deepEqual(
    parseCardOptions({
      theme: 'light',
      spin: 'yes',
      accent: 'FF0000',
      progress: '0',
      equalizer: 'false',
      ticker: 'NO',
    }),
    { theme: 'light', spin: true, accent: 'ff0000', progress: false, equalizer: false, ticker: false },
  );
  assert.equal(parseCardOptions({ spin: 'TRUE' }).spin, true);
  assert.equal(parseCardOptions({ accent: 'f0a' }).accent, 'f0a');
});

test('parseCardOptions is total: junk falls back, nothing throws', () => {
  const junk = [
    undefined,
    null,
    { theme: ['dark', 'light'], spin: { x: 'y' }, accent: 42, ticker: () => {} }, // arrays/objects
    Object.assign(Object.create(null), { theme: 'light' }), // null prototype
    { theme: 'x'.repeat(100_000), accent: 'a'.repeat(100_000) },
    { spin: 'constructor', ticker: '__proto__', progress: 'toString' }, // prototype keys
  ];
  for (const q of junk) {
    const opts = parseCardOptions(q);
    assert.deepEqual(Object.keys(opts).sort(), Object.keys(DEFAULTS).sort());
    for (const [k, v] of Object.entries(DEFAULTS)) {
      if (q && q[k] === 'light') continue; // the one legitimate value in the list
      assert.equal(opts[k], v, `${k} fell back to the default`);
    }
  }
});

test('accent cannot smuggle anything into the inline CSS', () => {
  for (const accent of [
    'red;}</style><script>',
    '#1ed760',
    '1ed76',
    'ggg',
    'ff0000;',
    ' 1ed760 x',
    'url(javascript:alert(1))',
  ]) {
    assert.equal(parseCardOptions({ accent }).accent, '1ed760', accent);
  }
  // Whitespace-padded but otherwise valid is accepted, still hex-only.
  assert.equal(parseCardOptions({ accent: '  ABCDEF ' }).accent, 'abcdef');
});
