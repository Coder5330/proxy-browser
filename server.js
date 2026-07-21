/**
 * Simple server-side web proxy — session-based (no ?url= in the address bar).
 *
 * Change from the original: the target URL is never reflected in the browser's
 * URL bar or query string. It lives entirely in server-side session state,
 * keyed by an httpOnly session cookie. The browser only ever requests plain
 * paths on your own origin, e.g. GET /browse or GET /go/<opaque-id>.
 *
 * Two moving parts had to change together:
 *  1. The route no longer reads req.query.url — it reads req.session.target.
 *  2. Rewritten links can no longer embed the destination as a query param
 *     either (that would just move the leak from the address bar into the
 *     page's HTML/history). Instead each rewritten link gets a short opaque
 *     id that maps to a real URL in a server-side table; visiting it updates
 *     the session and redirects to plain /browse.
 */
const express = require('express');
const session = require('express-session');
const cheerio = require('cheerio');
const crypto = require('crypto');
const { URL } = require('url');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.urlencoded({ extended: false }));
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax' },
  })
);

// Opaque id -> real absolute URL. In-memory demo store; use Redis/etc for
// anything beyond a single-process demo, and add expiry/eviction.
const linkMap = new Map();

function shortId() {
  return crypto.randomBytes(6).toString('base64url');
}

// Instead of returning a URL with ?url= baked in, register the destination
// under a short id and return a path that carries no destination info at all.
function proxify(rawUrl, baseUrl) {
  try {
    const absolute = new URL(rawUrl, baseUrl).toString();
    const id = shortId();
    linkMap.set(id, absolute);
    return `/go/${id}`;
  } catch {
    return rawUrl;
  }
}

// Visiting /go/<id> looks up the real URL server-side, stores it in the
// session, and redirects to the plain /browse route (no query string).
app.get('/go/:id', (req, res) => {
  const target = linkMap.get(req.params.id);
  if (!target) return res.status(404).send('Expired or unknown link.');
  req.session.target = target;
  res.redirect('/browse');
});

app.get('/browse', async (req, res) => {
  const target = req.session.target;
  if (!target) {
    return res.redirect('/');
  }

  let response;
  try {
    response = await fetch(target, {
      headers: { 'User-Agent': 'Mozilla/5.0 (SimpleProxyDemo)' },
      redirect: 'follow',
    });
  } catch (err) {
    console.error(err);
    return res.status(502).send(
      `Failed to fetch target: ${err.message} | cause: ${err.cause?.message || err.cause || 'unknown'}`
    );
  }

  // Use the URL *after* redirects as the base for resolving relative links,
  // and keep the session pinned to it (handles redirects to a new origin).
  const finalUrl = response.url || target;
  req.session.target = finalUrl;
  const origin = new URL(finalUrl).origin;
  req.session.origin = origin; // replaces the old proxy_origin cookie

  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('text/html')) {
    res.set('content-type', contentType);
    const buffer = Buffer.from(await response.arrayBuffer());
    return res.send(buffer);
  }

  const html = await response.text();
  const $ = cheerio.load(html);

  $('a[href]').each((_, el) => {
    $(el).attr('href', proxify($(el).attr('href'), finalUrl));
  });
  $('img[src]').each((_, el) => {
    $(el).attr('src', proxify($(el).attr('src'), finalUrl));
  });
  $('img[srcset]').each((_, el) => {
    const rewritten = $(el)
      .attr('srcset')
      .split(',')
      .map((part) => {
        const [url, descriptor] = part.trim().split(/\s+/);
        return [proxify(url, finalUrl), descriptor].filter(Boolean).join(' ');
      })
      .join(', ');
    $(el).attr('srcset', rewritten);
  });
  $('link[href]').each((_, el) => {
    $(el).attr('href', proxify($(el).attr('href'), finalUrl));
  });
  $('script[src]').each((_, el) => {
    $(el).attr('src', proxify($(el).attr('src'), finalUrl));
  });
  $('form[action]').each((_, el) => {
    $(el).attr('action', proxify($(el).attr('action'), finalUrl));
  });
  $('iframe[src]').each((_, el) => {
    $(el).attr('src', proxify($(el).attr('src'), finalUrl));
  });

  res.set('content-type', 'text/html');
  res.send($.html());
});

app.get('/', (req, res) => {
  res.send(`
    <h2>Simple Proxy Demo</h2>
    <form action="/start" method="post">
      <input name="url" placeholder="https://example.com" style="width:300px" />
      <button type="submit">Go</button>
    </form>
  `);
});

// Form posts here so the entered URL travels in the POST body, not the
// address bar, then gets stashed in the session before we redirect.
app.post('/start', (req, res) => {
  if (!req.body.url) return res.status(400).send('Missing url');
  req.session.target = req.body.url;
  res.redirect('/browse');
});

// Catch-all: any stray bare path (e.g. from client-side JS doing
// window.location = '/some/path') gets rebuilt using the session's
// remembered origin and re-proxied through /browse.
app.use((req, res) => {
  const origin = req.session.origin;
  if (origin) {
    const rebuilt = origin + req.originalUrl;
    req.session.target = rebuilt;
    return res.redirect('/browse');
  }
  res.status(404).send('Not found (no proxy origin set — start from / and enter a URL).');
});

app.listen(PORT, () => {
  console.log(`Proxy running at http://localhost:${PORT}`);
});
