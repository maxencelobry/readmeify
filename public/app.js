// Readmeify frontend. No framework, no build step: one module, one render pass.

const $ = (id) => document.getElementById(id);

// Redirect error codes from the HTTP contract, in human words.
const ERRORS = {
  oauth_state: 'That sign-in link expired or did not come from here. Please start again.',
  github_denied: 'GitHub authorisation was cancelled.',
  github_failed: 'GitHub sign-in failed. Please try again.',
  spotify_denied: 'Spotify authorisation was cancelled.',
  spotify_failed: 'Spotify connection failed. Please try again.',
  no_app: 'No Spotify application is available. Register your own app in step 2.',
  session_expired: 'Session expired — sign in again.',
  rate_limited: 'Too many attempts. Wait a minute and try again.',
};

// Mirrors the server-side validation so the round trip is skipped on obvious
// typos. Must stay character-for-character identical to CLIENT_SECRET_RE /
// CLIENT_ID_RE in src/server.js, or the field accepts what the server rejects.
const CLIENT_ID_RE = /^[0-9a-fA-F]{32}$/;
const SECRET_RE = /^[A-Za-z0-9_-]{20,128}$/;

let me = null; // last /api/me payload

function banner(message, kind = 'error') {
  const el = $('banner');
  el.textContent = message;
  el.dataset.kind = kind;
  el.hidden = false;
}

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: {
      'X-Requested-With': 'XMLHttpRequest',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    load(); // the UI is showing a session that no longer exists
    throw new Error(ERRORS.session_expired);
  }
  if (!res.ok) {
    const json = await res.json().catch(() => null);
    throw new Error(json?.error?.message || `Request failed (${res.status}).`);
  }
  return res.status === 204 ? null : res.json();
}

/** Wires a click handler that disables its button for the duration of the request. */
function onClick(id, fn) {
  const btn = $(id);
  btn.addEventListener('click', async (event) => {
    event.preventDefault();
    btn.disabled = true;
    try {
      await fn();
    } catch (err) {
      banner(err.message || 'Request failed.');
    } finally {
      btn.disabled = false;
    }
  });
}

async function copyTo(btn, text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Clipboard API needs a secure context; textarea + execCommand covers the rest.
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.readOnly = true;
    ta.className = 'copy-fallback';
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  const label = (btn.dataset.label ??= btn.textContent);
  btn.textContent = 'Copied';
  setTimeout(() => { btn.textContent = label; }, 1500);
}

const bust = (url) => url + (url.includes('?') ? '&' : '?') + 't=' + Date.now();

// --------------------------------------------------------------- appearance

// Mirrors the card query contract. Only non-default values reach the URL, so a
// default card keeps the bare URL the server hands out.
const CARD_DEFAULTS = { theme: 'dark', spin: '0', accent: '1ed760', progress: '1', equalizer: '1', ticker: '1' };
const ACCENT_RE = /^[0-9a-fA-F]{6}$/; // <input type="color"> always yields 6 digits
const OPTS_KEY = 'rmf.card-options'; // UI state only — never credentials
const SWITCHES = ['spin', 'progress', 'equalizer', 'ticker'];

const opts = { ...CARD_DEFAULTS };
let optsTimer;

const validOpt = (key, value) =>
  key === 'accent' ? ACCENT_RE.test(value)
    : key === 'theme' ? value === 'dark' || value === 'light'
      : value === '0' || value === '1';

function cardUrl(base) {
  const query = new URLSearchParams(
    Object.entries(opts).filter(([key, value]) => value !== CARD_DEFAULTS[key]),
  ).toString();
  return query ? `${base}?${query}` : base;
}

// The server already built the snippets around the plain URL; swapping it in
// place keeps the link target and the dimensions defined in exactly one spot.
// HTML attributes need the query separators as entities; Markdown wants them raw.
function snippet(kind) {
  const url = cardUrl(me.card.url);
  return me.card[kind].replaceAll(me.card.url, kind === 'html' ? url.replaceAll('&', '&amp;') : url);
}

let previewRun = 0;

/** Re-points every preview at the endpoint with the current options. */
function applyOptions(refresh) {
  const status = $('preview-status');
  status.textContent = 'Loading preview…';
  status.classList.remove('warn');
  status.hidden = false;

  // One status line for both previews: report once both have settled, so a
  // broken card is not hidden by the sample loading after it. Stale handlers
  // from a superseded call are ignored.
  const run = ++previewRun;
  const targets = [[$('demo-img'), 'api/demo.svg'], [$('card-img'), me?.card?.url]].filter(
    ([, base]) => base,
  );
  let pending = targets.length;
  let failed = false;
  const settle = (ok) => {
    if (run !== previewRun) return;
    failed ||= !ok;
    if (--pending) return;
    if (failed) status.textContent = 'The preview could not be loaded. Change an option to try again.';
    status.classList.toggle('warn', failed);
    status.hidden = !failed;
  };

  for (const [img, base] of targets) {
    img.onload = () => settle(true);
    img.onerror = () => settle(false);
    // Only the refresh button needs a cache-buster; an option change already
    // changes the URL, and an unchanged one must not cost a second render.
    img.src = refresh ? bust(cardUrl(base)) : cardUrl(base);
    if (img.complete) settle(img.naturalWidth > 0); // same src: no event coming
  }
  if (me?.card) $('card-md-code').textContent = snippet('markdown');
}

