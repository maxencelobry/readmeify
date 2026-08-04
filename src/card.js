/**
 * SVG card renderer.
 *
 * Only plain SVG primitives are used — no <foreignObject>. GitHub serves the
 * card through its camo image proxy inside an <img> tag, and browsers do not
 * render foreign (HTML) content in that context. CSS @keyframes inside the SVG
 * do work there, which is what animates the equalizer, the progress bar, the
 * spinning cover and the ticking elapsed time.
 */

import { bool } from './card-options.js';

const W = 480;
const H = 132;
const PAD = 16;
const COVER = 100;
const TEXT_X = PAD + COVER + PAD; // 132
const TEXT_W = W - TEXT_X - PAD; // 332
const CX = PAD + COVER / 2; // 66 — cover centre, also the spin origin
const BAR_Y = 100;
const TIME_Y = BAR_Y + 18; // 118 — baseline of both timestamps
const LINE_H = 12; // one ticker line; also the height of the clip window

// Ticker cap: past this many seconds remaining the strip would be thousands of
// <text> nodes for a clock nobody watches that long. Emit one static line.
const TICKER_MAX_SECONDS = 900;

const THEMES = {
  dark: {
    bg: '#121212',
    border: '#282828',
    title: '#ffffff',
    subtitle: '#b3b3b3',
    muted: '#7a7a7a',
    track: '#404040',
    art: '#282828',
    placeholderGlyph: '#4d4d4d',
  },
  light: {
    bg: '#ffffff',
    border: '#e5e7eb',
    title: '#111827',
    subtitle: '#4b5563',
    muted: '#6b7280',
    track: '#e5e7eb',
    art: '#f3f4f6',
    placeholderGlyph: '#9ca3af',
  },
};

export const DEFAULT_OPTIONS = {
  theme: 'dark',
  spin: false,
  accent: '1ed760',
  progress: true,
  equalizer: true,
  ticker: true,
};

const ACCENT_RE = /^[0-9a-fA-F]{3}$|^[0-9a-fA-F]{6}$/;

// The server normalises the query string, but `accent` lands inside inline CSS,
// so it is re-validated here: no caller can smuggle a `}</style>` through.
function normalise(options) {
  const o = { ...DEFAULT_OPTIONS, ...(options || {}) };
  return {
    theme: o.theme === 'light' ? 'light' : 'dark',
    accent: ACCENT_RE.test(String(o.accent)) ? String(o.accent) : DEFAULT_OPTIONS.accent,
    // Same coercion as the query string, so a hand-written `{ spin: 'no' }`
    // means what it says instead of being truthy.
    spin: bool(o.spin, DEFAULT_OPTIONS.spin),
    progress: bool(o.progress, DEFAULT_OPTIONS.progress),
    equalizer: bool(o.equalizer, DEFAULT_OPTIONS.equalizer),
    ticker: bool(o.ticker, DEFAULT_OPTIONS.ticker),
  };
}

const FONT =
  "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

export function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    // Strip control characters that would make the SVG invalid XML.
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
}

// Rough advance widths as a fraction of the font size, per character class.
// Good enough to decide where to cut a string; no font metrics needed.
const NARROW = new Set([...`iljtfrI!.,;:'"|()[]{}\` `]);
const WIDE = new Set([...'mwMW@%']);

// Graphemes, not code points: an emoji ZWJ sequence is one glyph, and cutting
// inside it (or between a letter and its combining mark) mangles the text.
const GRAPHEMES = new Intl.Segmenter('en', { granularity: 'grapheme' });
const clusters = (text) => [...GRAPHEMES.segment(text)].map((s) => s.segment);

