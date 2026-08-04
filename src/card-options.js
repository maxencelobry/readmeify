// Card appearance options, read from the card URL's query string.
// Its own file only so it can be tested without importing server.js, which
// starts listening on import (same reason as base-path.js).
//
// Total by construction: every value is taken only when it is a plain string of
// a sane length, so Express handing back an array (?theme=a&theme=b), an object
// (?theme[x]=y), a null-prototype query, or a megabyte of junk all fall through
// to the default. A bad parameter must never produce an error card, let alone a
// 500. Unknown parameter names are simply not read.

const BOOL = new Map([
  ['1', true],
  ['true', true],
  ['yes', true],
  ['0', false],
  ['false', false],
  ['no', false],
]);
// A Map, not an object literal: `?spin=constructor` would otherwise resolve
// through the prototype and hand back a function instead of the default.

const ACCENT_RE = /^[0-9a-fA-F]{3}$|^[0-9a-fA-F]{6}$/;

const str = (v) => (typeof v === 'string' && v.length <= 32 ? v.trim().toLowerCase() : '');
// Booleans pass through: renderCard reuses this for hand-written option objects.
export const bool = (v, dflt) => (typeof v === 'boolean' ? v : BOOL.get(str(v)) ?? dflt);

export function parseCardOptions(query) {
  const q = query ?? {};
  const accent = str(q.accent);
  return {
    theme: str(q.theme) === 'light' ? 'light' : 'dark',
    spin: bool(q.spin, false),
    // Interpolated into the SVG's inline CSS, so nothing but 3 or 6 hex digits
    // may survive: `red;}</style><script>` has to end up as the default.
    accent: ACCENT_RE.test(accent) ? accent : '1ed760',
    progress: bool(q.progress, true),
    equalizer: bool(q.equalizer, true),
    ticker: bool(q.ticker, true),
  };
}
