// The URL path prefix a deployment lives under: '' at the origin root,
// '/readmeify' for https://example.com/readmeify. Its own file only so it can
// be tested without importing server.js, which starts listening on import.
// Throws on anything unusable: the result is fed to app.use() and to the cookie
// path, so a typo is a site-wide outage rather than a wrong redirect_uri.
// server.js turns the throw into a one-line boot failure.
export const basePath = (baseUrl) => {
  const { protocol, pathname } = new URL(baseUrl); // throws when the scheme is missing
  // "localhost:3000" parses, with protocol "localhost:" and pathname "3000".
  if (protocol !== 'http:' && protocol !== 'https:') throw new Error(`unsupported scheme "${protocol}"`);
  const path = pathname.replace(/\/+$/, '');
  // path-to-regexp metacharacters must not reach app.use(): "/my:app" mounts a
  // wildcard that the literal cookie path can never match, "/app(1)" throws.
  if (path && !/^(\/[A-Za-z0-9._~-]+)+$/.test(path)) throw new Error(`unusable path prefix "${path}"`);
  return path;
};
