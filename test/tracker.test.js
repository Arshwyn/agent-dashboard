'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createRunning } = require('../public/js/hubstate');

test('the first observation sets no marker and the selected agent never gets one', () => {
  const t = createRunning();
  assert.deepEqual(t.apply(t.begin(), 'themis', 'janus'), { applied: true, marked: [] });
  assert.equal(t.running(), 'themis');
  // the selected agent finished its own reply
  const u = createRunning();
  u.apply(u.begin(), 'themis', 'themis');
  assert.deepEqual(u.apply(u.begin(), null, 'themis').marked, []);
  assert.deepEqual(u.list(), []);
});

test('an agent that stopped running while another was open gets a marker, cleared by opening it', () => {
  const t = createRunning();
  t.apply(t.begin(), 'themis', 'themis');
  const r = t.apply(t.begin(), null, 'janus');
  assert.deepEqual(r.marked, ['themis']);
  assert.equal(t.has('themis'), true);
  // announced once: a repeated idle poll marks nothing new
  assert.deepEqual(t.apply(t.begin(), null, 'janus').marked, []);
  assert.deepEqual(t.list(), ['themis']);
  assert.equal(t.select('themis'), true);
  assert.equal(t.has('themis'), false);
  assert.equal(t.select('themis'), false);
});

test('a reply started here and left while it runs is marked when it ends', () => {
  const t = createRunning();
  t.local('atlas'); // sent from Atlas, then the owner opens another agent
  assert.equal(t.running(), 'atlas');
  assert.deepEqual(t.apply(t.begin(), null, 'iris').marked, ['atlas']);
});

test('an agent replaced by another running agent also counts as finished', () => {
  const t = createRunning();
  t.apply(t.begin(), 'plutus', 'iris');
  assert.deepEqual(t.apply(t.begin(), 'atlas', 'iris').marked, ['plutus']);
  assert.equal(t.running(), 'atlas');
});

test('a poll that started before a local send cannot undo it (epoch race)', () => {
  const t = createRunning();
  const epoch = t.begin(); // poll starts, sees nothing running
  t.local('themis'); // the owner sends before the answer arrives
  const late = t.apply(epoch, null, 'themis');
  assert.deepEqual(late, { applied: false, marked: [] });
  assert.equal(t.running(), 'themis');
  // a poll that starts after the send is applied
  assert.equal(t.apply(t.begin(), 'themis', 'themis').applied, true);
  // a read that must always apply (the status fetched when a chat opens) passes no epoch
  assert.equal(t.apply(undefined, null, 'themis').applied, true);
  assert.equal(t.running(), null);
});

test('a reload starts empty and nothing is persisted', () => {
  const t = createRunning();
  t.apply(t.begin(), 'themis', 'themis');
  t.apply(t.begin(), null, 'janus');
  assert.deepEqual(t.list(), ['themis']);
  assert.deepEqual(createRunning().list(), []);
});

test('the shipped scripts use no storage, notification, sound or service worker', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const dir = path.join(__dirname, '..', 'public', 'js');
  for (const f of ['app.js', 'hubstate.js', 'streamstate.js', 'apollostate.js']) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8').replace(/\/\/.*$/gm, '');
    assert.equal(
      /Notification|localStorage|sessionStorage|indexedDB|\bcaches\b|serviceWorker|navigator\.vibrate|new Audio\(|\bAudio\(/.test(
        text,
      ),
      false,
      f,
    );
  }
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.equal(/rel="manifest"|serviceWorker/.test(html), false);
  assert.equal(fs.existsSync(path.join(__dirname, '..', 'public', 'manifest.webmanifest')), false);
  // the marker never touches the tab title or the icon
  const app = fs.readFileSync(path.join(dir, 'app.js'), 'utf8');
  const marks = app.slice(app.indexOf('function renderRail'), app.indexOf('function announceNew'));
  assert.equal(/document\.title|rel="icon"|favicon/.test(marks), false);
});
