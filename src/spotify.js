import { decrypt } from './crypto.js';
import { clearSpotifyToken } from './db.js';

const ACCOUNTS = 'https://accounts.spotify.com';
const API = 'https://api.spotify.com/v1';

// Minimum needed to read what is playing. Nothing is ever written to the account.
export const SCOPES = 'user-read-currently-playing user-read-recently-played';

/** Error carrying a stable machine code; messages stay free of secrets. */
export class SpotifyError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// Short-lived in-memory caches. Losing them on restart only costs one extra
// round trip, so no persistence needed.
const tokenCache = new Map(); // userId -> { accessToken, expiresAt }
const playbackCache = new Map(); // userId -> { data, expiresAt }
const coverCache = new Map(); // imageUrl -> { uri, until }

const PLAYBACK_TTL_MS = 10_000;
const COVER_CACHE_MAX = 300;
const COVER_MAX_BYTES = 1_500_000;
const COVER_TTL_MS = 6 * 60 * 60 * 1000;
const COVER_FAIL_TTL_MS = 60_000;
// Spotify serves all album art from scdn.co. Anything else is not album art,
// and fetching it would turn this into a server-side request forgery gadget.
const COVER_HOST = /(^|\.)scdn\.co$/;
const COVER_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

/** Resolves which Spotify app a user connects through: their own, or the shared one. */
export function appCredentialsFor(user, env) {
  if (user?.spotify_client_id && user?.spotify_client_secret_enc) {
    return {
      clientId: user.spotify_client_id,
      clientSecret: decrypt(user.spotify_client_secret_enc),
      own: true,
    };
  }
  if (!env.SPOTIFY_CLIENT_ID || !env.SPOTIFY_CLIENT_SECRET) {
    throw new SpotifyError('no_app', 'No Spotify application is configured on this server.');
  }
  return {
    clientId: env.SPOTIFY_CLIENT_ID,
    clientSecret: env.SPOTIFY_CLIENT_SECRET,
    own: false,
  };
}

export function authorizeUrl({ clientId, redirectUri, state }) {
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: SCOPES,
    state,
    show_dialog: 'true',
  });
  return `${ACCOUNTS}/authorize?${params}`;
}

function basicAuth(clientId, clientSecret) {
  return 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
}