function charWidth(ch, size) {
  if (NARROW.has(ch)) return size * 0.34;
  if (WIDE.has(ch)) return size;
  if (ch >= 'A' && ch <= 'Z') return size * 0.66;
  const cp = ch.codePointAt(0);
  // Emoji are drawn wider than square, and CJK / Hangul / fullwidth forms are
  // square — a full em, not the 0.55em a Latin letter averages.
  if (cp >= 0x1f300 || (cp >= 0x2600 && cp <= 0x27bf)) return size * 1.15;
  if (cp >= 0x2e80 || (cp >= 0x1100 && cp <= 0x115f)) return size;
  return size * 0.55;
}

function textWidth(text, size) {
  let total = 0;
  for (const ch of clusters(text)) total += charWidth(ch, size);
  return total;
}

/** Cuts a string to fit `maxWidth`, appending an ellipsis when it had to. */
export function truncate(text, maxWidth, size) {
  const str = String(text ?? '');
  if (textWidth(str, size) <= maxWidth) return str;
  const budget = maxWidth - charWidth('…', size);
  let out = '';
  let used = 0;
  for (const ch of clusters(str)) {
    const w = charWidth(ch, size);
    if (used + w > budget) break;
    out += ch;
    used += w;
  }
  return out.trimEnd() + '…';
}

