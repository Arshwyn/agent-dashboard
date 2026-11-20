'use strict';
// The page's reply-stream logic without the DOM: it turns each server event into a small list of instructions for
// the page, and remembers whether the history must be left alone afterwards. Also loaded by the tests (Node).
(function (root) {
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
            out.notes.push('This reply could not be saved to the history.');
            s.keepLog = true;
          }
          out.removeTool = true;
          out.announce = data.cancelled ? 'stopped' : 'complete';
          out.stage = 'idle';
        } else if (ev === 'error') {
          out.removeTool = true;
          out.errorCode = data.code;
          out.stage = 'error';
        }
        return out;
      },
    };
  }
  var api = { create: create };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.HubStreamState = api;
})(typeof window !== 'undefined' ? window : this);