async function tokenRequest(body, clientId, clientSecret) {
  const res = await fetch(`${ACCOUNTS}/api/token`, {
    method: 'POST',
    headers: {
      Authorization: basicAuth(clientId, clientSecret),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(body),
    signal: AbortSignal.timeout(10_000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const code = json.error === 'invalid_grant' ? 'invalid_grant' : 'token_error';
    throw new SpotifyError(code, `Spotify token request failed (${res.status}).`);
  }
  return json;
}

/** Swaps an authorization code for tokens. Returns the refresh token to store. */
export async function exchangeCode({ code, redirectUri, clientId, clientSecret }) {
  const json = await tokenRequest(
    { grant_type: 'authorization_code', code, redirect_uri: redirectUri },
    clientId,
    clientSecret,
  );
  if (!json.refresh_token) {
    throw new SpotifyError('no_refresh_token', 'Spotify did not return a refresh token.');
  }
  return { refreshToken: json.refresh_token, accessToken: json.access_token };
}

async function accessTokenFor(user, env) {
  const cached = tokenCache.get(user.id);
  if (cached && cached.expiresAt > Date.now() + 30_000) return cached.accessToken;

  if (!user.spotify_refresh_token_enc) {
    throw new SpotifyError('not_connected', 'This user has not connected Spotify.');
  }
  const { clientId, clientSecret } = appCredentialsFor(user, env);
  let refreshToken;
  try {
    refreshToken = decrypt(user.spotify_refresh_token_enc);
  } catch {
    // Almost always a rotated ENCRYPTION_KEY. The stored token is unusable for
    // good, so treat it exactly like a revoked one: drop it and ask to reconnect.
    throw new SpotifyError('invalid_grant', 'Stored refresh token could not be decrypted.');
  }
  const json = await tokenRequest(
    { grant_type: 'refresh_token', refresh_token: refreshToken },
    clientId,
    clientSecret,
  );
  const accessToken = json.access_token;
  const expiresAt = Date.now() + (Number(json.expires_in) || 3600) * 1000;
  tokenCache.set(user.id, { accessToken, expiresAt });
  return accessToken;
}

export function forgetTokens(userId) {
  tokenCache.delete(userId);
  playbackCache.delete(userId);
}

async function apiGet(path, accessToken) {
  const res = await fetch(`${API}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (res.status === 204 || res.status === 202) return null;
  if (res.status === 401) throw new SpotifyError('unauthorized', 'Spotify access token rejected.');
  if (res.status === 429) throw new SpotifyError('rate_limited', 'Spotify rate limit reached.');
  if (!res.ok) throw new SpotifyError('api_error', `Spotify API error (${res.status}).`);
  return res.json().catch(() => null);
}

function normalise(item, { playing, progressMs }) {
  if (!item) return null;
  const images = item.album?.images ?? [];
  // images[1] is the ~300px variant; fall back to whatever exists.
  const cover = images[1]?.url || images[0]?.url || null;
  return {
    playing,
    title: item.name || 'Unknown track',
    artist: (item.artists ?? []).map((a) => a.name).filter(Boolean).join(', ') || 'Unknown artist',
    album: item.album?.name || '',
    coverUrl: cover,
    progressMs: playing ? Math.max(0, Number(progressMs) || 0) : 0,
    durationMs: Math.max(0, Number(item.duration_ms) || 0),
    url: item.external_urls?.spotify || 'https://open.spotify.com/',
  };
}

/**
 * Current track, or the last one played when nothing is live.
 * Returns null when Spotify knows of no track at all.
 */
export async function getPlayback(user, env) {
  const cached = playbackCache.get(user.id);
  if (cached && cached.expiresAt > Date.now()) {
    // Advance the cached position so the progress bar stays honest between calls.
    if (cached.data?.playing) {
      const drift = PLAYBACK_TTL_MS - (cached.expiresAt - Date.now());
      return { ...cached.data, progressMs: Math.min(cached.data.progressMs + drift, cached.data.durationMs) };
    }
    return cached.data;
  }

  let accessToken = await accessTokenFor(user, env);
  let now;
  try {
    now = await apiGet('/me/player/currently-playing?additional_types=track', accessToken);
  } catch (err) {
    if (err.code !== 'unauthorized') throw err;
    tokenCache.delete(user.id);
    accessToken = await accessTokenFor(user, env);
    now = await apiGet('/me/player/currently-playing?additional_types=track', accessToken);
  }

  let data = null;
  if (now?.item) {
    data = normalise(now.item, { playing: Boolean(now.is_playing), progressMs: now.progress_ms });
  } else {
    const recent = await apiGet('/me/player/recently-played?limit=1', accessToken);
    const track = recent?.items?.[0]?.track;
    if (track) data = normalise(track, { playing: false, progressMs: 0 });
  }

  playbackCache.set(user.id, { data, expiresAt: Date.now() + PLAYBACK_TTL_MS });
  return data;
}

/**
 * Album art has to be inlined: a GitHub README renders the card through an
 * <img> tag, and SVGs loaded that way cannot fetch external resources.
 */
export async function coverDataUri(imageUrl) {
  if (!imageUrl) return null;
  try {
    const url = new URL(imageUrl);
    if (url.protocol !== 'https:' || !COVER_HOST.test(url.hostname)) return null;
  } catch {
    return null;
  }

  const hit = coverCache.get(imageUrl);
  if (hit && hit.until > Date.now()) return hit.uri;

  // Failures are cached too, briefly: without that, one unreachable cover costs
  // an 8s stall on every single card request for that track.
  const remember = (uri) => {
    if (coverCache.size >= COVER_CACHE_MAX) coverCache.delete(coverCache.keys().next().value);
    coverCache.set(imageUrl, { uri, until: Date.now() + (uri ? COVER_TTL_MS : COVER_FAIL_TTL_MS) });
    return uri;
  };

  try {
    // manual: a redirect off scdn.co would escape the host check above.
    const res = await fetch(imageUrl, { redirect: 'manual', signal: AbortSignal.timeout(8000) });
    if (!res.ok) return remember(null);
    const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!COVER_TYPES.has(type)) return remember(null);
    if (Number(res.headers.get('content-length')) > COVER_MAX_BYTES) return remember(null);

    // Counted while streaming: arrayBuffer() would buffer the whole body first,
    // so the cap could only ever fire after the memory was already spent.
    const chunks = [];
    let size = 0;
    for await (const chunk of res.body) {
      size += chunk.length;
      if (size > COVER_MAX_BYTES) return remember(null); // cancels the stream
      chunks.push(chunk);
    }
    return remember(`data:${type};base64,${Buffer.concat(chunks).toString('base64')}`);
  } catch {
    return remember(null);
  }
}

/** Drops a stored connection whose refresh token Spotify no longer accepts. */
export function invalidateConnection(userId) {
  forgetTokens(userId);
  clearSpotifyToken(userId);
}

export async function currentUserProfile(accessToken) {
  const res = await fetch(`${API}/me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) return null;
  const json = await res.json().catch(() => null);
  return json?.display_name || json?.id || null;
}
