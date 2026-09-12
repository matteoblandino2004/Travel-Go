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

const title = /<title>([^<]+)<\/title>/.exec(html)?.[1] ?? 'Travel-Go';

const page = `<title>${title}</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&display=swap" />
<style>
${css}
</style>

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
`;

fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
const out = path.join(root, 'dist', 'travel-go.html');
fs.writeFileSync(out, page);

console.log(
  `Wrote dist/travel-go.html — ${(page.length / 1024 / 1024).toFixed(2)} MB ` +
    `(${modules.length} modules, ${(airports.length / 1024).toFixed(0)} KB of airport data)`
);
