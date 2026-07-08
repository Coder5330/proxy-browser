/**
 * Simple server-side web proxy (with bare-path recovery).
 *
 * The `?url=` design has one blind spot: when a page's JavaScript navigates
 * to an absolute path (e.g. auth-guard.js doing window.location='/auth/...'),
 * the browser requests that path from OUR origin (localhost:3000), not through
 * /browse. To recover, we remember the current site's origin in a cookie and
 * add a catch-all route that re-proxies any stray bare path back through /browse.
 *
 * Uses Node's built-in global fetch — no node-fetch package needed.
 */
const express = require('express');
const cheerio = require('cheerio');
const { URL } = require('url');

const app = express();
const PORT = process.env.PORT || 3000;

function proxify(rawUrl, baseUrl) {
  try {
    const absolute = new URL(rawUrl, baseUrl).toString();
    return `/browse?url=${encodeURIComponent(absolute)}`;
  } catch {
    return rawUrl;
  }
}

// Minimal cookie reader (avoids adding cookie-parser as a dependency).
function getCookie(req, name) {
  const raw = req.headers.cookie || '';
  const match = raw.split(';').map((c) => c.trim()).find((c) => c.startsWith(name + '='));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : null;
}

app.get('/browse', async (req, res) => {
  const target = req.query.url;
  if (!target) {
    return res.status(400).send('Missing ?url= parameter');
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

  // Use the URL *after* redirects as the base for resolving relative links.
  const finalUrl = response.url || target;
  const origin = new URL(finalUrl).origin;

  // Remember this origin so the catch-all route can rebuild stray bare paths.
  res.cookie
    ? res.cookie('proxy_origin', origin, { path: '/' })
    : res.setHeader('Set-Cookie', `proxy_origin=${encodeURIComponent(origin)}; Path=/`);

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
    <form action="/browse" method="get">
      <input name="url" placeholder="https://example.com" style="width:300px" />
      <button type="submit">Go</button>
    </form>
  `);
});

// Catch-all: any stray bare path (e.g. from a JS redirect) gets rebuilt into
// a full URL using the remembered origin and re-proxied through /browse.
app.use((req, res) => {
  const origin = getCookie(req, 'proxy_origin');
  if (origin) {
    const rebuilt = origin + req.originalUrl;
    return res.redirect('/browse?url=' + encodeURIComponent(rebuilt));
  }
  res.status(404).send('Not found (no proxy origin set — start from / and enter a URL).');
});

app.listen(PORT, () => {
  console.log(`Proxy running at http://localhost:${PORT}`);
});
