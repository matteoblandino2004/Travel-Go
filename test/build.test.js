/**
 * The hosted build is assembled by a script, not served from source, so it can
 * drift from the page it is built out of without anything failing. It already
 * did: the head was hand-rebuilt from the <title> alone, which silently
 * dropped the viewport meta (phones laid the page out at ~980px and scaled it
 * down), the charset, the favicon, the description and every crawler tag, and
 * requested font families the stylesheet never uses.
 *
 * These tests build the real output and assert the published bytes, because
 * that drift is invisible to every other test in the suite.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Builds the site into a throwaway directory and returns the published files. */
function build(env = {}) {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'travelgo-build-'));
  execFileSync(process.execPath, [path.join(root, 'scripts', 'build-site.mjs')], {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: 'pipe',
  });
  const site = path.join(root, '_site');
  for (const name of fs.readdirSync(site)) {
    fs.copyFileSync(path.join(site, name), path.join(out, name));
  }
  return {
    dir: out,
    html: fs.readFileSync(path.join(out, 'index.html'), 'utf8'),
    read: (name) => fs.readFileSync(path.join(out, name), 'utf8'),
    has: (name) => fs.existsSync(path.join(out, name)),
  };
}

const site = build();

test('the published page is a complete document', () => {
  assert.match(site.html, /^<!doctype html>/i, 'no doctype - browsers fall into quirks mode');
  assert.match(site.html, /<html lang="[a-z-]+"/i, 'no lang, which screen readers need');
  assert.match(site.html, /<meta charset="utf-8"/i);
  assert.match(site.html, /<\/body>\s*<\/html>\s*$/i, 'document is left unclosed');
});

test('the viewport meta survives the build', () => {
  // Without this a phone lays the page out at ~980px and scales it down, so
  // every control renders at roughly 40% of its intended size.
  assert.match(site.html, /<meta name="viewport" content="width=device-width/i);
});

test('the build carries the head through instead of rebuilding it', () => {
  const source = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  const tags = [
    'name="description"',
    'rel="icon"',
    'rel="canonical"',
    'name="theme-color"',
    'property="og:title"',
    'property="og:image"',
    'name="twitter:card"',
    'application/ld+json',
  ];
  for (const tag of tags) {
    assert.ok(source.includes(tag), `public/index.html should declare ${tag}`);
    assert.ok(site.html.includes(tag), `the build dropped ${tag} from the head`);
  }
});

test('the build requests the font families the stylesheet actually uses', () => {
  // The hand-built head asked for IBM Plex Sans while the CSS set Archivo, so
  // the hosted site fell back to a system font for every word of UI.
  const css = fs.readFileSync(path.join(root, 'public', 'styles.css'), 'utf8');
  const declared = [...css.matchAll(/--font-(?:ui|data):\s*"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(declared.length >= 2, 'expected --font-ui and --font-data to be set');

  const requested = /fonts\.googleapis\.com\/css2\?([^"]+)/.exec(site.html)?.[1] ?? '';
  for (const family of declared) {
    assert.ok(
      requested.includes(family.replaceAll(' ', '+')),
      `stylesheet uses "${family}" but the build never requests it`,
    );
  }
});

test('there is no link to a stylesheet the single-file build does not publish', () => {
  assert.ok(!site.html.includes('href="/styles.css"'), 'stale /styles.css link would 404');
  assert.ok(!site.has('styles.css'));
  assert.match(site.html, /<style>/);
});

test('crawler files are published and agree with each other', () => {
  assert.ok(site.has('robots.txt'));
  assert.ok(site.has('sitemap.xml'));
  assert.ok(site.has('og.png'), 'link previews need the social image');

  const canonical = /rel="canonical" href="([^"]+)"/.exec(site.html)?.[1];
  assert.ok(canonical, 'no canonical URL');

  const loc = /<loc>([^<]+)<\/loc>/.exec(site.read('sitemap.xml'))?.[1];
  assert.equal(loc, canonical, 'sitemap and canonical disagree about the origin');

  assert.ok(
    site.read('robots.txt').includes(`Sitemap: ${canonical}sitemap.xml`),
    'robots.txt does not point at the sitemap',
  );
  assert.match(site.read('robots.txt'), /^User-agent: \*/m);
});

test('a custom domain rewrites every absolute URL, leaving none on the old origin', () => {
  // A canonical tag left pointing at github.io would tell Google the real page
  // lives somewhere else, which is worse than having no canonical at all.
  const custom = build({ SITE_URL: 'https://travelgo.example/' });

  assert.equal(/rel="canonical" href="([^"]+)"/.exec(custom.html)?.[1], 'https://travelgo.example/');
  assert.equal(
    /property="og:url" content="([^"]+)"/.exec(custom.html)?.[1],
    'https://travelgo.example/',
  );
  assert.equal(
    /property="og:image" content="([^"]+)"/.exec(custom.html)?.[1],
    'https://travelgo.example/og.png',
  );
  assert.ok(
    !/github\.io/.test(custom.html.slice(0, custom.html.indexOf('<style>'))),
    'the head still references the github.io origin',
  );
  assert.equal(/<loc>([^<]+)<\/loc>/.exec(custom.read('sitemap.xml'))?.[1], 'https://travelgo.example/');
});

test('SITE_URL without a trailing slash still produces well-formed URLs', () => {
  const custom = build({ SITE_URL: 'https://travelgo.example' });
  assert.equal(/rel="canonical" href="([^"]+)"/.exec(custom.html)?.[1], 'https://travelgo.example/');
  assert.ok(!custom.read('robots.txt').includes('//sitemap.xml'));
});
