#!/usr/bin/env node
/**
 * Builds dist/travel-go.html: the whole app in one file, no server.
 *
 *   npm run build:standalone
 *
 * This is what gets published as a hosted page. It is the same UI and the same
 * scoring engine as `npm start` - the difference is the backend behind it
 * (public/local-backend.js) and what that backend can reach. Nothing is
 * reimplemented for the browser; the modules are bundled from source, so the
 * hosted page can't drift from the local app.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundle } from './bundle.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

const html = read('public/index.html');
const css = read('public/styles.css');
const airports = read('src/data/airports.json');

const { code, modules } = bundle({
  root,
  entries: ['public/app.js', 'public/local-backend.js'],
  // The browser has no filesystem; the dataset is injected instead.
  stubs: { 'node:fs': '', 'node:path': '', 'node:url': '' },
});

/** Everything between <body> and </body> in the served page. */
const body = html
  .slice(html.indexOf('<body>') + '<body>'.length, html.lastIndexOf('</body>'))
  .replace(/\n\s*<script type="module" src="\/app\.js"><\/script>/, '')
  .trim();

/* The real <head>, carried through rather than rebuilt.
 *
 * This used to hand-assemble a head from the <title> alone, which silently
 * dropped everything else the served page declares. The build had drifted
 * badly as a result: no viewport (so phones laid the page out at ~980px and
 * scaled it down), no charset, no favicon, no description, and a font link
 * naming families the stylesheet does not use. Anything that belongs in the
 * head now belongs in public/index.html, once, and arrives here by itself.
 *
 * Only the local stylesheet link is removed, because the CSS is inlined below
 * and there is no /styles.css to fetch in a single-file build. */
const head = html
  .slice(html.indexOf('<head>') + '<head>'.length, html.indexOf('</head>'))
  .replace(/\n\s*<link rel="stylesheet" href="\/styles\.css"\s*\/?>/, '')
  // Authoring notes are for whoever edits the page, not for whoever views it.
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/\n{3,}/g, '\n\n')
  .trim();

const lang = /<html[^>]*\blang="([^"]+)"/.exec(html)?.[1] ?? 'en';

const page = `<!doctype html>
<html lang="${lang}">
<head>
${head}
<style>
${css}
</style>
</head>
<body>
${body}

<script type="application/json" id="airport-data">${airports}</script>

<script type="module">
${code}

// Install the in-page backend before the app boots, so it never reaches for a
// server that isn't there.
const airportData = JSON.parse(document.getElementById('airport-data').textContent);
globalThis.TRAVELGO_BACKEND = __require('public/local-backend.js').createLocalBackend(airportData);
__require('public/app.js');
</script>
</body>
</html>
`;

fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
const out = path.join(root, 'dist', 'travel-go.html');
fs.writeFileSync(out, page);

console.log(
  `Wrote dist/travel-go.html — ${(page.length / 1024 / 1024).toFixed(2)} MB ` +
    `(${modules.length} modules, ${(airports.length / 1024).toFixed(0)} KB of airport data)`
);
