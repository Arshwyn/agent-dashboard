'use strict';
// Page-level words and logic without the DOM, so the tests can load it in Node. Everything here is in memory only:
// nothing is stored, nothing is sent anywhere.
(function (root) {
  // The words for each page-level state. `next` names the control or action that follows, or '' when the state
  // clears by itself.
  var STATES = {
    rosterFailed: { text: 'Could not load the agent list.', next: 'Retry' },
    offline: { text: 'You are offline. Messages cannot be sent.', next: '' },
    online: { text: 'Back online.', next: '' },
    expired: { text: 'Your sign-in expired. Reload the page to sign in again.', next: 'Reload' },
    noConversations: { text: 'No conversations yet. Send a message to start one.', next: '' },
  };

  function showing(name) {
    return 'Showing ' + name + '.';
  }
  function newReply(name) {
    return 'New reply from ' + name + '.';
  }
  function noMessages(name) {
    return (
      'No messages yet. Say something to ' +
      name +
      '. A reply keeps running if you close the page and is saved; use Stop to end it.'
    );
  }

  var api = { STATES: STATES, showing: showing, newReply: newReply, noMessages: noMessages };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HubState = api;
})(typeof window !== 'undefined' ? window : globalThis);
