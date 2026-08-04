import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  renderCard,
  renderErrorCard,
  escapeXml,
  truncate,
  DEFAULT_OPTIONS,
  CARD_SIZE,
} from '../src/card.js';
import { initCrypto, encrypt, decrypt, safeEqual, randomToken } from '../src/crypto.js';
import { basePath } from '../src/base-path.js';

const PLAYING = {
  playing: true,
  title: 'Blinding Lights',
  artist: 'The Weeknd',
  album: 'After Hours',
  coverUrl: null,
  progressMs: 96000,
  durationMs: 200040,
  url: 'https://open.spotify.com/track/0VjIjW4GlUZAMYd2vXMi3b',
};
const PAUSED = { ...PLAYING, playing: false, progressMs: 0 };

// Any "&" that is not the head of an entity would make the SVG invalid XML.
const LOOSE_AMP = /&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/;

function assertWellFormed(svg, what) {
  assert.ok(svg.trimStart().startsWith('<svg'), `${what}: starts with <svg`);
  assert.ok(svg.trimEnd().endsWith('</svg>'), `${what}: ends with </svg>`);
  assert.ok(!LOOSE_AMP.test(svg), `${what}: every & is part of an entity`);
  // Escaping is what keeps these balanced; a raw < or > in text breaks it.
  assert.equal(svg.match(/</g).length, svg.match(/>/g).length, `${what}: angle brackets balanced`);
}

test('renderCard is well-formed XML for playing, paused and idle', () => {
  const playing = renderCard(PLAYING, null);
  assertWellFormed(playing, 'playing');
  assert.match(playing, /Now playing/);
  assert.match(playing, /Blinding Lights/);
  assert.match(playing, /1:36/); // progress, 96000ms
  assert.match(playing, /3:20/); // duration, 200040ms

  const paused = renderCard(PAUSED, null);
  assertWellFormed(paused, 'paused');
  assert.match(paused, /Last played/);
  assert.doesNotMatch(paused, /Now playing/);

  const idle = renderCard(null, null);
  assertWellFormed(idle, 'idle');
  assert.match(idle, /Not playing/);
  assert.match(idle, /Nothing is playing/);

  assertWellFormed(renderErrorCard('Something broke', 'Try again later'), 'error card');
});

