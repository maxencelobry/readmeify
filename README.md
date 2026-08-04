<div align="center">

<img src="https://maxencelobry.tech/readmeify/api/demo.svg" alt="A Readmeify card showing the currently playing track" width="480">

<h1>Readmeify</h1>

<p><b>Put the song you are listening to right now on your GitHub profile.</b></p>

<p>
  <a href="https://maxencelobry.tech/readmeify"><img src="https://img.shields.io/badge/try_it-live-1ed760?style=flat-square&labelColor=161616" alt="Try it live"></a>
  <a href="https://github.com/maxencelobry/readmeify/stargazers"><img src="https://img.shields.io/github/stars/maxencelobry/readmeify?style=flat-square&labelColor=161616&color=1ed760" alt="Stars"></a>
  <img src="https://img.shields.io/badge/dependencies-3-a1a1aa?style=flat-square&labelColor=161616" alt="Three dependencies">
</p>

<p><b><a href="https://maxencelobry.tech/readmeify">maxencelobry.tech/readmeify</a></b></p>

</div>

That card is not a screenshot. It is generated on every page load, and the clock on it
counts up second by second while you read this.

---

## Get your card

You do not need to install anything, and you never have to hand over a Spotify secret.

**1. Open [maxencelobry.tech/readmeify](https://maxencelobry.tech/readmeify) and sign in with GitHub.**
This is only so the site knows which username your card belongs to. It asks for read
access to your public profile, nothing else.

**2. Click "Connect Spotify" and approve.**
Spotify asks whether this app may see what you are currently playing. That is the only
permission requested — it cannot play, pause, or change anything on your account.

**3. Copy the Markdown snippet and paste it into your profile README.**

```markdown
[![Spotify now playing](https://maxencelobry.tech/readmeify/api/spotify/YOUR-USERNAME)](https://open.spotify.com/)
```

Your profile README lives in a repository named exactly like your GitHub username. If you
do not have one yet: [create a new repository](https://github.com/new) called
`your-username`, tick "Add a README file", and paste the snippet in there. GitHub shows
that file at the top of your profile.

That is it. The card updates itself every time someone loads your profile.

> **Worked?** [Leave a star ⭐](https://github.com/maxencelobry/readmeify) — one click, and it is
> genuinely how the next person finds this. The project is free, has no ads and collects
> nothing; stars are the only thing it asks for.

---

## Make it yours

Every card below is live, rendered right now by the same endpoint with different options:

<table>
  <tr>
    <td align="center" width="50%">
      <img src="https://maxencelobry.tech/readmeify/api/demo.svg?theme=light" alt="Light theme" width="440"><br>
      <sub><code>?theme=light</code></sub>
    </td>
    <td align="center" width="50%">
      <img src="https://maxencelobry.tech/readmeify/api/demo.svg?spin=1&amp;accent=fb7185" alt="Spinning disc with a rose accent" width="440"><br>
      <sub><code>?spin=1&amp;accent=fb7185</code></sub>
    </td>
  </tr>
  <tr>
    <td align="center">
      <img src="https://maxencelobry.tech/readmeify/api/demo.svg?accent=38bdf8&amp;progress=0" alt="Blue accent, no progress bar" width="440"><br>
      <sub><code>?accent=38bdf8&amp;progress=0</code></sub>
    </td>
    <td align="center">
      <img src="https://maxencelobry.tech/readmeify/api/demo.svg?theme=light&amp;spin=1&amp;accent=a78bfa&amp;equalizer=0" alt="Light theme, spinning disc, violet accent" width="440"><br>
      <sub><code>?theme=light&amp;spin=1&amp;accent=a78bfa&amp;equalizer=0</code></sub>
    </td>
  </tr>
</table>

Add options to the end of the card URL. The site has a live editor for this — change a
setting, watch the preview, copy the new snippet — but you can also type them by hand.

| Option | Values | Default | What it does |
| --- | --- | --- | --- |
| `theme` | `dark`, `light` | `dark` | Card background and text colours |
| `spin` | `1`, `0` | `0` | Album art becomes a record and rotates |
| `accent` | hex colour, no `#` | `1ed760` | Recolours the bars, the progress fill and the status line |
| `progress` | `1`, `0` | `1` | Progress bar and the two timestamps |
| `equalizer` | `1`, `0` | `1` | The little animated bars |
| `ticker` | `1`, `0` | `1` | Whether the elapsed time counts up |

Chain them with `&`:

```markdown
<!-- Light theme, for a light-background profile -->
![](https://maxencelobry.tech/readmeify/api/spotify/YOUR-USERNAME?theme=light)

<!-- Spinning record with a pink accent -->
![](https://maxencelobry.tech/readmeify/api/spotify/YOUR-USERNAME?spin=1&accent=fb7185)

<!-- Stripped down: cover, title, artist -->
![](https://maxencelobry.tech/readmeify/api/spotify/YOUR-USERNAME?progress=0&equalizer=0)
```

A bad value is ignored and the default is used, so you cannot break your card by typing
the wrong thing. The card is always 480×132 pixels, whatever you pick.

---

## Questions people actually ask

**Does it need my Spotify password?**
No. You log in on Spotify's own site, and it hands this app a token that only allows
reading your current track. No password ever touches this project, and no client secret
either — the connection goes through an app already registered on the server.

**What happens when I am not listening to anything?**
The card shows the last track you played, labelled "Last played". If Spotify has no
history at all, it shows a neutral "Not playing" card. It never turns into a broken image.

**How does the clock count up if it is just an image?**
An image cannot run JavaScript. So the card ships every remaining second as a line of
text, stacked in a column and hidden behind a one-line window, and a CSS animation scrolls
that column one line per second. It stops exactly at the end of the track instead of
running away. Tracks with more than 15 minutes left fall back to a fixed time, because the
column would get silly.

**How often does it refresh?**
Every time the page is loaded. GitHub proxies README images through its own cache, which
takes some persuading: answer it with `no-store` and it decides the image is uncacheable,
falls back to a default TTL of five minutes and serves a frozen card for longer than most
songs last. An explicit `max-age=0, s-maxage=0, must-revalidate` is a directive it honours
instead, so every view fetches the current track. The clock ticks on from there.

**What do you store about me?**
Your GitHub id, username and avatar URL, plus a Spotify refresh token that is encrypted at
rest. No listening history, no play counts, no analytics. "Delete my data" on the site
removes the row and the token, and your card URL stops working immediately.

**Can I self-host it?**
Yes, see below. You will need your own GitHub OAuth app and Spotify app.

---

## Built with Claude Code

This whole project — the server, the SVG renderer, the interface, the tests, the
deployment on a VPS behind nginx — was built with
[Claude Code](https://claude.com/claude-code), in one sitting.

I am not publishing it as a "look what the AI wrote" curiosity. I am publishing it because
I am teaching myself to work with these tools in a way that is simple and actually
effective, and this repository is what that looked like on a real project rather than on a
toy. A few things I took away from it:

- **Describe the outcome, not the code.** The prompt that started this was a page of plain
  description: what a user should see, what should never be exposed, what the card should
  look like. Not a file layout.
- **Let it argue with the spec.** My first idea was to ask every user for their own Spotify
  client ID and secret. That got pushed back on with a better design — one shared Spotify
  app, one OAuth flow per user, nobody handing over a secret — and it was right.
- **Verification is the part that matters.** Most of the effort went into independent
  passes trying to break what had just been written: injection attempts on the colour
  parameter, OAuth state replayed across sessions, the card rendered under a real reverse
  proxy. Several genuine bugs came out of that which no amount of re-reading would have
  caught.
- **Small and boring beats clever.** Three dependencies, no build step, no framework, one
  HTML page. It is easier to check something you can read end to end.

If you are learning the same thing, the interesting part of this repo is not the Spotify
integration. It is that a project this size can stay this small.

---

<div align="center">

### Star it

<a href="https://github.com/maxencelobry/readmeify"><img src="https://img.shields.io/github/stars/maxencelobry/readmeify?style=for-the-badge&logo=github&label=star%20this%20repo&labelColor=161616&color=1ed760" alt="Star this repo"></a>

<p>No sponsor link, no newsletter, no "buy me a coffee".<br>
If the card ended up on your profile, a star is the whole ask.</p>

</div>

---

## Self-hosting

<details>
<summary>Everything you need to run your own instance</summary>

### What it is made of

Node.js and Express, SQLite through the built-in `node:sqlite` module, and one page of
plain HTML, CSS and JavaScript. Three dependencies in total, no build step, no framework.

```
src/
  server.js        routes, OAuth, sessions, rate limiting
  spotify.js       Spotify OAuth, token refresh, now-playing
  card.js          the SVG renderer
  card-options.js  query-parameter validation
  db.js            SQLite schema and queries
  crypto.js        AES-256-GCM for tokens at rest
  base-path.js     lets the app mount under a URL prefix
public/            index.html, style.css, app.js
test/              node:test, no framework
sample-data.json   the track shown on the landing page
```

### Requirements

Node.js 22.5 or newer, because it uses the built-in `node:sqlite`. Node 24 is what this
instance runs on.

### Setup

```bash
git clone https://github.com/maxencelobry/readmeify.git
cd readmeify
npm install
cp .env.example .env
```

Generate the two secrets and put them in `.env`:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

`SESSION_SECRET` signs cookies. `ENCRYPTION_KEY` encrypts stored Spotify refresh tokens —
changing it later invalidates every connection, and users simply reconnect.

**GitHub OAuth app** — [github.com/settings/developers](https://github.com/settings/developers)
→ New OAuth App. Homepage URL is your `BASE_URL`, Authorization callback URL is
`BASE_URL/auth/github/callback`. Copy the client ID and generate a client secret. A GitHub
OAuth app accepts only one callback URL, so local development needs its own app.

**Spotify app** — [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard)
→ Create app. Tick Web API. Add `BASE_URL/auth/spotify/callback` under Redirect URIs, press
**Add**, then **Save** — without the Add the field is empty when you save. Copy the client
ID and view the client secret.

A new Spotify app is in **Development Mode**: only accounts you list by email under
Settings → User Management can connect, 25 at most. Lifting that means applying for
Extended Quota Mode from the dashboard, which Spotify reviews by hand. Until then, either
list your users or leave `ALLOW_BYO_SPOTIFY_APP=true` so people can register their own app.

Then:

```bash
npm start
```

### Running behind nginx

`BASE_URL` may include a path, and the app mounts itself there automatically. For
`https://example.com/readmeify` with the app on port 3002:

```nginx
location = /readmeify {
    return 301 https://example.com/readmeify/;
}

location /readmeify/ {
    # No trailing slash on proxy_pass: nginx must forward the URI unchanged so
    # the app still sees /readmeify/... A slash strips the prefix, and every link,
    # asset URL and cookie path the app generates points outside its own mount.
    proxy_pass http://127.0.0.1:3002;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_buffering off;

    # A ticking card is one text node per remaining second. nginx gzips only
    # text/html by default, and skips proxied responses entirely.
    gzip on;
    gzip_proxied any;
    gzip_types image/svg+xml;
    gzip_min_length 1024;
}
```

Set `TRUST_PROXY=loopback` so the rate limiter sees real client addresses. Keep the process
alive with pm2 (`ecosystem.config.cjs` is included) or a systemd unit. There is a
`Dockerfile` too — mount a volume at `/app/data` to keep the database.

### Security notes

- No secret ever reaches the browser, the card URL, or the Markdown snippet.
- Spotify refresh tokens and any user-supplied client secret are encrypted with AES-256-GCM.
- OAuth `state` is random, bound to the session, single-use, and expires server-side.
- Session cookies are signed, `HttpOnly`, `SameSite=Lax`, `Secure` in production, and
  scoped to the mount path. Signing out invalidates every cookie already issued.
- State-changing requests must come from the app's own origin.
- Everything user-supplied is validated before it reaches SQL or the SVG.
- The card endpoint is rate limited and always answers with an image, never a stack trace.

### Routes

| Route | Purpose |
| --- | --- |
| `GET /api/spotify/:username` | The card. Accepts every option above. |
| `GET /api/demo.svg` | Sample card, same options. |
| `GET /api/me` | Current session state as JSON. |
| `GET /auth/github`, `GET /auth/spotify` | Start the OAuth flows. |

```bash
npm test
```

</details>

---

<div align="center">
  <sub>Not affiliated with Spotify or GitHub</sub>
</div>
