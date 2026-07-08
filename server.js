/**
 * Simple server-side web proxy.
 *
 * How it works:
 * 1. User visits  http://localhost:3000/browse?url=https://example.com
 * 2. OUR server fetches that page (server-to-server request — no browser
 *    involved, so the target's X-Frame-Options is irrelevant).
 * 3. We rewrite the HTML so links, forms, images, and stylesheets point
 *    back through our own /browse?url=... route instead of the original
 *    domain.
 * 4. We send the rewritten HTML to the user's browser, served from OUR
 *    origin (localhost:3000). The browser never talks to the target site
 *    directly, so there's nothing for X-Frame-Options to block.
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

  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('text/html')) {
    res.set('content-type', contentType);
    const buffer = Buffer.from(await response.arrayBuffer());
    return res.send(buffer);
  }

  const html = await response.text();
  const $ = cheerio.load(html);

  $('a[href]').each((_, el) => {
    $(el).attr('href', proxify($(el).attr('href'), target));
  });
  $('img[src]').each((_, el) => {
    $(el).attr('src', proxify($(el).attr('src'), target));
  });
  $('img[srcset]').each((_, el) => {
    const rewritten = $(el)
      .attr('srcset')
      .split(',')
      .map((part) => {
        const [url, descriptor] = part.trim().split(/\s+/);
        return [proxify(url, target), descriptor].filter(Boolean).join(' ');
      })
      .join(', ');
    $(el).attr('srcset', rewritten);
  });
  $('link[href]').each((_, el) => {
    $(el).attr('href', proxify($(el).attr('href'), target));
  });
  $('script[src]').each((_, el) => {
    $(el).attr('src', proxify($(el).attr('src'), target));
  });
  $('form[action]').each((_, el) => {
    $(el).attr('action', proxify($(el).attr('action'), target));
  });
  $('iframe[src]').each((_, el) => {
    $(el).attr('src', proxify($(el).attr('src'), target));
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

app.listen(PORT, () => {
  console.log(`Proxy running at http://localhost:${PORT}`);
});
