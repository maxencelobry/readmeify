// Readmeify backend. One file on purpose: a dozen routes, no layers.
import 'dotenv/config'; // must be the first import so ./db.js sees DB_PATH
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import express from 'express';
import cookieParser from 'cookie-parser';

import { initCrypto, encrypt, safeEqual, randomToken } from './crypto.js';
import {
  getUserById,
  getUserByLogin,
  upsertGithubUser,
  setSpotifyApp,
  setSpotifyToken,
  bumpSessionVersion,
  deleteUser,
} from './db.js';
import {
  appCredentialsFor,
  authorizeUrl,
  exchangeCode,
  getPlayback,
  coverDataUri,
  forgetTokens,
  invalidateConnection,
  currentUserProfile,
} from './spotify.js';
import { renderCard, renderErrorCard, CARD_SIZE } from './card.js';
import { parseCardOptions } from './card-options.js';
import { basePath } from './base-path.js';

// ---------------------------------------------------------------------------
// Boot-time configuration
// ---------------------------------------------------------------------------

const REQUIRED = [
  'BASE_URL',
  'SESSION_SECRET',
  'ENCRYPTION_KEY',
  'GITHUB_CLIENT_ID',
  'GITHUB_CLIENT_SECRET',
];
const missing = REQUIRED.filter((k) => !String(process.env[k] ?? '').trim());
if (missing.length) {
  console.error(
    `Missing required environment variable(s): ${missing.join(', ')}\n` +
      'Copy .env.example to .env and fill them in.',
  );
  process.exit(1);
}

try {
  initCrypto(process.env.ENCRYPTION_KEY);
} catch (err) {
  console.error(`ENCRYPTION_KEY is invalid: ${err.message}`);
  process.exit(1);
}

const BASE_URL = process.env.BASE_URL.trim().replace(/\/+$/, '');
// BASE_PATH: '' when mounted at the origin root, '/readmeify' when BASE_URL
// carries a path. ORIGIN: the Origin header is scheme+host+port only — BASE_URL
// may carry a path too.
let BASE_PATH;
let ORIGIN;
try {
  BASE_PATH = basePath(BASE_URL);
  ORIGIN = new URL(BASE_URL).origin;
} catch (err) {
  console.error(`BASE_URL is invalid (${BASE_URL}): ${err.message}`);
  process.exit(1);
}
const PORT = Number(process.env.PORT) || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';
const ALLOW_BYO = /^(1|true|yes)$/i.test(process.env.ALLOW_BYO_SPOTIFY_APP ?? '');
const SHARED_APP = Boolean(process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET);
const GITHUB_REDIRECT = `${BASE_URL}/auth/github/callback`;
const SPOTIFY_REDIRECT = `${BASE_URL}/auth/spotify/callback`;
const ROOT = resolve(import.meta.dirname, '..');

const SESSION_COOKIE = 'rmf_session';
const GH_STATE = 'rmf_gh_state';
const SP_STATE = 'rmf_sp_state';
const STATE_TTL = 10 * 60 * 1000;
const SESSION_TTL = 30 * 24 * 60 * 60 * 1000;

const LOGIN_RE = /^[A-Za-z0-9-]{1,39}$/;
const CLIENT_ID_RE = /^[0-9a-f]{32}$/i;
const CLIENT_SECRET_RE = /^[A-Za-z0-9_-]{20,128}$/;
const UA = 'readmeify';

// ---------------------------------------------------------------------------
// App + middleware
// ---------------------------------------------------------------------------

const app = express();
app.disable('x-powered-by');
// Cookie paths are matched byte-exactly (RFC 6265), so the router must be too:
// by default Express would serve /READMEIFY/… while the browser withholds the
// session cookie issued for Path=/readmeify.
app.set('case sensitive routing', true);

// Everything below hangs off this router, which is mounted at BASE_PATH at the
// bottom of the file. Inside it every path — and req.path, which the CSP
// middleware reads — is relative to the mount point, so the routes are written
// once and work at the root and under a prefix alike.
// A Router does not inherit `case sensitive routing` from the app, so it has to
// be asked for again — otherwise /readmeify/API/me would serve a page the
// session cookie's byte-exact Path never reaches.
const router = express.Router({ caseSensitive: true });

