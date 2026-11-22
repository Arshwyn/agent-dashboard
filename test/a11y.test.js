'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');
const html = read('index.html');
const app = read('js/app.js');
const css = read('css/app.css');

test('two skip links come first in the page and point at focusable targets', () => {
  const body = html.slice(html.indexOf('<body>'));
  const links = [...body.matchAll(/<a class="skip-link" href="#(\w+)" data-skip="(\w+)">([^<]+)<\/a>/g)];
  assert.deepEqual(
    links.map((m) => m[3]),
    ['Skip to agents', 'Skip to chat'],
  );
  assert.ok(body.indexOf(links[0][0]) < body.indexOf('<header'), 'before the header');
  for (const [, href, data] of links) {
    assert.equal(href, data);
    assert.match(html, new RegExp(`id="${href}"[^>]*tabindex="-1"|tabindex="-1"[^>]*id="${href}"`), href);
  }
  // shown only while focused, never display:none (that would remove it from the tab order)
  assert.match(css, /\.skip-link:focus\s*{\s*transform: none;/);
  assert.equal(/\.skip-link\s*{[^}]*display:\s*none/.test(css), false);
  // activated by script so no fragment navigation (popstate) redraws the chat
  assert.match(app, /querySelectorAll\('\[data-skip\]'\)/);
  assert.match(app, /ev\.preventDefault\(\);\s*var t = document\.getElementById/);
});

test('no positive tabindex anywhere', () => {
  for (const [name, text] of [
    ['index.html', html],
    ['app.js', app],
    ['hub.js', read('js/hub.js')],
  ]) {
    for (const m of text.matchAll(/tabindex['"]?\s*[=:,]\s*['"]?(-?\d+)/gi)) {
      assert.ok(Number(m[1]) <= 0, `${name}: tabindex ${m[1]}`);
    }
  }
});

test('the page has one h1, one main, one named nav, the chat is a named section', () => {
  assert.equal((html.match(/<h1[ >]/g) || []).length, 1);
  assert.equal((html.match(/<main[ >]/g) || []).length, 1);
  assert.equal((html.match(/<header[ >]/g) || []).length, 1);
  assert.equal((html.match(/<nav[ >]/g) || []).length, 1);
  assert.match(html, /<nav[^>]*aria-label="Agents"/);
  assert.match(html, /<section[^>]*aria-label="Chat"/);
  assert.match(html, /<html lang="en">/);
  // the stage reports its state; the canvas is decorative
  assert.match(html, /role="button"[\s\S]*aria-expanded="false"/);
  assert.match(html, /<canvas aria-hidden="true">/);
  // the agent name is the one h2
  assert.equal((html.match(/<h2[ >]/g) || []).length, 1);
});

test('focus returns to the composer after Send and Stop and moves to the first control after Retry', () => {
  assert.match(app, /function restoreFocus\(\)/);
  assert.match(app, /if \(token === chat_\.token\) restoreFocus\(\)/);
  assert.match(app, /focusAfterRetry = chat_\.token/);
  assert.match(app, /function teardownApollo\(\)[\s\S]*document\.activeElement === apollo\.frame/);
});
