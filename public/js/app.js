// Agent hub shell: loads the roster, draws the side rail and the chat panel, routes between agents and
// starts the viewer (js/hub.js). The chat talks to the hub API for the eight hub agents; Apollo is a link-out.
(function () {
  'use strict';

  var root = document.documentElement;
  var rail = document.getElementById('rail');
  var stage = document.getElementById('stage3d');
  var chat = document.getElementById('chat');
  var roster = [];

  function el(tag, attrs, text) {
    var n = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      n.setAttribute(k, attrs[k]);
    });
    if (text !== undefined) n.textContent = text;
    return n;
  }

  function idFromPath() {
    var m = /^\/agent\/([a-z]+)\/?$/.exec(window.location.pathname);
    return m ? m[1] : null;
  }

  function byId(id) {
    return roster.filter(function (a) {
      return a.id === id;
    })[0];
  }

  function drawRail() {
    rail.textContent = '';
    roster.forEach(function (a) {
      var link = el('a', { href: '/agent/' + a.id, 'data-agent': a.id });
      var dot = el('span', { class: 'dot', 'aria-hidden': 'true' });
      dot.style.setProperty('--a', a.palette[0]);
      dot.style.setProperty('--b', a.palette[1]);
      dot.style.setProperty('--c', a.palette[2]);
      link.appendChild(dot);
      link.appendChild(el('span', {}, a.name));
      link.addEventListener('click', function (ev) {
        if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.button !== 0) return;
        ev.preventDefault();
        go(a.id, true);
      });
      rail.appendChild(link);
    });
  }

  // The one running reply (only one run exists at a time) is marked on its rail entry with text and a shape, so
  // colour is not the only signal. The page asks the server every few seconds while it is visible.
  function setRunning(id) {
    rail.querySelectorAll('a').forEach(function (l) {
      var on = !!id && l.getAttribute('data-agent') === id;
      var mark = l.querySelector('.run-mark');
      if (on && !mark) l.appendChild(el('span', { class: 'run-mark' }, 'running'));
      if (!on && mark) mark.remove();
      if (on) l.setAttribute('data-running', '');
      else l.removeAttribute('data-running');
    });
  }

  function pollRunning() {
    if (document.hidden) return;
    api('GET', '/api/chat/status')
      .then(function (r) {
        return r.ok ? r.json() : null;
      })
      .then(function (st) {
        if (st) setRunning(st.running_agent || null);
      })
      .catch(function () {});
  }

  // ---------- chat panel ----------
  var MAX_CHARS = 8000;
  var chat_ = {
    agent: null,
    conv: null,
    convs: [],
    busy: false,
    token: 0,
    keepLog: false,
    pendingNotice: '',
  };

  function api(method, path, body) {
    var opts = { method: method, headers: { Accept: 'application/json', 'X-Hub-Request': '1' } };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    return fetch(path, opts);
  }

  function setStageState(st) {
    stage.setAttribute('data-state', st);
  }

  var errorText = window.HubStreamState.errorText;

  function drawChat(a) {
    chat.textContent = '';
    chat_.token++;
    chat_.agent = a;
    chat_.conv = null;
    chat_.convs = [];
    chat_.busy = false;
    setStageState('idle');
    if (a.chat === 'link') return drawLink(a);
    var head = el('div', { class: 'chat-head' });
    head.appendChild(el('strong', {}, a.name));
    head.appendChild(el('span', { class: 'status', 'data-status': '', 'data-now': 'idle' }, 'Idle'));
    chat.appendChild(head);
    drawAccess(a);
    var body = el('div', { class: 'transcript' }, 'Checking the chat service...');
    chat.appendChild(body);
    var token = chat_.token;
    api('GET', '/api/chat/status')
      .then(function (r) {
        if (!r.ok) throw new Error('status');
        return r.json();
      })
      .then(function (st) {
        if (token !== chat_.token) return;
        drawReal(a, st);
      })
      .catch(function () {
        if (token !== chat_.token) return;
        drawBlocked(a, 'The chat service is not reachable.', true);
      });
  }

  // One line from the roster saying what this agent can do, so the owner sees its reach before sending.
  function drawAccess(a) {
    if (a.access) chat.appendChild(el('p', { class: 'access-note' }, 'Access: ' + a.access));
  }

  function drawLink(a) {
    var head = el('div', { class: 'chat-head' });
    head.appendChild(el('strong', {}, a.name));
    head.appendChild(el('span', { class: 'status', 'data-status': '', 'data-now': 'idle' }, 'Idle'));
    chat.appendChild(head);
    var body = el('div', { class: 'transcript' });
    body.appendChild(el('p', {}, a.name + ' chats in a separate app with its own sign-in.'));
    if (a.link) {
      body.appendChild(
        el(
          'a',
          { class: 'link-button', href: a.link, rel: 'noopener noreferrer' },
          'Open ' + a.name + ' chat',
        ),
      );
    } else {
      body.appendChild(el('span', { class: 'notice' }, 'The chat link is not configured.'));
    }
    chat.appendChild(body);
  }

  function drawBlocked(a, message, retry) {
    chat.textContent = '';
    var head = el('div', { class: 'chat-head' });
    head.appendChild(el('strong', {}, a.name));
    head.appendChild(el('span', { class: 'status', 'data-status': '', 'data-now': 'idle' }, 'Idle'));
    chat.appendChild(head);
    drawAccess(a);
    var body = el('div', { class: 'transcript' });
    body.appendChild(el('span', { class: 'notice', role: 'status' }, message));
    if (retry) {
      var b = el('button', { type: 'button', class: 'link-button' }, 'Try again');
      b.addEventListener('click', function () {
        drawChat(a);
      });
      body.appendChild(b);
    }
    chat.appendChild(body);
    var composer = el('div', { class: 'composer' });
    composer.appendChild(
      el('input', { type: 'text', 'aria-label': 'Message', placeholder: message, disabled: '' }),
    );
    composer.appendChild(el('button', { type: 'button', disabled: '' }, 'Send'));
    chat.appendChild(composer);
  }

  function drawReal(a, st) {
    if (st.agents.indexOf(a.id) < 0 && st.available) {
      return drawBlocked(a, 'Chat for ' + a.name + ' is not enabled yet.', false);
    }
    if (!st.available) return drawBlocked(a, 'The chat service is offline.', true);
    chat.textContent = '';
    var token = chat_.token;
    setRunning(st.running_agent || null);

    var head = el('div', { class: 'chat-head' });
    var select = el('select', { 'aria-label': 'Conversation' });
    var bNew = el('button', { type: 'button', class: 'mini' }, 'New');
    var bRen = el('button', { type: 'button', class: 'mini' }, 'Rename');
    var bDel = el('button', { type: 'button', class: 'mini' }, 'Delete');
    var status = el('span', { class: 'status', 'data-status': '', 'data-now': 'idle' }, 'Idle');
    [select, bNew, bRen, bDel, status].forEach(function (n) {
      head.appendChild(n);
    });
    chat.appendChild(head);
    drawAccess(a);

    var notice = el('div', { class: 'notice-bar', role: 'status', 'aria-live': 'polite' });
    chat.appendChild(notice);
    var log = el('div', {
      class: 'messages',
      role: 'log',
      // streamed text is not announced word by word; the announcer below says when a reply is complete
      'aria-live': 'off',
      'aria-label': 'Messages',
    });
    chat.appendChild(log);
    var announcer = el('div', { class: 'sr-only', role: 'status', 'aria-live': 'polite' });
    chat.appendChild(announcer);
    function announce(text) {
      announcer.textContent = '';
      window.setTimeout(function () {
        announcer.textContent = text;
      }, 50);
    }
    var composer = el('div', { class: 'composer' });
    var input = el('textarea', {
      'aria-label': 'Message',
      rows: '1',
      maxlength: String(MAX_CHARS),
      placeholder: 'Message ' + a.name,
    });
    var bSend = el('button', { type: 'button' }, 'Send');
    var bStop = el(
      'button',
      { type: 'button', class: 'stop', hidden: '', title: 'End this reply now' },
      'Stop',
    );
    [input, bSend, bStop].forEach(function (n) {
      composer.appendChild(n);
    });
    chat.appendChild(composer);

    var stopChain = window.HubStreamState.createChain();
    var stopTimer = null;

    function say(text) {
      notice.textContent = text || '';
    }
    if (!st.enabled)
      say('Web chat is switched off (' + (st.disabled_by === 'app' ? 'by the app' : 'on the host') + ').');
    else if (st.busy) {
      var other = st.running_agent && st.running_agent !== a.id ? byId(st.running_agent) : null;
      say(
        other
          ? other.name +
              ' is replying. Only one reply runs at a time: wait for it, or open ' +
              other.name +
              ' and press Stop.'
          : 'The agent is busy with another run.',
      );
    }

    function lock(on) {
      chat_.busy = on;
      log.setAttribute('aria-busy', on ? 'true' : 'false');
      bSend.disabled = on || !st.enabled;
      input.disabled = !st.enabled;
      // Stop is also offered when this conversation has a reply running that this page did not start (another tab)
      bStop.hidden = !(on || (chat_.conv && chat_.conv.running));
      select.disabled = on;
      bNew.disabled = on;
      bRen.disabled = on || !chat_.conv;
      bDel.disabled = on || !chat_.conv;
    }

    function addMsg(role, text, cls) {
      var m = el('div', { class: 'msg ' + role + (cls ? ' ' + cls : '') });
      m.textContent = text; // text only: never HTML
      log.appendChild(m);
      log.scrollTop = log.scrollHeight;
      return m;
    }

    function drawMessages(msgs) {
      log.textContent = '';
      if (!msgs.length) {
        log.appendChild(
          el(
            'p',
            { class: 'empty' },
            'No messages yet. Say something to ' +
              a.name +
              '. A reply keeps running if you close the page and is saved; use Stop to end it.',
          ),
        );
      }
      msgs.forEach(function (m) {
        var shown = window.HubStreamState.rowText(m);
        var cls =
          m.status === 'error'
            ? 'is-error'
            : m.status === 'cancelled'
              ? 'is-cancelled'
              : m.status === 'streaming' && !m.text
                ? 'is-pending'
                : '';
        var node = addMsg(m.role, shown, cls);
        if (m.status === 'error') node.appendChild(el('small', { class: 'err' }, errorText(m.error_code)));
        if (m.status === 'cancelled') node.appendChild(el('small', { class: 'err' }, 'Stopped.'));
      });
      log.scrollTop = log.scrollHeight;
    }

    function fillSelect() {
      select.textContent = '';
      if (!chat_.convs.length) select.appendChild(el('option', { value: '' }, 'No conversations'));
      chat_.convs.forEach(function (c) {
        var o = el('option', { value: c.id }, c.running ? c.title + ' (running)' : c.title);
        if (chat_.conv && chat_.conv.id === c.id) o.selected = true;
        select.appendChild(o);
      });
    }

    function loadList(selectId, keepLog) {
      return api('GET', '/api/chats?agent=' + encodeURIComponent(a.id))
        .then(function (r) {
          return r.json();
        })
        .then(function (d) {
          if (token !== chat_.token) return;
          chat_.convs = d.conversations;
          var pick =
            chat_.convs.filter(function (c) {
              return c.id === (selectId || (chat_.conv && chat_.conv.id));
            })[0] ||
            chat_.convs[0] ||
            null;
          chat_.conv = pick;
          fillSelect();
          lock(false);
          if (keepLog) return;
          return pick ? openConv(pick.id) : drawMessages([]);
        });
    }

    function openConv(id) {
      return api('GET', '/api/chats/' + id)
        .then(function (r) {
          return r.json();
        })
        .then(function (d) {
          if (token !== chat_.token) return;
          chat_.conv = d.conversation;
          drawMessages(d.messages);
          lock(false);
        });
    }

    // a notice about the previous conversation (a refused send) must not linger, on screen or in the live region
    function clearNotices() {
      stopChain.cancel();
      window.clearTimeout(stopTimer);
      say('');
      announcer.textContent = '';
    }

    select.addEventListener('change', function () {
      clearNotices();
      if (select.value) openConv(select.value);
    });
    bNew.addEventListener('click', function () {
      clearNotices();
      api('POST', '/api/chats', { agent: a.id })
        .then(function (r) {
          return r.json();
        })
        .then(function (d) {
          if (d.conversation) return loadList(d.conversation.id);
        });
    });
    bRen.addEventListener('click', function () {
      if (!chat_.conv) return;
      var t = window.prompt('Rename this chat', chat_.conv.title);
      if (!t || !t.trim()) return;
      api('PATCH', '/api/chats/' + chat_.conv.id, { title: t }).then(function () {
        return loadList(chat_.conv.id);
      });
    });
    bDel.addEventListener('click', function () {
      if (!chat_.conv || !window.confirm('Delete this conversation and its messages?')) return;
      api('DELETE', '/api/chats/' + chat_.conv.id).then(function (r) {
        if (r.status === 409) return say('A run is in progress in this chat.');
        chat_.conv = null;
        return loadList();
      });
    });

    // A refused send is shown as a plain notice at the end of the log (and read out), never as a reply bubble.
    function showNotice(text) {
      var old = log.querySelector('.msg-notice');
      if (old) old.remove();
      log.appendChild(el('div', { class: 'msg-notice', role: 'status' }, text));
      log.scrollTop = log.scrollHeight;
      announce(text);
    }

    function readStream(r, live, tool, sent) {
      var reader = r.body.getReader();
      var dec = new TextDecoder();
      var buf = '';
      var ss = window.HubStreamState.create();
      chat_.keepLog = false;
      chat_.pendingNotice = '';
      function handle(ev, data) {
        var o = ss.apply(ev, data);
        chat_.keepLog = ss.keepLog();
        if (o.interim) live.insertAdjacentElement('beforebegin', addMsg('assistant', o.interim, 'note'));
        if (o.tool !== undefined) tool.textContent = o.tool;
        if (o.liveText !== undefined) live.textContent = o.liveText;
        o.notes.forEach(function (n) {
          live.appendChild(el('small', { class: 'err' }, n));
        });
        if (o.removeTool) tool.remove();
        if (o.refused) {
          // nothing started and nothing was stored: take the whole send back and keep the text for another try
          live.remove();
          sent.bubble.remove();
          if (!input.value) input.value = sent.text;
          chat_.pendingNotice = o.notice;
        } else if (o.errorCode) {
          var msg = errorText(o.errorCode);
          live.appendChild(el('small', { class: 'err' }, msg));
          live.classList.add('is-error');
          announce(msg);
        }
        if (o.announce)
          announce(o.announce === 'stopped' ? 'Stopped.' : 'Reply from ' + a.name + ' complete.');
        log.scrollTop = log.scrollHeight;
        if (o.stage) setStageState(o.stage);
      }
      function pump() {
        return reader.read().then(function (chunk) {
          if (chunk.done) return;
          buf += dec.decode(chunk.value, { stream: true });
          var idx;
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            var block = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            var m = /^event: (.+)\ndata: (.+)$/s.exec(block);
            if (m) {
              try {
                handle(m[1], JSON.parse(m[2]));
              } catch {
                // ignore a malformed block
              }
            }
          }
          return pump();
        });
      }
      return pump();
    }

    function send() {
      var text = input.value;
      if (!text.trim() || chat_.busy) return;
      if (text.length > MAX_CHARS) return say('That message is too long.');
      say('');
      setRunning(a.id);
      var oldNotice = log.querySelector('.msg-notice');
      if (oldNotice) oldNotice.remove();
      lock(true);
      input.readOnly = true; // the text stays in the box until the server has accepted the send
      var ensure = chat_.conv
        ? Promise.resolve(chat_.conv)
        : api('POST', '/api/chats', { agent: a.id })
            .then(function (r) {
              return r.json();
            })
            .then(function (d) {
              chat_.conv = d.conversation;
              chat_.convs.unshift(d.conversation);
              fillSelect();
              return d.conversation;
            });
      ensure
        .then(function (c) {
          return api('POST', '/api/chats/' + c.id + '/messages', { text: text }).then(function (r) {
            input.readOnly = false;
            if (r.status !== 200) {
              // refused before anything was stored or started: a notice, no bubbles, the text stays in the box
              return r
                .json()
                .catch(function () {
                  return null;
                })
                .then(function (body) {
                  setStageState('idle');
                  chat_.pendingNotice = window.HubStreamState.refusalNotice(
                    r.status,
                    body,
                    r.headers.get('Retry-After'),
                  );
                });
            }
            if (log.querySelector('.empty')) log.textContent = '';
            var bubble = addMsg('user', text);
            var live = addMsg('assistant', '');
            var tool = el('div', { class: 'tool' });
            log.appendChild(tool);
            input.value = '';
            setStageState('thinking');
            return readStream(r, live, tool, { text: text, bubble: bubble });
          });
        })
        .catch(function () {
          input.readOnly = false;
          setStageState('error');
          say('The connection was lost. The reply may still finish; reload to see it.');
        })
        .then(function () {
          input.readOnly = false;
          if (token !== chat_.token) return;
          // an unsaved reply (or a refused send's notice) exists only on screen: refresh the list, keep the log
          var keep = chat_.keepLog;
          var pending = chat_.pendingNotice;
          chat_.keepLog = false;
          chat_.pendingNotice = '';
          // the history is reloaded so it shows what is really stored (for instance the other reply that is running),
          // and the notice is put back at the end of it
          return loadList(chat_.conv && chat_.conv.id, keep).then(function () {
            if (pending && token === chat_.token)
              showNotice(window.HubStreamState.noticeForView(pending, !!(chat_.conv && chat_.conv.running)));
          });
        });
    }

    bSend.addEventListener('click', send);
    bStop.addEventListener('click', function () {
      if (!chat_.conv) return;
      var id = chat_.conv.id;
      var ticket = stopChain.begin(); // a second click replaces the first chain
      window.clearTimeout(stopTimer);
      var tries = 0;
      // A run started in another tab ends without this page hearing about it: re-read the conversation and the
      // list until it no longer says running, so the view does not stay on "Reply in progress..." with Stop shown.
      function refresh() {
        if (!stopChain.valid(ticket) || token !== chat_.token || chat_.busy) return;
        function read(r) {
          return r
            .json()
            .catch(function () {
              return null;
            })
            .then(function (body) {
              return { ok: r.ok, body: body };
            });
        }
        return Promise.all([
          api('GET', '/api/chats?agent=' + encodeURIComponent(a.id)).then(read),
          api('GET', '/api/chats/' + id).then(read),
        ])
          .then(function (both) {
            // checked again after the responses: a send or a switch since then must not be wiped
            if (!stopChain.valid(ticket) || token !== chat_.token || chat_.busy) return;
            var data = window.HubStreamState.refreshData(both[0], both[1], id);
            if (!data) {
              // an error body or a bad shape (for example the chat was deleted in another tab, or a transient
              // server error): keep the view, drop a stale notice and try again within the same budget
              say('');
              var stale = log.querySelector('.msg-notice');
              if (stale) stale.remove();
              if (++tries < 8) stopTimer = window.setTimeout(refresh, 1000);
              return;
            }
            chat_.convs = data.conversations;
            chat_.conv = data.conversation;
            fillSelect();
            drawMessages(data.messages);
            lock(false);
            if (chat_.conv.running && ++tries < 8) stopTimer = window.setTimeout(refresh, 1000);
          })
          .catch(function () {
            // a network failure is retried like an error response
            if (stopChain.valid(ticket) && token === chat_.token && ++tries < 8)
              stopTimer = window.setTimeout(refresh, 1000);
          });
      }
      api('POST', '/api/chats/' + id + '/stop')
        .then(refresh)
        .catch(function () {})
        .then(pollRunning);
    });
    input.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) {
        ev.preventDefault();
        send();
      }
    });
    lock(false);
    loadList();
  }

  function show(id) {
    var a = byId(id) || roster[0];
    if (!a) return;
    rail.querySelectorAll('a').forEach(function (l) {
      if (l.getAttribute('data-agent') === a.id) l.setAttribute('aria-current', 'page');
      else l.removeAttribute('aria-current');
    });
    document.title = a.name + ' - Agent hub';
    document.querySelectorAll('[data-agent-name]').forEach(function (n) {
      n.textContent = a.name;
    });
    document.querySelectorAll('[data-agent-role]').forEach(function (n) {
      n.textContent = a.role;
    });
    stage.setAttribute('aria-label', a.name + ' body');
    drawChat(a);
    if (window.HubViewer) window.HubViewer.select(a.id);
  }

  function go(id, push) {
    if (push) window.history.pushState({}, '', '/agent/' + id);
    show(id);
  }

  document.querySelectorAll('[data-theme-set]').forEach(function (b) {
    b.addEventListener('click', function () {
      var v = b.getAttribute('data-theme-set');
      if (v === 'auto') root.removeAttribute('data-theme');
      else root.setAttribute('data-theme', v);
      b.parentNode.querySelectorAll('button').forEach(function (x) {
        x.setAttribute('aria-pressed', x === b ? 'true' : 'false');
      });
    });
  });

  window.setInterval(pollRunning, 5000);

  window.addEventListener('popstate', function () {
    show(idFromPath());
  });

  function startViewer() {
    var s = document.createElement('script');
    s.src = '/js/hub.js';
    s.onload = function () {
      show(idFromPath());
    };
    document.body.appendChild(s);
  }

  fetch('/api/roster', { headers: { Accept: 'application/json' } })
    .then(function (r) {
      if (!r.ok) throw new Error('roster');
      return r.json();
    })
    .then(function (data) {
      roster = data.agents;
      window.HUB_ROSTER = roster;
      drawRail();
      startViewer();
    })
    .catch(function () {
      chat.textContent = '';
      chat.appendChild(
        el('div', { class: 'transcript' }, 'The roster could not be loaded. Reload the page to try again.'),
      );
    });
})();