/** Controls follow `opts`, never the other way round. */
function syncOptions() {
  $(`opt-theme-${opts.theme}`).checked = true;
  for (const key of SWITCHES) $(`opt-${key}`).checked = opts[key] === '1';
  $('opt-accent').value = '#' + opts.accent;
  for (const el of document.querySelectorAll('.swatch')) {
    el.setAttribute('aria-pressed', String(el.dataset.accent === opts.accent));
  }
}

function commit(delay = 0) {
  try {
    localStorage.setItem(OPTS_KEY, JSON.stringify(opts));
  } catch { /* private mode or full quota: the options just do not persist */ }
  syncOptions();
  clearTimeout(optsTimer);
  optsTimer = setTimeout(applyOptions, delay);
}

function setOpt(key, value, delay) {
  if (!validOpt(key, value)) return;
  opts[key] = value;
  commit(delay);
}

// ---------------------------------------------------------------- rendering

function render(data) {
  me = data;
  const { github, spotify, card, config } = data;
  const connectable = data.authenticated && (config.sharedAppAvailable || spotify.mode === 'own');

  // Step 1 — GitHub
  $('gh-disconnected').hidden = data.authenticated;
  $('gh-connected').hidden = !data.authenticated;
  if (github) {
    // src="" resolves to the current document: the page would fetch its own
    // HTML as an image and show the broken-image glyph.
    if (github.avatarUrl) $('gh-avatar').src = github.avatarUrl;
    else $('gh-avatar').removeAttribute('src');
    $('gh-avatar').alt = `Avatar of ${github.login}`;
    $('gh-login').textContent = '@' + github.login;
  }

  // Step 2 — Spotify
  $('sp-disconnected').hidden = spotify.connected;
  $('sp-connected').hidden = !spotify.connected;
  $('sp-name').textContent = spotify.displayName || 'Spotify account connected';
  $('sp-need-github').hidden = data.authenticated;
  $('sp-no-app').hidden = !data.authenticated || connectable;
  // Only point at the BYO panel when the BYO panel is actually rendered.
  $('sp-no-app').textContent = config.allowByoApp
    ? 'This server has no shared Spotify app configured. Register your own below.'
    : 'This deployment is not accepting new Spotify connections — contact the operator.';

  const link = $('link-spotify');
  if (connectable) {
    link.href = 'auth/spotify';
    link.removeAttribute('aria-disabled');
  } else {
    link.removeAttribute('href');
    link.setAttribute('aria-disabled', 'true');
  }

  $('byo').hidden = !(config.allowByoApp && data.authenticated);
  $('byo-redirect').value = config.redirectUri;
  fitRedirect();
  $('byo-mode').textContent =
    spotify.mode === 'own'
      ? 'Currently using your own Spotify app.'
      : 'Currently using the shared Spotify app.';
  $('btn-byo-shared').hidden = spotify.mode !== 'own';

  // Step 3 — result
  const ready = Boolean(card);
  $('card-img').hidden = !ready;
  $('card-md').hidden = !ready;
  $('readme-hint').hidden = !ready;
  $('star-cta').hidden = !ready;
  $('result-hint').hidden = ready;
  $('result-hint').textContent = data.authenticated
    ? 'Connect Spotify in step 2 — your card and its snippet appear here.'
    : 'Finish steps 1 and 2 — your card and its snippet appear here.';
  for (const id of ['btn-copy-md', 'btn-copy-html', 'btn-refresh']) $(id).disabled = !ready;
  if (ready) $('repo-name').textContent = `${github.login}/${github.login}`;
  // Both previews are driven from the same options; `me` decides whether the
  // real card is one of them or only the sample at the top of the page.
  applyOptions();

  // Progress indicator — first unfinished step is the active one.
  const done = [data.authenticated, spotify.connected, ready];
  const active = done.indexOf(false);
  document.querySelectorAll('#steps .step').forEach((li, i) => {
    const state = done[i] ? 'done' : i === active ? 'active' : 'pending';
    li.dataset.state = state;
    li.querySelector('.step-state').textContent =
      state === 'done' ? 'Done' : state === 'active' ? 'In progress' : 'Pending';
    if (state === 'active') li.setAttribute('aria-current', 'step');
    else li.removeAttribute('aria-current');
  });

  document.body.dataset.state = 'ready';
}