const trustProxy = process.env.TRUST_PROXY;
if (trustProxy && !/^(0|false|no)$/i.test(trustProxy)) {
  // A hop count trusts whoever sends X-Forwarded-For if the request reaches the
  // origin directly. Anything non-numeric is handed to Express verbatim, so a
  // proxy CIDR ("10.0.0.0/8") or "loopback" can be pinned instead.
  app.set('trust proxy', /^\d+$/.test(trustProxy) ? Number(trustProxy) : trustProxy);
}

router.use(cookieParser(process.env.SESSION_SECRET));

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: https://avatars.githubusercontent.com",
  "connect-src 'self'",
  "form-action 'self'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');

// A card opened directly in a browser is an SVG *document*: style-src 'self'
// would kill the inline <style> that animates it. So /api gets its own policy —
// inline CSS only, no script, no network, sandboxed into a unique origin.
const API_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox";

router.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (IS_PROD) res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  res.setHeader('Content-Security-Policy', req.path.startsWith('/api/') ? API_CSP : CSP);
  next();
});

// Registered after the headers above so that body-parser's own 400 still
// carries them.
router.use(express.json({ limit: '8kb' }));

// State-changing routes must come from our own origin (CSRF defence in depth,
// on top of SameSite=Lax cookies). Allowlisted by method, so a PUT or PATCH
// added later is covered by default rather than silently exempt.
router.use((req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  if (req.get('origin') === ORIGIN) return next();
  res.status(403).json({ error: { code: 'bad_origin', message: 'Request origin not allowed.' } });
});

// The page is served from memory with a content hash stitched onto its two
// asset URLs. `Cache-Control: no-cache` alone is not enough in front of a CDN:
// Cloudflare rewrites it to its own Browser Cache TTL for .css and .js, so a
// visitor keeps yesterday's stylesheet against a fresh page and the UI silently
// falls back to unstyled controls. A changing URL cannot be stale.
const ASSET_VERSION = createHash('sha1')
  .update(readFileSync(resolve(ROOT, 'public/app.js')))
  .update(readFileSync(resolve(ROOT, 'public/style.css')))
  .digest('hex')
  .slice(0, 8);

const INDEX_HTML = readFileSync(resolve(ROOT, 'public/index.html'), 'utf8')
  .replace('href="style.css"', `href="style.css?v=${ASSET_VERSION}"`)
  .replace('src="app.js"', `src="app.js?v=${ASSET_VERSION}"`);

router.get(['/', '/index.html'], (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.type('html').send(INDEX_HTML);
});

router.use(
  express.static(resolve(ROOT, 'public'), {
    etag: true,
    // Fingerprinted requests may be cached hard; anything else must revalidate.
    setHeaders: (res) =>
      res.setHeader(
        'Cache-Control',
        res.req.url.includes(`v=${ASSET_VERSION}`)
          ? 'public, max-age=31536000, immutable'
          : 'no-cache',
      ),
  }),
);

// ---------------------------------------------------------------------------
// Rate limiting: fixed window per IP, in memory.
// ponytail: single-process only; move to Redis if this ever runs on >1 instance.
// ---------------------------------------------------------------------------

const buckets = new Map();
// Keyed by client IP, which a spoofable X-Forwarded-For can vary at will when
// `trust proxy` is set wider than the real hop count. Capped so that can cost
// memory no faster than it costs the oldest bucket.
const BUCKETS_MAX = 50_000;

function limit(name, max, windowMs, onLimit) {
  return (req, res, next) => {
    const key = `${name}:${req.ip}`;
    const now = Date.now();
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      if (buckets.size >= BUCKETS_MAX) buckets.delete(buckets.keys().next().value);
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }
    if (bucket.count >= max) return onLimit(req, res);
    bucket.count++;
    next();
  };
}

setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) if (bucket.resetAt <= now) buckets.delete(key);
}, 60_000).unref();