function fmtTime(ms) {
  // Floor, like every media player: 59.5s is still 0:59, not 1:00.
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor(total / 60) % 60;
  const s = String(total % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

// Spotify glyph, drawn on a 24×24 grid.
const SPOTIFY_PATH =
  'M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z';

// `animate` is false for the error card, which has no @keyframes spin of its own:
// without it the class would be a dead attribute.
function coverMarkup(dataUri, t, o, animate = true) {
  const glyphScale = (40 / 24).toFixed(4);
  const gx = PAD + (COVER - 40) / 2;
  const inner = dataUri
    ? `<image x="${PAD}" y="${PAD}" width="${COVER}" height="${COVER}" href="${escapeXml(
        dataUri,
      )}" preserveAspectRatio="xMidYMid slice" clip-path="url(#coverClip)"/>`
    : // Placeholder: flat tile with a dimmed Spotify glyph, no network needed.
      `${
        o.spin
          ? `<circle cx="${CX}" cy="${CX}" r="${COVER / 2}" fill="${t.art}"/>`
          : `<rect x="${PAD}" y="${PAD}" width="${COVER}" height="${COVER}" rx="8" fill="${t.art}"/>`
      }
    <g transform="translate(${gx} ${gx}) scale(${glyphScale})" fill="${t.placeholderGlyph}">
      <path d="${SPOTIFY_PATH}"/>
    </g>`;

  if (!o.spin) return inner;
  // Hole and ring stay outside the rotating group — concentric, so spinning them
  // would be invisible work. Only over real art: on the placeholder they would
  // punch a disc straight through the Spotify glyph. The hole is the card
  // background with a hairline, so its edge reads on dark covers too.
  return `<g${animate ? ' class="art"' : ''}>${inner}</g>${
    dataUri
      ? `
  <circle cx="${CX}" cy="${CX}" r="18" fill="none" stroke="${t.bg}" stroke-width="1" opacity=".35"/>
  <circle cx="${CX}" cy="${CX}" r="7" fill="${t.bg}" stroke="${t.border}"/>`
      : ''
  }`;
}

function equalizer(x, y, accent) {
  return [620, 480, 730, 550]
    .map(
      (d, i) =>
        `<rect class="eq" x="${x + i * 6}" y="${y - 12}" width="3" height="12" rx="1.5" fill="#${accent}" style="animation-duration:${d}ms"/>`,
    )
    .join('');
}

/**
 * @param {object|null} track  normalised playback data, or null when idle
 * @param {string|null} coverDataUri  inlined album art
 * @param {object} [options]  see DEFAULT_OPTIONS
 */
export function renderCard(track, coverDataUri, options) {
  const o = normalise(options);
  const t = THEMES[o.theme];
  const playing = Boolean(track?.playing);
  const hasTrack = Boolean(track);

  const status = playing ? 'Now playing' : hasTrack ? 'Last played' : 'Not playing';
  const statusColor = playing ? `#${o.accent}` : t.muted;
  const title = hasTrack ? track.title : 'Nothing is playing';
  const artist = hasTrack ? track.artist : 'Spotify is idle right now';

  // Clamped here, not trusted: /api/demo.svg renders sample-data.json verbatim.
  const duration = Math.max(0, Number(track?.durationMs) || 0);
  const progress = Math.min(Math.max(0, Number(track?.progressMs) || 0), duration);
  const ratio = duration > 0 ? Math.min(1, Math.max(0, progress / duration)) : 0;
  const remaining = Math.max(0, duration - progress);
  const showBar = o.progress && duration > 0 && hasTrack;

  // Without the bar row the text column would sit high on the card; drop it so
  // it stays centred against the 100px cover.
  const dy = showBar ? 0 : 16;

  // While a track plays, run the fill forward in real time so the card keeps
  // moving between the ~10s server-side refreshes.
  const progressAnim =
    showBar && playing && remaining > 0
      ? `@keyframes fill{from{transform:scaleX(${ratio.toFixed(4)})}to{transform:scaleX(1)}}
         .fill{transform-origin:${TEXT_X}px ${BAR_Y}px;animation:fill ${remaining}ms linear forwards}`
      : '';

  const eqAnim = !o.equalizer
    ? ''
    : playing
      ? `@keyframes eq{0%{transform:scaleY(.18)}100%{transform:scaleY(1)}}
       .eq{transform-box:fill-box;transform-origin:bottom;animation-name:eq;animation-iteration-count:infinite;animation-direction:alternate;animation-timing-function:ease-in-out}`
      : '.eq{opacity:.25;transform-box:fill-box;transform-origin:bottom;transform:scaleY(.35)}';

  const spinAnim = o.spin
    ? `@keyframes spin{to{transform:rotate(360deg)}}
       .art{transform-origin:${CX}px ${CX}px;animation:spin 10s linear infinite${
         playing ? '' : ';animation-play-state:paused'
       }}`
    : '';

  // Ticker: one <text> line per second from the current position to the end of
  // the track, scrolled up through a one-line clip window. steps(R) over R
  // seconds lands each step exactly LINE_H further, and `forwards` freezes the
  // strip on the last line (= the total duration) instead of wrapping.
  const startSec = Math.floor(progress / 1000);
  const endSec = Math.floor(duration / 1000);
  const R = endSec - startSec;
  const ticking = showBar && playing && o.ticker && R >= 1 && R <= TICKER_MAX_SECONDS;

  let tickerMarkup = `<text x="${TEXT_X}" y="${TIME_Y}" class="time">${fmtTime(progress)}</text>`;
  let tickerAnim = '';
  if (ticking) {
    let lines = '';
    for (let i = 0; i <= R; i++) {
      lines += `<text x="${TEXT_X}" y="${TIME_Y + i * LINE_H}" class="time">${fmtTime(
        (startSec + i) * 1000,
      )}</text>`;
    }
    tickerMarkup = `<g clip-path="url(#tickClip)"><g class="tick">${lines}</g></g>`;
    // The negative delay is the sub-second remainder of the current position:
    // it starts the animation already that far in, so the first step lands on
    // the real next-second boundary and the last one lands exactly at the end
    // of the track, instead of both trailing by up to 999ms.
    tickerAnim = `@keyframes tick{to{transform:translateY(-${R * LINE_H}px)}}
       .tick{animation:tick ${R}s steps(${R}) ${-(progress % 1000)}ms forwards}`;
  }

  const timesRow = showBar
    ? `${tickerMarkup}
  <text x="${TEXT_X + TEXT_W}" y="${TIME_Y}" class="time" text-anchor="end">${fmtTime(duration)}</text>`
    : '';

  const titleSize = 16;
  const artistSize = 13;
  const fillW = Math.max(4, TEXT_W * ratio);

  const defs = [
    coverDataUri
      ? o.spin
        ? `<clipPath id="coverClip"><circle cx="${CX}" cy="${CX}" r="${COVER / 2}"/></clipPath>`
        : `<clipPath id="coverClip"><rect x="${PAD}" y="${PAD}" width="${COVER}" height="${COVER}" rx="8"/></clipPath>`
      : '',
    ticking
      ? `<clipPath id="tickClip"><rect x="${TEXT_X}" y="${TIME_Y - 10}" width="80" height="${LINE_H}"/></clipPath>`
      : '',
  ].join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${escapeXml(
    `${status}: ${title} by ${artist}`,
  )}">
  <title>${escapeXml(`${status} — ${title} · ${artist}`)}</title>
  ${defs ? `<defs>${defs}</defs>` : ''}
  <style>
    text{font-family:${FONT};dominant-baseline:auto}
    .status{font-size:12px;font-weight:600;letter-spacing:.3px;fill:${statusColor}}
    .title{font-size:${titleSize}px;font-weight:700;fill:${t.title}}
    .artist{font-size:${artistSize}px;font-weight:400;fill:${t.subtitle}}
    .time{font-size:10px;font-weight:500;fill:${t.muted}}
    ${eqAnim}
    ${spinAnim}
    ${progressAnim}
    ${tickerAnim}
    /* The page's own reduced-motion rule cannot reach an SVG embedded as an
       image, so the card carries its own. Each element degrades by itself: the
       strip shows its first line, the bar keeps its inline scaleX. */
    @media (prefers-reduced-motion:reduce){.tick,.art,.eq,.fill{animation:none}}
  </style>

  <rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="12" fill="${t.bg}" stroke="${t.border}"/>
  ${coverMarkup(coverDataUri, t, o)}

  <g transform="translate(${TEXT_X} ${20 + dy}) scale(0.6667)" fill="${statusColor}">
    <path d="${SPOTIFY_PATH}"/>
  </g>
  <text x="${TEXT_X + 22}" y="${30 + dy}" class="status">${escapeXml(status)}</text>
  ${o.equalizer ? equalizer(W - PAD - 21, 30 + dy, o.accent) : ''}

  <text x="${TEXT_X}" y="${58 + dy}" class="title">${escapeXml(
    truncate(title, TEXT_W, titleSize),
  )}</text>
  <text x="${TEXT_X}" y="${78 + dy}" class="artist">${escapeXml(
    truncate(artist, TEXT_W, artistSize),
  )}</text>

  ${
    showBar
      ? `<rect x="${TEXT_X}" y="${BAR_Y}" width="${TEXT_W}" height="4" rx="2" fill="${t.track}"/>
  <rect class="fill" x="${TEXT_X}" y="${BAR_Y}" width="${playing ? TEXT_W : fillW}" height="4" rx="2" fill="#${
    o.accent
  }"${playing ? ` style="transform:scaleX(${ratio.toFixed(4)})"` : ''}/>`
      : ''
  }
  ${timesRow}
</svg>`;
}

/** Fallback card shown instead of a broken image when something goes wrong. */
export function renderErrorCard(headline, detail, options) {
  const o = normalise(options);
  const t = THEMES[o.theme];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${escapeXml(
    headline,
  )}">
  <style>
    text{font-family:${FONT}}
    .h{font-size:15px;font-weight:700;fill:${t.title}}
    .d{font-size:12px;fill:${t.subtitle}}
  </style>
  <rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="12" fill="${t.bg}" stroke="${t.border}"/>
  ${coverMarkup(null, t, o, false)}
  <text x="${TEXT_X}" y="58" class="h">${escapeXml(truncate(headline, TEXT_W, 15))}</text>
  <text x="${TEXT_X}" y="78" class="d">${escapeXml(truncate(detail, TEXT_W, 12))}</text>
</svg>`;
}

export const CARD_SIZE = { width: W, height: H };
