'use strict';
// Accepts the two content-free messages the framed Apollo app may send its host page, and nothing else.
// Pure logic (no DOM) so the tests can load it in Node. A message counts only when it comes from the exact
// configured origin AND from the frame's own window, has no extra fields and carries one of the fixed shapes:
//   { type: 'apollo-ready' }                         the app loaded and the person is signed in
//   { type: 'apollo-state', state: 'idle' | 'thinking' | 'speaking' }
// The result is kept in memory by the caller; it is never sent to the server, stored or logged.
(function (root) {
  var STATES = ['idle', 'thinking', 'speaking'];

  function accept(ev, expectedOrigin, frameWindow) {
    if (!ev || typeof expectedOrigin !== 'string' || expectedOrigin === '' || expectedOrigin === '*')
      return null;
    if (!frameWindow || ev.source !== frameWindow) return null;
    if (ev.origin !== expectedOrigin) return null;
    var d = ev.data;
    if (d === null || typeof d !== 'object' || Array.isArray(d)) return null;
    var proto = Object.getPrototypeOf(d);
    if (proto !== Object.prototype && proto !== null) return null;
    var keys = Object.keys(d).sort();
    if (keys.length === 1 && keys[0] === 'type' && d.type === 'apollo-ready') return { kind: 'ready' };
    if (
      keys.length === 2 &&
      keys[0] === 'state' &&
      keys[1] === 'type' &&
      d.type === 'apollo-state' &&
      typeof d.state === 'string' &&
      STATES.indexOf(d.state) >= 0
    ) {
      return { kind: 'state', state: d.state };
    }
    return null;
  }

  var api = { accept: accept, STATES: STATES };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HubApolloState = api;
})(typeof window !== 'undefined' ? window : globalThis);