test('renderCard inlines a cover data URI when one is supplied', () => {
  const uri = 'data:image/jpeg;base64,/9j/4AAQ';
  const svg = renderCard(PLAYING, uri);
  assertWellFormed(svg, 'with cover');
  assert.match(svg, /<image[^>]+href="data:image\/jpeg;base64/);
  assert.match(svg, /clipPath id="coverClip"/, 'the clip path the image references is defined');
  // Nothing references it without a cover, so it is not emitted.
  assert.doesNotMatch(renderCard(PLAYING, null), /coverClip/);
});

test('the equalizer is drawn in both states, dimmed when not playing', () => {
  // The .eq rule for the idle state styles bars that must actually exist.
  assert.ok(renderCard(PLAYING, null).includes('class="eq"'), 'playing has bars');
  assert.ok(renderCard(PAUSED, null).includes('class="eq"'), 'paused has bars too');
  assert.match(renderCard(PAUSED, null), /\.eq\{opacity:\.25/);
});

test('times floor, carry into hours, and never outrun the track', () => {
  const long = renderCard({ ...PLAYING, progressMs: 3_600_000, durationMs: 7_200_000 }, null);
  assert.match(long, /1:00:00/, 'progress carries into hours');
  assert.match(long, /2:00:00/, 'so does duration — not "120:00"');

  // 59.5s is still 0:59 everywhere else; rounding up disagreed with the bar.
  assert.match(renderCard({ ...PLAYING, progressMs: 59_500, durationMs: 59_500 }, null), /0:59/);

  // Only /api/demo.svg can feed unclamped numbers in, and it must not make the
  // fill animation run longer than the track.
  const negative = renderCard({ ...PLAYING, progressMs: -5000, durationMs: 200_040 }, null);
  assert.match(negative, /animation:fill 200040ms/);
  assert.doesNotMatch(negative, /animation:fill 205040ms/);
});

test('truncate measures wide scripts and cuts on grapheme boundaries', () => {
  // CJK is a full em, not the 0.55em a Latin letter averages: 60 of them are
  // far past the 332px text column and must be cut.
  const cjk = truncate('あ'.repeat(60), 332, 16);
  assert.ok(cjk.endsWith('…'), 'Japanese title was truncated');
  assert.ok(cjk.length <= 24, `cut to fit, got ${cjk.length} chars`);
  assert.ok(truncate('한글제목'.repeat(20), 332, 16).endsWith('…'), 'Hangul truncated');

  // One family emoji is a single ZWJ cluster — cutting inside it leaves debris.
  const family = '👩‍👩‍👧‍👦';
  const cut = truncate(family.repeat(20), 332, 16);
  assert.ok(cut.endsWith('…'), 'emoji title was truncated');
  assert.equal(cut.slice(0, -1).split(family).join(''), '', 'only whole clusters survive');
  assert.ok(!cut.includes('‍…'), 'no dangling zero-width joiner');
});

test('escapeXml neutralises hostile and special characters', () => {
  assert.equal(
    escapeXml(`</text><script>alert(1)</script>`),
    '&lt;/text&gt;&lt;script&gt;alert(1)&lt;/script&gt;',
  );
  assert.equal(escapeXml(`& " ' < >`), '&amp; &quot; &apos; &lt; &gt;');
  assert.equal(escapeXml(null), '');
  assert.equal(escapeXml('a' + String.fromCharCode(0, 1, 27) + 'bc'), 'abc'); // control chars stripped

  for (const title of [`</text><script>alert(1)</script>`, `Me & You "quoted" <b>'x'</b>`]) {
    const svg = renderCard({ ...PLAYING, title, artist: title }, null);
    assertWellFormed(svg, 'hostile title');
    assert.ok(!svg.includes('<script'), 'no raw <script in output');
    // The ticker legitimately emits adjacent <text> elements, so the guard is
    // that the title itself never appears unescaped — that is what escapeXml does.
    assert.ok(!svg.includes(title), 'the hostile title is escaped, never verbatim');
  }
});

test('truncate shortens long text and leaves short text alone', () => {
  assert.equal(truncate('Short title', 332, 16), 'Short title');
  assert.equal(truncate('', 332, 16), '');

  const long = 'Supercalifragilisticexpialidocious '.repeat(10);
  const cut = truncate(long, 332, 16);
  assert.ok(cut.length < long.length, 'was shortened');
  assert.ok(cut.endsWith('…'), 'got an ellipsis');
  assert.ok(long.startsWith(cut.slice(0, -1).trimEnd()), 'is a prefix of the original');
});

const DARK_ONLY = ['#121212', '#282828', '#b3b3b3', '#7a7a7a', '#404040', '#4d4d4d'];
const LIGHT_ONLY = ['#e5e7eb', '#111827', '#4b5563', '#6b7280', '#f3f4f6', '#9ca3af'];

test('themes are mutually exclusive palettes', () => {
  const dark = renderCard(PLAYING, null, { ...DEFAULT_OPTIONS });
  const light = renderCard(PLAYING, null, { ...DEFAULT_OPTIONS, theme: 'light' });
  assertWellFormed(light, 'light');

  // #ffffff is deliberately not in either list: it is the dark title and the
  // light background, so it is the one literal both themes legitimately share.
  for (const c of DARK_ONLY) {
    assert.ok(dark.includes(c), `dark uses ${c}`);
    assert.ok(!light.includes(c), `light must not leak ${c}`);
  }
  for (const c of LIGHT_ONLY) {
    assert.ok(light.includes(c), `light uses ${c}`);
    assert.ok(!dark.includes(c), `dark must not leak ${c}`);
  }

  // The muted timestamps and the progress track have to survive on white.
  assert.match(light, /\.time\{[^}]*fill:#6b7280/);
  assert.match(light, /height="4" rx="2" fill="#e5e7eb"/);

  // Unknown theme names fall back to dark rather than blowing up.
  assert.ok(renderCard(PLAYING, null, { theme: 'neon' }).includes('#121212'));
});

test('a hostile accent can never reach the stylesheet', () => {
  const hostile = [
    'red;}</style><script>alert(1)</script>',
    '#1ed760',
    'javascript:x',
    'ed7601ed760',
    '12345',
    '',
    null,
    undefined,
    { toString: () => 'red' },
  ];
  for (const accent of hostile) {
    const svg = renderCard(PLAYING, null, { accent });
    assertWellFormed(svg, `accent ${String(accent)}`);
    assert.ok(!svg.includes('<script'), 'no injected script');
    const css = svg.match(/<style>([\s\S]*?)<\/style>/)[1];
    assert.ok(!/[<>]/.test(css), 'no markup smuggled into the stylesheet');
    assert.ok(svg.includes('#1ed760'), 'fell back to the default accent');
  }

  // A valid accent is used verbatim, in 3 and 6 digit form, and replaces green.
  for (const accent of ['f0f', 'FF8800']) {
    const svg = renderCard(PLAYING, null, { accent });
    assertWellFormed(svg, accent);
    assert.ok(svg.includes(`#${accent}`), `${accent} applied`);
    assert.ok(!svg.includes('#1ed760'), 'the Spotify green is gone');
  }

  assertWellFormed(renderErrorCard('Boom', 'later', { accent: '"><script>' }), 'error accent');
});

test('the server parser and the renderer agree on a hostile accent', async () => {
  const { parseCardOptions } = await import('../src/card-options.js');
  const svg = renderCard(PLAYING, null, parseCardOptions({ accent: 'red;}</style><script>' }));
  assertWellFormed(svg, 'parsed hostile accent');
  assert.ok(svg.includes('#1ed760'), 'default survived the round trip');
  assert.ok(!svg.includes('<script'));
});

test('spin turns the cover into a record, paused when the track is not', () => {
  const spinning = renderCard(PLAYING, 'data:image/jpeg;base64,/9j/4AAQ', { spin: true });
  assertWellFormed(spinning, 'spin');
  assert.match(spinning, /@keyframes spin\{to\{transform:rotate\(360deg\)\}\}/);
  assert.match(spinning, /animation:spin 10s linear infinite/);
  assert.doesNotMatch(spinning, /animation-play-state:paused/);
  assert.match(spinning, /clipPath id="coverClip"><circle/, 'clipped to a circle, not a rect');
  assert.match(spinning, /<circle cx="66" cy="66" r="7"/, 'centre hole');

  const stopped = renderCard(PAUSED, null, { spin: true });
  assertWellFormed(stopped, 'spin paused');
  assert.match(stopped, /animation-play-state:paused/);

  assert.doesNotMatch(renderCard(PLAYING, null), /@keyframes spin/, 'off by default');
});

// Elapsed lines end in `class="time">`; the static duration carries text-anchor.
const elapsedLines = (svg) => svg.match(/class="time">/g)?.length ?? 0;

test('the ticker scrolls one line per second and freezes at the end', () => {
  const short = { ...PLAYING, progressMs: 0, durationMs: 10_000 };
  const svg = renderCard(short, null);
  assertWellFormed(svg, 'ticker');
  assert.equal(elapsedLines(svg), 11, 'remaining + 1 lines');
  assert.match(svg, /animation:tick 10s steps\(10\) -?0ms forwards/);
  assert.match(svg, /@keyframes tick\{to\{transform:translateY\(-120px\)\}\}/, '10 steps × 12px');
  assert.match(svg, /clipPath id="tickClip"><rect x="132" y="108" width="80" height="12"/);
  assert.match(svg, /class="time">0:00</, 'first line is the current position');
  assert.match(svg, /class="time">0:10</, 'last line is the total duration');

  // The first line must be the real elapsed value, for readers with animations
  // disabled — 96000ms is 1:36.
  const mid = renderCard(PLAYING, null);
  assert.equal(mid.indexOf('class="time">1:36<'), mid.indexOf('class="time">'));
  assert.equal(elapsedLines(mid), 105, '200 - 96 + 1');

  // The cap is the only thing between a card and an unbounded strip, so pin it
  // exactly: TICKER_MAX_SECONDS is 900, inclusive.
  const atCap = renderCard({ ...short, durationMs: 900_000 }, null);
  assert.equal(elapsedLines(atCap), 901, '900s still ticks');
  assert.match(atCap, /animation:tick 900s steps\(900\) -?0ms forwards/);

  // A negative delay equal to the sub-second remainder of the current position
  // pulls the first step onto the real next-second boundary. 96 400ms is 0.4s
  // into the second, so the strip starts 400ms in and steps 600ms later.
  const offBeat = renderCard({ ...PLAYING, progressMs: 96_400 }, null);
  assert.match(offBeat, /animation:tick 104s steps\(104\) -400ms forwards/);

  // Cap, not playing, and the explicit switch all fall back to one line.
  for (const [what, svgOut] of [
    ['one second past the cap', renderCard({ ...short, durationMs: 901_000 }, null)],
    ['20 minutes remaining', renderCard({ ...short, durationMs: 1_200_000 }, null)],
    ['paused', renderCard({ ...short, playing: false }, null)],
    ['ticker off', renderCard(short, null, { ticker: false })],
  ]) {
    assertWellFormed(svgOut, what);
    assert.equal(elapsedLines(svgOut), 1, `${what}: static line`);
    assert.doesNotMatch(svgOut, /@keyframes tick/, `${what}: no tick animation`);
  }
});

test('progress and equalizer toggles remove their rows cleanly', () => {
  const noProgress = renderCard(PLAYING, null, { progress: false });
  assertWellFormed(noProgress, 'no progress');
  assert.equal(elapsedLines(noProgress), 0, 'both timestamps gone');
  assert.doesNotMatch(noProgress, /class="fill"/, 'bar gone');
  assert.doesNotMatch(noProgress, /@keyframes tick/, 'ticker gone with it');
  // Rows re-balanced downwards so nothing is left floating at the top.
  assert.match(noProgress, /y="74" class="title"/);
  assert.match(noProgress, /y="94" class="artist"/);

  const noEq = renderCard(PLAYING, null, { equalizer: false });
  assertWellFormed(noEq, 'no equalizer');
  assert.ok(!noEq.includes('class="eq"'), 'bars gone');
  assert.doesNotMatch(noEq, /@keyframes eq/);
});

test('every option combination is well-formed at 480x132', () => {
  const size = new RegExp(`width="${CARD_SIZE.width}" height="${CARD_SIZE.height}"`);
  for (let mask = 0; mask < 32; mask++) {
    const options = {
      theme: mask & 1 ? 'light' : 'dark',
      spin: Boolean(mask & 2),
      accent: 'ff0055',
      progress: Boolean(mask & 4),
      equalizer: Boolean(mask & 8),
      ticker: Boolean(mask & 16),
    };
    const label = JSON.stringify(options);
    for (const track of [PLAYING, PAUSED, null]) {
      for (const cover of [null, 'data:image/png;base64,iVBOR']) {
        const svg = renderCard(track, cover, options);
        assertWellFormed(svg, label);
        assert.match(svg, size, `${label}: fixed size`);
        // Shape alone would pass even if renderCard ignored its options, so
        // check two of them actually reached the output.
        assert.equal(svg.includes('@keyframes spin'), options.spin, `${label}: spin honoured`);
        if (options.equalizer) assert.ok(svg.includes('#ff0055'), `${label}: accent honoured`);
      }
    }
    assertWellFormed(renderErrorCard('Broke', 'Retry', options), `error ${label}`);
  }
});

test('crypto round-trips and rejects tampering', () => {
  initCrypto(randomBytes(32).toString('base64'));

  const secret = 'AQD…refresh-token / ünïcødé ✓ 秘密';
  const payload = encrypt(secret);
  assert.notEqual(payload, secret);
  assert.equal(decrypt(payload), secret);
  assert.notEqual(encrypt(secret), encrypt(secret), 'random IV per encryption');

  const buf = Buffer.from(payload, 'base64');
  buf[buf.length - 1] ^= 0xff;
  assert.throws(() => decrypt(buf.toString('base64')), 'tampered ciphertext must not decrypt');
  assert.throws(() => decrypt('AAAA'), 'truncated payload must not decrypt');

  assert.throws(() => initCrypto('not-32-bytes'), /32 bytes/);
});

test('a freed GitHub login changes hands without destroying its old owner', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'readmeify-test-'));
  process.env.DB_PATH = join(dir, 'test.db');
  const { upsertGithubUser, getUserById, getUserByLogin, setSpotifyToken } =
    await import('../src/db.js');

  const victim = upsertGithubUser({ githubId: 1000, login: 'alice' });
  setSpotifyToken(victim.id, 'encrypted-refresh-token', 'Alice');

  // A different GitHub account registers the handle "alice" freed up on GitHub.
  const newOwner = upsertGithubUser({ githubId: 2000, login: 'Alice' });
  assert.notEqual(newOwner.id, victim.id);
  assert.ok(getUserById(victim.id), 'the displaced account still exists');
  assert.equal(
    getUserById(victim.id).spotify_refresh_token_enc,
    'encrypted-refresh-token',
    'and kept its stored connection',
  );
  assert.equal(getUserByLogin('alice').id, newOwner.id, 'the card URL follows the handle');

  // The same collision on the UPDATE path used to hit the UNIQUE constraint and
  // lock the renaming user out permanently.
  upsertGithubUser({ githubId: 3000, login: 'bob' });
  const renamed = upsertGithubUser({ githubId: 3000, login: 'alice' });
  assert.equal(renamed.id, getUserByLogin('alice').id);
  assert.ok(getUserById(newOwner.id), 'and again left the previous holder in place');

  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* the sqlite handle is still open on Windows; the temp dir is disposable */
  }
});

