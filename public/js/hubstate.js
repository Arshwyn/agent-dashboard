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

  // Which agent holds the one running reply, and which agents finished a reply while the owner was looking at
  // another one ("new reply"). Pure logic with an epoch so a status poll that started before a local send cannot
  // undo that send: every local change bumps the epoch, and a poll result applies only if its epoch is current.
  // A new reply is set when the agent that was running is no longer running and is not the selected agent. There
  // is no marker for the first observation, for the selected agent, or for an agent that is not in the table.
  // Nothing is stored; a page reload starts empty.
  function createRunning() {
    var epoch = 0;
    var running = null;
    var marked = {};
    return {
      begin: function () {
        return epoch;
      },
      running: function () {
        return running;
      },
      // this page started a reply for `id` (or ended it, id null)
      local: function (id) {
        epoch++;
        running = id || null;
      },
      // a status result; pass the epoch from begin() for a poll, nothing for a read that must always apply
      apply: function (startEpoch, id, selected) {
        if (startEpoch !== undefined && startEpoch !== epoch) return { applied: false, marked: [] };
        var next = id || null;
        var added = [];
        if (running && running !== next && running !== selected && !marked[running]) {
          marked[running] = true;
          added.push(running);
        }
        running = next;
        return { applied: true, marked: added };
      },
      // the owner opened this agent: its marker is cleared
      select: function (id) {
        var had = !!marked[id];
        delete marked[id];
        return had;
      },
      has: function (id) {
        return !!marked[id];
      },
      list: function () {
        return Object.keys(marked);
      },
    };
  }

  var api = {
    createRunning: createRunning,
    STATES: STATES,
    showing: showing,
    newReply: newReply,
    noMessages: noMessages,
  };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HubState = api;
})(typeof window !== 'undefined' ? window : globalThis);
