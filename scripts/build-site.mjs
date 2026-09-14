#!/usr/bin/env node
/**
 * Assembles the deployable static site into _site/.
 *
 *   npm run build:site
 *
 * One command every host can use, so GitHub Pages, Cloudflare Pages and
 * Netlify all deploy the identical output and none of them needs its own
 * bespoke build steps buried in a dashboard.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, '_site');

execFileSync(process.execPath, [path.join(root, 'scripts', 'build-standalone.mjs')], {
  stdio: 'inherit',
});

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
fs.copyFileSync(path.join(root, 'dist', 'travel-go.html'), path.join(out, 'index.html'));

// Tells GitHub Pages not to run the output through Jekyll, which would
// otherwise drop anything beginning with an underscore.
fs.writeFileSync(path.join(out, '.nojekyll'), '');

// A custom domain, once one is configured. GitHub Pages reads CNAME from the
// published site; the other hosts take the domain from their own dashboard and
// simply ignore the file.
const cname = path.join(root, 'CNAME');
const domain = fs.existsSync(cname) ? fs.readFileSync(cname, 'utf8').trim() : '';
if (domain) fs.copyFileSync(cname, path.join(out, 'CNAME'));

/* One origin, derived once and used for the canonical link, the Open Graph
 * URLs, the structured data and the sitemap. A wrong canonical is worse than
 * none - it tells Google the real page lives somewhere else - so this is
 * deliberately not hand-maintained in the markup.
 *
 *   CNAME present  -> https://<that domain>/         (the custom domain wins)
 *   SITE_URL set   -> whatever it says               (staging, forks)
 *   neither        -> the github.io project URL
 */
const FALLBACK_URL = 'https://matteoblandino2004.github.io/Travel-Go/';
const siteUrl = (domain ? `https://${domain}/` : process.env.SITE_URL || FALLBACK_URL)
  .replace(/\/*$/, '/');

const indexPath = path.join(out, 'index.html');
let html = fs.readFileSync(indexPath, 'utf8');
const before = html;
html = html.replaceAll(FALLBACK_URL, siteUrl);
fs.writeFileSync(indexPath, html);

// Copy the social preview image through, if present.
const og = path.join(root, 'public', 'og.png');
if (fs.existsSync(og)) fs.copyFileSync(og, path.join(out, 'og.png'));

// Crawler essentials. Without these the site is reachable but effectively
// unlisted: nothing points a crawler at it and nothing declares what to index.
fs.writeFileSync(
  path.join(out, 'robots.txt'),
  ['User-agent: *', 'Allow: /', '', `Sitemap: ${siteUrl}sitemap.xml`, ''].join('\n'),
);

fs.writeFileSync(
  path.join(out, 'sitemap.xml'),
  `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${siteUrl}</loc>
    <lastmod>${new Date().toISOString().slice(0, 10)}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>1.0</priority>
  </url>
</urlset>
`,
);

console.log(
  `Site origin: ${siteUrl}` +
    (domain ? '  (from CNAME)' : process.env.SITE_URL ? '  (from SITE_URL)' : '  (default)'),
);
if (before !== html) console.log('Rewrote canonical, Open Graph and structured-data URLs.');

const bytes = fs.statSync(path.join(out, 'index.html')).size;
console.log(`Wrote _site/ — index.html is ${(bytes / 1024 / 1024).toFixed(2)} MB`);
