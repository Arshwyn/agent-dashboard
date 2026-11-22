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

test('one polite status region serves the whole page and the message log is never live', () => {
  assert.equal((html.match(/id="announcer"/g) || []).length, 1);
  assert.match(html, /id="announcer" role="status" aria-live="polite"/);
  assert.equal(
    /role: 'status', 'aria-live': 'polite' \}\);\s*chat\.appendChild\(announcer\)/.test(app),
    false,
  );
  assert.match(app, /role: 'log',[\s\S]*'aria-live': 'off'/);
  assert.match(app, /log\.setAttribute\('aria-busy'/);
  assert.match(app, /announce\(window\.HubState\.showing\(/);
  // the reply result is announced once, at the event, never from a redraw
  assert.equal((app.match(/Reply from ' \+ a\.name \+ ' complete/g) || []).length, 1);
});

test('every created control has an accessible name', () => {
  // each button/select/textarea/input built in app.js carries text, an aria-label or a title
  for (const m of app.matchAll(/el\(\s*'(select|textarea|input)',\s*{([^}]*)}/g)) {
    assert.match(m[2], /'aria-label'/, `${m[1]} has aria-label`);
  }
  assert.equal(/<button[^>]*><\/button>/.test(html), false);
  assert.match(html, /<div class="seg" role="group" aria-label="Theme">/);
});

const { STATES, showing, newReply, noMessages } = require('../public/js/hubstate');

test('every page-level state has plain words and, where one exists, a named next step', () => {
  const need = { rosterFailed: 'Retry', expired: 'Reload' };
  assert.deepEqual(Object.keys(STATES).sort(), [
    'expired',
    'noConversations',
    'offline',
    'online',
    'rosterFailed',
  ]);
  for (const [k, v] of Object.entries(STATES)) {
    assert.ok(v.text.length > 10 && /[.]$/.test(v.text) && !/[<>{}]/.test(v.text), k);
    assert.equal(v.next, need[k] || '', k);
    if (v.next) assert.match(app + html, new RegExp(v.next), `${k}: the ${v.next} control exists`);
  }
  for (const t of [showing('Themis'), newReply('Themis'), noMessages('Themis')]) {
    assert.ok(t.includes('Themis') && !/[<>{}]/.test(t));
  }
});

test('offline and expired sessions disable Send with the reason, and nothing is queued or cached', () => {
  assert.match(html, /id="netbar" role="status" hidden/);
  assert.match(app, /bSend\.disabled = on \|\| !st\.enabled \|\| offline \|\| expired/);
  assert.match(app, /setAttribute\('aria-describedby', 'netbar'\)/);
  assert.match(app, /addEventListener\('offline'/);
  assert.match(app, /addEventListener\('online'/);
  assert.match(app, /if \(r\.status === 401\) setNetBar\('expired'\)/);
  // no retry loop on an expired session: the only action is the Reload button
  assert.equal(/setInterval\([^)]*expired/.test(app), false);
});

test('on narrow screens the chat keeps room for the log and composer so the page scrolls instead of clipping', () => {
  assert.match(css, /@media \(max-width: 899px\) \{\s*\.chat \{\s*min-height: 420px;/);
});