async function load() {
  document.body.dataset.state = 'loading';
  try {
    render(await api('GET', 'api/me'));
  } catch {
    document.body.dataset.state = 'error';
  }
}

// ------------------------------------------------------------------- events

onClick('btn-retry', load);

onClick('btn-logout', async () => {
  await api('POST', 'auth/logout');
  location.replace(location.pathname);
});

onClick('btn-delete', async () => {
  if (!confirm('Delete your account and every stored token? Your card URL stops working immediately.')) return;
  await api('DELETE', 'api/account');
  location.replace(location.pathname);
});

onClick('btn-sp-disconnect', async () => {
  await api('DELETE', 'api/spotify');
  banner('Spotify disconnected.', 'success');
  await load();
});

onClick('btn-byo-shared', async () => {
  await api('DELETE', 'api/spotify/app');
  banner('Back on the shared app. Connect Spotify again to finish.', 'success');
  await load();
});

// A long BASE_URL wraps to more lines than the textarea's `rows`, which would
// clip the end of the URI on narrow screens. Grow it to fit whatever it holds.
function fitRedirect() {
  const el = $('byo-redirect');
  if (el.offsetParent === null) return; // collapsed: scrollHeight would be 0
  el.style.height = 'auto';
  // scrollHeight is the content box; the element is border-box, so add the borders.
  el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`;
}
window.addEventListener('resize', fitRedirect);
$('byo').addEventListener('toggle', fitRedirect);

onClick('btn-copy-redirect', () => copyTo($('btn-copy-redirect'), $('byo-redirect').value));
onClick('btn-copy-md', () => copyTo($('btn-copy-md'), snippet('markdown')));
onClick('btn-copy-html', () => copyTo($('btn-copy-html'), snippet('html')));
onClick('btn-refresh', () => applyOptions(true));

for (const theme of ['dark', 'light']) {
  $(`opt-theme-${theme}`).addEventListener('change', () => setOpt('theme', theme));
}
for (const key of SWITCHES) {
  $(`opt-${key}`).addEventListener('change', (event) => setOpt(key, event.target.checked ? '1' : '0'));
}
// Dragging the picker fires per pixel; the delay turns that into one request.
$('opt-accent').addEventListener('input', (event) =>
  setOpt('accent', event.target.value.slice(1).toLowerCase(), 200),
);
for (const el of document.querySelectorAll('.swatch')) {
  el.addEventListener('click', () => setOpt('accent', el.dataset.accent));
}
$('opt-reset').addEventListener('click', () => {
  Object.assign(opts, CARD_DEFAULTS);
  commit();
});

$('byo-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const idInput = $('byo-id');
  const secretInput = $('byo-secret');
  const clientId = idInput.value.trim();
  const clientSecret = secretInput.value.trim();
  const err = $('byo-error');

  const badId = !CLIENT_ID_RE.test(clientId);
  const badSecret = !SECRET_RE.test(clientSecret);
  idInput.setAttribute('aria-invalid', String(badId));
  secretInput.setAttribute('aria-invalid', String(badSecret));
  if (badId || badSecret) {
    err.textContent = badId
      ? 'The Client ID must be exactly 32 characters, digits and a–f only.'
      : 'That does not look like a Spotify client secret. Copy it again from the dashboard.';
    err.hidden = false;
    (badId ? idInput : secretInput).focus();
    return;
  }
  err.hidden = true;

  const btn = $('btn-byo-save');
  btn.disabled = true;
  try {
    await api('POST', 'api/spotify/app', { clientId, clientSecret });
    secretInput.value = '';
    banner('Your Spotify app is saved. Connect Spotify above to finish.', 'success');
    await load();
  } catch (e) {
    err.textContent = e.message;
    err.hidden = false;
  } finally {
    btn.disabled = false;
  }
});

// -------------------------------------------------------------------- boot

const params = new URLSearchParams(location.search);
if (params.has('error')) {
  banner(ERRORS[params.get('error')] || 'Something went wrong. Please try again.');
} else if (params.get('connected') === '1') {
  banner('Spotify connected. Your card is ready in step 3.', 'success');
} else if (params.get('step') === 'spotify') {
  banner('Signed in with GitHub. Next: connect Spotify.', 'success');
}
if (location.search) history.replaceState(null, '', location.pathname);

try {
  const saved = JSON.parse(localStorage.getItem(OPTS_KEY) ?? '{}');
  for (const key of Object.keys(CARD_DEFAULTS)) if (validOpt(key, saved?.[key])) opts[key] = saved[key];
} catch { /* missing, unreadable or corrupt: defaults */ }
syncOptions(); // controls must show the saved options before /api/me answers
// No applyOptions() here: index.html gives the sample its default src, and
// render() re-points both previews once /api/me lands.

load();
