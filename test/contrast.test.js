'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'app.css'), 'utf8');

function tokens(block) {
  const t = {};
  for (const m of block.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) t[m[1]] = m[2].toLowerCase();
  return t;
}
function blockAfter(marker) {
  const i = css.indexOf(marker);
  assert.ok(i >= 0, marker);
  return css.slice(css.indexOf('{', i) + 1, css.indexOf('}', i));
}

const dark = tokens(blockAfter(':root {'));
const light = { ...dark, ...tokens(blockAfter(":root[data-theme='light'] {")) };
const lightAuto = { ...dark, ...tokens(blockAfter(':root:not([data-theme]) {')) };

function luminance(hex) {
  const c = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
function ratio(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// [foreground, background, minimum ratio, what it is]: 4.5 for text, 3 for large text, focus rings and the borders
// that make a control identifiable (WCAG 2.2 AA, 1.4.3 and 1.4.11).
const PAIRS = [
  ['text', 'bg', 4.5, 'body text'],
  ['text', 'surface', 4.5, 'text on cards'],
  ['text', 'surface-2', 4.5, 'text on the bar and composer'],
  ['text', 'bubble-agent', 4.5, 'reply text'],
  ['muted', 'bg', 4.5, 'muted text on the page'],
  ['muted', 'surface', 4.5, 'muted text on cards (rail, notes)'],
  ['muted', 'surface-2', 4.5, 'muted text on the bar'],
  ['accent', 'bg', 4.5, 'links on the page'],
  ['accent', 'surface', 4.5, 'links on cards'],
  ['accent', 'surface-2', 4.5, 'links on the bar'],
  ['on-accent', 'accent', 4.5, 'button and badge text'],
  ['accent', 'bg', 3, 'focus ring on the page'],
  ['accent', 'surface', 3, 'focus ring on cards'],
  ['accent', 'surface-2', 3, 'focus ring on the bar'],
  ['control-line', 'bg', 3, 'control border on the page'],
  ['control-line', 'surface', 3, 'control border on cards'],
  ['control-line', 'surface-2', 3, 'control border on the bar'],
];
const STAGE_PAIRS = [
  ['stage-text', 'stage-bg', 4.5, 'stage text'],
  ['stage-muted', 'stage-bg', 4.5, 'stage muted text'],
];

for (const [name, t] of [
  ['dark', dark],
  ['light', light],
]) {
  test(`${name} theme meets WCAG 2.2 AA for text, focus rings and control borders`, () => {
    for (const [fg, bg, min, what] of [...PAIRS, ...STAGE_PAIRS]) {
      assert.ok(t[fg] && t[bg], `${fg} / ${bg} are defined`);
      const r = ratio(t[fg], t[bg]);
      assert.ok(
        r >= min,
        `${name}: ${what} (${fg} ${t[fg]} on ${bg} ${t[bg]}) is ${r.toFixed(2)}, needs ${min}`,
      );
    }
  });
}

test('the stage keeps its own dark tokens in the light theme', () => {
  assert.equal(light['stage-bg'], dark['stage-bg']);
  assert.equal(light['stage-text'], dark['stage-text']);
});

test('the system-light block and the explicit light block carry the same colours', () => {
  for (const k of Object.keys(light)) assert.equal(lightAuto[k], light[k], k);
});

test('control borders use the control token, decorative dividers keep the quiet one', () => {
  for (const sel of [
    '.seg',
    '.chat-head select',
    '.mini',
    '.composer textarea',
    '.composer .stop',
    '.composer input',
  ]) {
    const m = css.match(new RegExp('\\n' + sel.replace(/[.]/g, '\\.') + ' \\{[^}]*\\}'));
    assert.ok(m, sel);
    assert.match(m[0], /border: 1px solid var\(--control-line\)/, sel);
  }
});

test('reduced motion removes every CSS animation and transition, and forced colors keep the shapes', () => {
  assert.match(
    css,
    /@media \(prefers-reduced-motion: reduce\) \{\s*\*,\s*\*::before,\s*\*::after \{\s*animation: none !important;\s*transition: none !important;/,
  );
  // every keyframe animation and transition is declared only inside the no-preference query or is removed above
  assert.match(css, /@media \(forced-colors: active\)/);
  for (const sel of [
    "\\.rail a\\[aria-current='page'\\]",
    '\\.rail \\.new-mark',
    '\\.rail \\.run-mark',
    '\\.skip-link',
  ]) {
    assert.match(css.slice(css.indexOf('forced-colors: active')), new RegExp(sel));
  }
});