test('basePath derives the mount prefix from BASE_URL', () => {
  // Root mount: nothing to prefix, and `app.use('' , …)` would throw — server.js
  // relies on '' being falsy to fall back to '/'.
  assert.equal(basePath('http://127.0.0.1:3000'), '');
  assert.equal(basePath('http://127.0.0.1:3000/'), '');
  assert.equal(basePath('https://readmeify.example.com'), '');

  // Prefixed mount: leading slash kept, trailing slash dropped, so BASE_PATH
  // concatenates cleanly in both `BASE_PATH + '/'` and route mounting.
  assert.equal(basePath('https://maxencelobry.tech/readmeify'), '/readmeify');
  assert.equal(basePath('https://maxencelobry.tech/readmeify/'), '/readmeify');
  assert.equal(basePath('https://maxencelobry.tech/a/b'), '/a/b');

  // Anything that would boot into a wildcard mount, a 404 outage or a raw stack
  // trace must throw instead — server.js turns these into a one-line exit.
  assert.throws(() => basePath('localhost:3000'), /unsupported scheme/); // parses! pathname "3000"
  assert.throws(() => basePath('127.0.0.1:3000'), /Invalid URL/);
  assert.throws(() => basePath('https://example.com/my:app'), /unusable path prefix/); // mounts a wildcard
  assert.throws(() => basePath('https://example.com/app(1)'), /unusable path prefix/); // path-to-regexp throws
});

test('safeEqual compares exactly', () => {
  const token = randomToken();
  assert.equal(safeEqual(token, token), true);
  assert.equal(safeEqual(token, token + 'x'), false);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('abc', ''), false);
  assert.equal(safeEqual(undefined, 'undefined'), true); // documents the String() coercion
});
