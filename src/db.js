import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const file = resolve(process.env.DB_PATH || './data/readmeify.db');
mkdirSync(dirname(file), { recursive: true });

const db = new DatabaseSync(file);

// Schema is idempotent, so it doubles as the migration step: it runs on every
// boot and only creates what is missing. Additive changes go here as further
// `CREATE TABLE IF NOT EXISTS` / `ALTER TABLE` guarded statements.
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    id                        INTEGER PRIMARY KEY AUTOINCREMENT,
    github_id                 TEXT NOT NULL UNIQUE,
    github_login              TEXT NOT NULL,
    github_login_lower        TEXT NOT NULL UNIQUE,
    github_avatar_url         TEXT,
    spotify_client_id         TEXT,
    spotify_client_secret_enc TEXT,
    spotify_refresh_token_enc TEXT,
    spotify_display_name      TEXT,
    session_version           INTEGER NOT NULL DEFAULT 0,
    created_at                INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    updated_at                INTEGER NOT NULL DEFAULT (strftime('%s','now'))
  );
`);

// Additive migration for databases created before session_version existed.
try {
  db.exec('ALTER TABLE users ADD COLUMN session_version INTEGER NOT NULL DEFAULT 0');
} catch {
  /* already present */
}

const stmts = {
  byId: db.prepare('SELECT * FROM users WHERE id = ?'),
  byLogin: db.prepare('SELECT * FROM users WHERE github_login_lower = ?'),
  byGithubId: db.prepare('SELECT * FROM users WHERE github_id = ?'),
  insert: db.prepare(`
    INSERT INTO users (github_id, github_login, github_login_lower, github_avatar_url)
    VALUES (?, ?, ?, ?)
  `),
  updateGithub: db.prepare(`
    UPDATE users
       SET github_login = ?, github_login_lower = ?, github_avatar_url = ?,
           updated_at = strftime('%s','now')
     WHERE id = ?
  `),
  setApp: db.prepare(`
    UPDATE users
       SET spotify_client_id = ?, spotify_client_secret_enc = ?,
           spotify_refresh_token_enc = NULL, spotify_display_name = NULL,
           updated_at = strftime('%s','now')
     WHERE id = ?
  `),
  setToken: db.prepare(`
    UPDATE users
       SET spotify_refresh_token_enc = ?, spotify_display_name = ?,
           updated_at = strftime('%s','now')
     WHERE id = ?
  `),
  clearToken: db.prepare(`
    UPDATE users
       SET spotify_refresh_token_enc = NULL, spotify_display_name = NULL,
           updated_at = strftime('%s','now')
     WHERE id = ?
  `),
  // Hands a login back without touching the row: ':' cannot occur in a GitHub
  // login, so the marker can never collide with a real one.
  releaseLogin: db.prepare(`
    UPDATE users
       SET github_login_lower = 'released:' || id, updated_at = strftime('%s','now')
     WHERE id = ?
  `),
  bumpSession: db.prepare(`
    UPDATE users
       SET session_version = session_version + 1, updated_at = strftime('%s','now')
     WHERE id = ?
  `),
  deleteUser: db.prepare('DELETE FROM users WHERE id = ?'),
};

export const getUserById = (id) => stmts.byId.get(id) ?? null;
export const getUserByLogin = (login) => stmts.byLogin.get(String(login).toLowerCase()) ?? null;

/** Creates the user on first GitHub login, otherwise refreshes login + avatar. */
export function upsertGithubUser({ githubId, login, avatarUrl }) {
  const existing = stmts.byGithubId.get(String(githubId));
  // A renamed or deleted GitHub account frees a login someone else can now own.
  // The stale row only loses the login (its card URL stops resolving until that
  // user signs in again) — deleting it would destroy a stranger's account.
  const holder = getUserByLogin(login);
  if (holder && holder.id !== existing?.id) stmts.releaseLogin.run(holder.id);
  if (existing) {
    stmts.updateGithub.run(login, login.toLowerCase(), avatarUrl ?? null, existing.id);
    return getUserById(existing.id);
  }
  const { lastInsertRowid } = stmts.insert.run(
    String(githubId),
    login,
    login.toLowerCase(),
    avatarUrl ?? null,
  );
  return getUserById(Number(lastInsertRowid));
}

/** Stores a user-owned Spotify app. Passing nulls reverts them to the shared app. */
export function setSpotifyApp(userId, clientId, clientSecretEnc) {
  stmts.setApp.run(clientId, clientSecretEnc, userId);
}

export function setSpotifyToken(userId, refreshTokenEnc, displayName) {
  stmts.setToken.run(refreshTokenEnc, displayName ?? null, userId);
}

export function clearSpotifyToken(userId) {
  stmts.clearToken.run(userId);
}

/** Invalidates every session cookie already issued to this user. */
export function bumpSessionVersion(userId) {
  stmts.bumpSession.run(userId);
}

export function deleteUser(userId) {
  stmts.deleteUser.run(userId);
}
