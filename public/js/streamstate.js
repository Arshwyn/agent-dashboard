'use strict';
// The page's reply-stream logic without the DOM: it turns each server event into a small list of instructions for
// the page, and remembers whether the history must be left alone afterwards. Also loaded by the tests (Node).
(function (root) {
  // Plain-text messages for a failed or refused run, by the error code the server sends.
  var ERROR_TEXT = {
    failed: 'The run failed. Try again.',
    timeout: 'The run took too long and was stopped.',
    too_large: 'The reply was too large and was stopped.',
    disabled: 'Web chat is switched off.',
    switched_off: 'Web chat was switched off during this reply, so it was stopped.',
    busy: 'Another reply is still running. Wait for it to finish or press Stop.',
    not_enabled: 'Chat is not enabled for this agent yet.',
    unavailable: 'The chat service is not reachable.',
    interrupted: 'The app restarted before this reply finished.',
    // the row of a reply that finished but could not be written normally: its text is kept, the run did not fail
    unsaved: 'This reply could not be saved to the history.',
  };
  // A send the gateway refused before anything started: the code names why, in words for the sender.
  var REFUSED_TEXT = {
    busy: ERROR_TEXT.busy,
    disabled: ERROR_TEXT.disabled,
    not_enabled: ERROR_TEXT.not_enabled,
    too_large: 'That message is too long.',
    unavailable: 'The chat service is not reachable. Try again in a moment.',
  };

  function errorText(code) {
    return Object.prototype.hasOwnProperty.call(ERROR_TEXT, code) ? ERROR_TEXT[code] : ERROR_TEXT.failed;
  }

  /**
   * The notice for a send the server answered with a non-200 status. `body` is the parsed JSON body or null
   * (a proxy in front may answer with HTML). Always returns a plain sentence, never an empty string.
   */
  function refusalNotice(status, body, retryAfter) {
    var code = body && typeof body.error === 'string' ? body.error : '';
    if (status === 409 && code === 'not_enabled') return ERROR_TEXT.not_enabled;
    if (status === 409) return ERROR_TEXT.busy;
    if (status === 429) {
      var n = parseInt(retryAfter, 10);
      return 'Too many messages. Wait ' + (n > 0 ? n + ' seconds' : 'a few seconds') + ' and try again.';
    }
    if (status === 503) {
      return code === 'disabled'
        ? ERROR_TEXT.disabled
        : 'The chat service is not reachable. Try again in a moment.';
    }
    if (status === 413) return 'That message is too long.';
    if (status === 401) return 'Your sign-in has expired. Reload the page to sign in again.';
    if (status === 403) return 'The request was refused. Reload the page and try again.';
    if (status === 404) return 'This conversation no longer exists. Reload the page.';
    if (status >= 500) return 'The chat service had an error. Try again.';
    return 'The message was not accepted.';
  }

  // Stop only exists for the open conversation, so when the running reply is in another chat the notice says so.
  var BUSY_ELSEWHERE =
    'Another reply is still running in another chat (marked "running" in the list). Wait for it to finish, or open that chat and press Stop.';
  function noticeForView(text, openRunning) {
    return text === ERROR_TEXT.busy && !openRunning ? BUSY_ELSEWHERE : text;
  }

  /**
   * One refresh chain at a time: `begin()` returns a ticket and invalidates every earlier one, `cancel()` invalidates
   * them all (a conversation switch). A timer-driven refresh asks `valid(ticket)` before it touches the page.
   */
  function createChain() {
    var current = 0;
    return {
      begin: function () {
        return ++current;
      },
      cancel: function () {
        current++;
      },
      valid: function (ticket) {
        return ticket === current;
      },
    };
  }

  function isObject(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
  }

  /**
   * Validates the two responses of a Stop refresh (the list, then the conversation named by `id`). Each is
   * {ok, body}. Returns {conversations, conversation, messages} or null when either is not ok or lacks the expected
   * shape (for example a JSON error body because the conversation was deleted in another tab, or another
   * conversation's data), so the caller keeps the current view.
   */
  function refreshData(list, conv, id) {
    if (!list || !conv || !list.ok || !conv.ok) return null;
    var l = list.body;
    var c = conv.body;
    if (!isObject(l) || !isObject(c) || !Array.isArray(l.conversations)) return null;
    if (
      !l.conversations.every(function (x) {
        return isObject(x) && typeof x.id === 'string';
      })
    )
      return null;
    if (!isObject(c.conversation) || c.conversation.id !== id || !Array.isArray(c.messages)) return null;
    return { conversations: l.conversations, conversation: c.conversation, messages: c.messages };
  }

  /** What to draw for a stored message row; a reply that is still running says so instead of a bare "...". */
  function rowText(m) {
    if (m.text) return m.text;
    return m.status === 'streaming' ? 'Reply in progress...' : '';
  }

  function create() {
    var s = { text: '', spoke: false, keepLog: false };
    return {
      /** True when the log must NOT be re-rendered from the stored history (an unsaved reply lives only on screen). */
      keepLog: function () {
        return s.keepLog;
      },
      /** Returns the instructions for one event: stage, liveText, interim, tool, notes, errorCode, announce. */
      apply: function (ev, data) {
        var out = { notes: [] };
        if (ev === 'thinking') out.stage = 'thinking';
        else if (ev === 'delta') {
          if (!s.spoke) {
            s.spoke = true;
            out.stage = 'speaking';
            out.tool = '';
          }
          s.text += data.text;
          out.liveText = s.text;
        } else if (ev === 'interim') {
          // narration before a tool call: a muted note, then the live text starts again
          out.interim = String(data.text).trim();
          s.text = '';
          s.spoke = false;
          out.liveText = '';
          out.stage = 'thinking';
        } else if (ev === 'tool') {
          out.tool = data.label + '...';
          out.stage = 'thinking';
        } else if (ev === 'done') {
          out.liveText = data.text || s.text;
          if (data.cancelled) out.notes.push('Stopped.');
          if (data.unsaved) {
            out.notes.push(ERROR_TEXT.unsaved);
            s.keepLog = true;
          }
          out.removeTool = true;
          out.announce = data.cancelled ? 'stopped' : 'complete';
          out.stage = 'idle';
        } else if (ev === 'error') {
          out.removeTool = true;
          out.errorCode = data.code;
          out.stage = 'error';
          if (data.unsaved) {
            out.notes.push(ERROR_TEXT.unsaved);
            s.keepLog = true;
          }
          if (data.refused) {
            // nothing started and nothing was stored: the page drops the empty bubble and shows this as a notice
            out.refused = true;
            out.notice = Object.prototype.hasOwnProperty.call(REFUSED_TEXT, data.code)
              ? REFUSED_TEXT[data.code]
              : ERROR_TEXT.unavailable;
            out.stage = 'idle';
          }
        }
        return out;
      },
    };
  }
  var api = {
    create: create,
    errorText: errorText,
    refusalNotice: refusalNotice,
    rowText: rowText,
    noticeForView: noticeForView,
    createChain: createChain,
    refreshData: refreshData,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.HubStreamState = api;
})(typeof window !== 'undefined' ? window : this);