// GET /auth/* is a browser redirect flow; POST /auth/logout is called by the
// frontend's JSON helper, which cannot read a 302 to an HTML page.
const authLimit = limit('auth', 30, 60_000, (req, res) =>
  req.method === 'GET'
    ? redirectError(res, 'rate_limited')
    : jsonError(res, 429, 'rate_limited', 'Too many attempts. Wait a minute and try again.'),
);
// Generous: GitHub proxies every README image through camo, so many readers
// share a handful of source IPs.
const cardLimit = limit('card', 180, 60_000, (req, res) =>
  sendCard(
    res,
    renderErrorCard('Too many requests', 'Give it a minute and refresh.', parseCardOptions(req.query)),
  ),
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const cookieOpts = (maxAge) => ({
  httpOnly: true,
  sameSite: 'lax',
  secure: IS_PROD,
  signed: true,
  // Scoped to this app, so a second app on the same domain never sees them.
  // clearCookie must be given the same path or the cookie survives.
  path: BASE_PATH || '/',
  maxAge,
});
const clearOpts = { httpOnly: true, sameSite: 'lax', secure: IS_PROD, path: BASE_PATH || '/' };

const redirectError = (res, code) => res.redirect(`${BASE_URL}/?error=${code}`);

function currentUser(req) {
  // "<id>.<session_version>": logging out bumps the stored version, which
  // invalidates every cookie already issued — including copies we never see.
  const [rawId, rawVersion] = String(req.signedCookies?.[SESSION_COOKIE] ?? '').split('.');
  const user = Number(rawId) ? getUserById(Number(rawId)) : null;
  return user && Number(rawVersion) === user.session_version ? user : null;
}

const sessionValue = (user) => `${user.id}.${user.session_version}`;

/**
 * Issues a one-shot OAuth state cookie bound to the session that started the
 * flow, and to the moment it started.
 */
function issueState(res, cookieName, userId) {
  const state = `${userId}.${Date.now()}.${randomToken()}`;
  res.cookie(cookieName, state, cookieOpts(STATE_TTL));
  return state;
}

/** Reads, clears and verifies that cookie. */
function checkState(req, res, cookieName, userId) {
  const expected = req.signedCookies?.[cookieName];
  res.clearCookie(cookieName, clearOpts);
  if (!expected || !safeEqual(expected, String(req.query.state ?? ''))) return false;
  const [owner, issuedAt] = String(expected).split('.');
  // Binding to the user closes the shared-browser case: an authorization
  // started by one account must not complete into another's. Max-Age is only
  // browser-enforced, so freshness is re-checked here.
  return Number(owner) === userId && Date.now() - Number(issuedAt) < STATE_TTL;
}

function sendCard(res, svg, status = 200) {
  res
    .status(status)
    .type('image/svg+xml; charset=utf-8')
    // GitHub proxies README images through camo, which sits behind Fastly.
    // `no-store` reads to that CDN as "not cacheable", and it falls back to its
    // own default TTL — measured at 5+ minutes with no revalidation, which is
    // longer than most songs. An explicit zero max-age is a value it can honour
    // instead, and the changing ETag makes each revalidation return fresh bytes.
    // Surrogate-Control is the Fastly-specific form; harmless where it is dropped.
    .set('Cache-Control', 'max-age=0, s-maxage=0, must-revalidate')
    .set('Surrogate-Control', 'max-age=0')
    .send(svg);
}

const jsonError = (res, status, code, message) => res.status(status).json({ error: { code, message } });

function requireUser(req, res, next) {
  const user = currentUser(req);
  if (!user) return jsonError(res, 401, 'session_expired', 'Sign in with GitHub again.');
  req.user = user;
  next();
}

function cardFor(user) {
  if (!user.spotify_refresh_token_enc) return null;
  const url = `${BASE_URL}/api/spotify/${user.github_login}`;
  // The link target is the generic Spotify page: /api/me must not hit Spotify,
  // and a README link should stay stable anyway.
  const link = 'https://open.spotify.com/';
  return {
    url,
    markdown: `[![Spotify now playing](${url})](${link})`,
    html: `<a href="${link}"><img src="${url}" width="${CARD_SIZE.width}" height="${CARD_SIZE.height}" alt="Spotify now playing" /></a>`,
  };
}

// ---------------------------------------------------------------------------
// JSON API
// ---------------------------------------------------------------------------

router.get('/api/me', (req, res) => {
  const user = currentUser(req);
  const config = {
    allowByoApp: ALLOW_BYO,
    sharedAppAvailable: SHARED_APP,
    redirectUri: SPOTIFY_REDIRECT,
    baseUrl: BASE_URL,
  };
  // Session-dependent: a cached copy would show the wrong state on the way back
  // from an OAuth redirect.
  res.set('Cache-Control', 'no-store');
  res.json({
    authenticated: Boolean(user),
    github: user ? { login: user.github_login, avatarUrl: user.github_avatar_url } : null,
    // Always the full shape, only the values vary — the client never has to
    // branch on null before reading a field.
    spotify: {
      connected: Boolean(user?.spotify_refresh_token_enc),
      displayName: user?.spotify_display_name ?? null,
      mode: user?.spotify_client_id && user?.spotify_client_secret_enc ? 'own' : 'shared',
    },
    card: user ? cardFor(user) : null,
    config,
  });
});

router.post('/api/spotify/app', requireUser, (req, res) => {
  if (!ALLOW_BYO) {
    return jsonError(res, 403, 'byo_disabled', 'Custom Spotify apps are disabled on this server.');
  }
  // Typed before coercion: String({toString: 1}) throws, and an uncaught
  // TypeError here would be a 500 with a stack trace in the log.
  if (typeof req.body?.clientId !== 'string' || typeof req.body?.clientSecret !== 'string') {
    return jsonError(res, 400, 'bad_request', 'clientId and clientSecret must be strings.');
  }
  const clientId = req.body.clientId.trim();
  const clientSecret = req.body.clientSecret.trim();
  if (!CLIENT_ID_RE.test(clientId)) {
    return jsonError(res, 400, 'bad_client_id', 'Client ID must be 32 hexadecimal characters.');
  }
  if (!CLIENT_SECRET_RE.test(clientSecret)) {
    return jsonError(res, 400, 'bad_client_secret', 'That client secret does not look valid.');
  }
  // setSpotifyApp also drops any stored token: the old one belongs to the old app.
  setSpotifyApp(req.user.id, clientId, encrypt(clientSecret));
  forgetTokens(req.user.id);
  res.sendStatus(204);
});

router.delete('/api/spotify/app', requireUser, (req, res) => {
  setSpotifyApp(req.user.id, null, null);
  forgetTokens(req.user.id);
  res.sendStatus(204);
});

router.delete('/api/spotify', requireUser, (req, res) => {
  invalidateConnection(req.user.id);
  res.sendStatus(204);
});

router.delete('/api/account', requireUser, (req, res) => {
  forgetTokens(req.user.id);
  deleteUser(req.user.id);
  res.clearCookie(SESSION_COOKIE, clearOpts);
  res.sendStatus(204);
});

// ---------------------------------------------------------------------------
// GitHub OAuth
// ---------------------------------------------------------------------------

router.use('/auth', authLimit);

router.get('/auth/github', (req, res) => {
  const state = issueState(res, GH_STATE, currentUser(req)?.id ?? 0);
  const params = new URLSearchParams({
    client_id: process.env.GITHUB_CLIENT_ID,
    redirect_uri: GITHUB_REDIRECT,
    scope: 'read:user',
    state,
    allow_signup: 'true',
  });
  res.redirect(`https://github.com/login/oauth/authorize?${params}`);
});

router.get('/auth/github/callback', async (req, res) => {
  const stateOk = checkState(req, res, GH_STATE, currentUser(req)?.id ?? 0);
  if (req.query.error) {
    return redirectError(res, req.query.error === 'access_denied' ? 'github_denied' : 'github_failed');
  }
  if (!stateOk) return redirectError(res, 'oauth_state');

  const code = String(req.query.code ?? '');
  if (!code) return redirectError(res, 'github_failed');

  try {
    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': UA,
      },
      body: new URLSearchParams({
        client_id: process.env.GITHUB_CLIENT_ID,
        client_secret: process.env.GITHUB_CLIENT_SECRET,
        code,
        redirect_uri: GITHUB_REDIRECT,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const token = (await tokenRes.json().catch(() => ({})))?.access_token;
    if (!token) throw new Error(`token exchange failed (${tokenRes.status})`);

    const profileRes = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': UA,
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!profileRes.ok) throw new Error(`profile fetch failed (${profileRes.status})`);
    const profile = await profileRes.json();
    if (!profile?.id || !LOGIN_RE.test(String(profile.login ?? ''))) {
      throw new Error('unexpected profile payload');
    }

    const user = upsertGithubUser({
      githubId: profile.id,
      login: profile.login,
      avatarUrl: profile.avatar_url ?? null,
    });
    res.cookie(SESSION_COOKIE, sessionValue(user), cookieOpts(SESSION_TTL));
    res.redirect(`${BASE_URL}/?step=spotify`);
  } catch (err) {
    console.error('[github] callback:', err.message);
    redirectError(res, 'github_failed');
  }
});

router.post('/auth/logout', (req, res) => {
  const user = currentUser(req);
  // Clearing the browser's copy is not revocation: bump the version so any
  // other copy of this cookie stops working too.
  if (user) bumpSessionVersion(user.id);
  res.clearCookie(SESSION_COOKIE, clearOpts);
  // An in-flight authorization must not complete into the next session here.
  res.clearCookie(GH_STATE, clearOpts);
  res.clearCookie(SP_STATE, clearOpts);
  res.sendStatus(204);
});

// ---------------------------------------------------------------------------
// Spotify OAuth
// ---------------------------------------------------------------------------

router.get('/auth/spotify', (req, res) => {
  const user = currentUser(req);
  if (!user) return redirectError(res, 'session_expired');

  let creds;
  try {
    creds = appCredentialsFor(user, process.env);
  } catch (err) {
    console.error('[spotify] no usable app:', err.message);
    return redirectError(res, 'no_app');
  }
  const state = issueState(res, SP_STATE, user.id);
  res.redirect(authorizeUrl({ clientId: creds.clientId, redirectUri: SPOTIFY_REDIRECT, state }));
});

router.get('/auth/spotify/callback', async (req, res) => {
  const user = currentUser(req);
  const stateOk = checkState(req, res, SP_STATE, user?.id ?? 0);
  if (!user) return redirectError(res, 'session_expired');
  if (req.query.error) {
    return redirectError(res, req.query.error === 'access_denied' ? 'spotify_denied' : 'spotify_failed');
  }
  if (!stateOk) return redirectError(res, 'oauth_state');

  const code = String(req.query.code ?? '');
  if (!code) return redirectError(res, 'spotify_failed');

  try {
    const creds = appCredentialsFor(user, process.env);
    const { refreshToken, accessToken } = await exchangeCode({
      code,
      redirectUri: SPOTIFY_REDIRECT,
      clientId: creds.clientId,
      clientSecret: creds.clientSecret,
    });
    const displayName = await currentUserProfile(accessToken).catch(() => null);
    setSpotifyToken(user.id, encrypt(refreshToken), displayName);
    forgetTokens(user.id); // drop caches from any previous connection
    res.redirect(`${BASE_URL}/?connected=1`);
  } catch (err) {
    console.error('[spotify] callback:', err.message);
    redirectError(res, err.code === 'no_app' ? 'no_app' : 'spotify_failed');
  }
});

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

router.get('/api/spotify/:login', cardLimit, async (req, res) => {
  const { login } = req.params;
  // Error cards get the options too: a dark card would flash on a light README.
  const opts = parseCardOptions(req.query);
  // Every branch answers 200: camo (and any <img>) renders nothing but a 2xx,
  // so a 404 here would show the broken-image glyph instead of the card that
  // explains what went wrong.
  if (!LOGIN_RE.test(login)) {
    return sendCard(res, renderErrorCard('Invalid username', 'That is not a valid GitHub login.', opts));
  }
  const user = getUserByLogin(login);
  if (!user) {
    return sendCard(res, renderErrorCard('No card yet', `${login} has not signed up on Readmeify.`, opts));
  }
  if (!user.spotify_refresh_token_enc) {
    return sendCard(
      res,
      renderErrorCard('Spotify not connected', `${user.github_login} has not linked Spotify.`, opts),
    );
  }

  try {
    const track = await getPlayback(user, process.env);
    // track === null means Spotify has no history at all — renderCard shows the idle card.
    return sendCard(res, renderCard(track, track ? await coverDataUri(track.coverUrl) : null, opts));
  } catch (err) {
    if (err.code === 'invalid_grant') {
      invalidateConnection(user.id);
      return sendCard(res, renderErrorCard('Reconnect Spotify', 'Access was revoked — link Spotify again.', opts));
    }
    if (err.code === 'rate_limited') {
      return sendCard(res, renderErrorCard('Spotify is busy', 'Rate limited. Try again in a moment.', opts));
    }
    if (err.code === 'no_app') {
      return sendCard(res, renderErrorCard('Spotify app missing', 'This card needs a Spotify app configured.', opts));
    }
    console.error(`[card] ${user.github_login}:`, err.message);
    return sendCard(res, renderErrorCard('Card unavailable', 'Could not reach Spotify right now.', opts));
  }
});

const SAMPLE_PATH = resolve(ROOT, 'sample-data.json');
const FALLBACK_SAMPLE = {
  playing: true,
  title: 'Midnight City',
  artist: 'M83',
  album: 'Hurry Up, We’re Dreaming',
  coverUrl: null,
  progressMs: 74_000,
  durationMs: 243_000,
  url: 'https://open.spotify.com/',
};

// Read once at boot: the sample never changes while the process runs.
let SAMPLE = FALLBACK_SAMPLE;
try {
  const json = JSON.parse(readFileSync(SAMPLE_PATH, 'utf8'));
  // Merged over the fallback so a partial or reshaped file still renders.
  SAMPLE = { ...FALLBACK_SAMPLE, ...(json.track ?? json) };
} catch {
  /* no sample file: use the built-in one */
}

let demoCover = null;

router.get('/api/demo.svg', cardLimit, async (req, res) => {
  // The SVG is per-option, so it is rendered per request; the cover fetch is
  // the expensive part and is the same for every visitor, so concurrent requests
  // share one promise. A failure is dropped, or one bad fetch would leave the
  // card everyone sees first without art until the process restarts.
  demoCover ??= coverDataUri(SAMPLE.coverUrl);
  const cover = await demoCover;
  if (!cover) demoCover = null;
  sendCard(res, renderCard(SAMPLE, cover, parseCardOptions(req.query)));
});

// ---------------------------------------------------------------------------
// Fallbacks
// ---------------------------------------------------------------------------

router.use('/api', (req, res) => jsonError(res, 404, 'not_found', 'Unknown endpoint.'));

// ---------------------------------------------------------------------------
// Mount
// ---------------------------------------------------------------------------

// Without the trailing slash the browser resolves the page's relative URLs
// against "/" instead of "/readmeify/", so every asset and every fetch misses.
// The req.path guard is load-bearing: Express is not in strict-routing mode, so
// this route also matches "/readmeify/" — redirecting that would be a loop.
if (BASE_PATH) {
  // req.url still carries the query here (this route is on `app`, not inside the
  // mounted router), and the query is how the page reports OAuth errors.
  app.get(BASE_PATH, (req, res, next) =>
    req.path === BASE_PATH ? res.redirect(301, `${BASE_PATH}/${req.url.slice(BASE_PATH.length)}`) : next(),
  );
}
app.use(BASE_PATH || '/', router);

app.use((err, req, res, _next) => {
  // Body-parser rejections are caller error, not server error: answer them
  // without logging, otherwise anyone can flood the log with stack traces.
  if (err.type === 'entity.too.large' || err.status === 413) {
    return jsonError(res, 413, 'payload_too_large', 'Request body is too large.');
  }
  if (err.type === 'entity.parse.failed' || err.status === 400) {
    return jsonError(res, 400, 'bad_request', 'Malformed request body.');
  }
  console.error('[error]', err);
  jsonError(res, 500, 'server_error', 'Something went wrong.');
});

app.listen(PORT, () => {
  console.log(
    `Readmeify listening on ${BASE_URL} (port ${PORT}, mounted at ${BASE_PATH || '/'}) — shared Spotify app: ${
      SHARED_APP ? 'configured' : 'MISSING (BYO only)'
    }`,
  );
});
