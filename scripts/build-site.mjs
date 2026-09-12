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
if (fs.existsSync(cname)) fs.copyFileSync(cname, path.join(out, 'CNAME'));

const bytes = fs.statSync(path.join(out, 'index.html')).size;
console.log(`Wrote _site/ — index.html is ${(bytes / 1024 / 1024).toFixed(2)} MB`);
