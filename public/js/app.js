// Agent hub shell: loads the roster, draws the side rail and the chat panel, routes between agents and
// starts the viewer (js/hub.js). The chat is not connected to a backend yet and says so.
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

  // ---------- chat panel ----------
  var MAX_CHARS = 8000;
  var chat_ = { agent: null, conv: null, convs: [], busy: false, token: 0 };

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

  var ERROR_TEXT = {
    failed: 'The run failed. Try again.',
    timeout: 'The run took too long and was stopped.',
    too_large: 'The reply was too large and was stopped.',
    disabled: 'Web chat is switched off.',
    switched_off: 'Web chat was switched off during this reply, so it was stopped.',
    busy: 'Another run is in progress. Try again when it finishes.',
    not_enabled: 'Chat is not enabled for this agent yet.',
    unavailable: 'The chat service is not reachable.',
    interrupted: 'The app restarted before this reply finished.',
  };

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

    function say(text) {
      notice.textContent = text || '';
    }
    if (!st.enabled)
      say('Web chat is switched off (' + (st.disabled_by === 'app' ? 'by the app' : 'on the host') + ').');
    else if (st.busy) say('The agent is busy with another run.');

    function lock(on) {
      chat_.busy = on;
      log.setAttribute('aria-busy', on ? 'true' : 'false');
      bSend.disabled = on || !st.enabled;
      input.disabled = !st.enabled;
      bStop.hidden = !on;
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
        var cls = m.status === 'error' ? 'is-error' : m.status === 'cancelled' ? 'is-cancelled' : '';
        var node = addMsg(m.role, m.text || (m.status === 'streaming' ? '...' : ''), cls);
        if (m.status === 'error')
          node.appendChild(el('small', { class: 'err' }, ERROR_TEXT[m.error_code] || ERROR_TEXT.failed));
        if (m.status === 'cancelled') node.appendChild(el('small', { class: 'err' }, 'Stopped.'));
      });
      log.scrollTop = log.scrollHeight;
    }

    function fillSelect() {
      select.textContent = '';
      if (!chat_.convs.length) select.appendChild(el('option', { value: '' }, 'No conversations'));
      chat_.convs.forEach(function (c) {
        var o = el('option', { value: c.id }, c.title);
        if (chat_.conv && chat_.conv.id === c.id) o.selected = true;
        select.appendChild(o);
      });
    }

    function loadList(selectId) {
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

    select.addEventListener('change', function () {
      if (select.value) openConv(select.value);
    });
    bNew.addEventListener('click', function () {
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

    function readStream(r, live, tool) {
      var reader = r.body.getReader();
      var dec = new TextDecoder();
      var buf = '';
      var text = '';
      var spoke = false;
      function handle(ev, data) {
        if (ev === 'thinking') setStageState('thinking');
        else if (ev === 'delta') {
          if (!spoke) {
            spoke = true;
            setStageState('speaking');
            tool.textContent = '';
          }
          text += data.text;
          live.textContent = text;
          log.scrollTop = log.scrollHeight;
        } else if (ev === 'interim') {
          // narration before a tool call: keep it as a muted note and start the live text again
          live.insertAdjacentElement('beforebegin', addMsg('assistant', data.text.trim(), 'note'));
          text = '';
          live.textContent = '';
          spoke = false;
          setStageState('thinking');
        } else if (ev === 'tool') {
          tool.textContent = data.label + '...';
          setStageState('thinking');
        } else if (ev === 'done') {
          live.textContent = data.text || text;
          if (data.cancelled) live.appendChild(el('small', { class: 'err' }, 'Stopped.'));
          if (data.unsaved)
            live.appendChild(el('small', { class: 'err' }, 'This reply could not be saved to the history.'));
          tool.remove();
          log.scrollTop = log.scrollHeight;
          announce(data.cancelled ? 'Stopped.' : 'Reply from ' + a.name + ' complete.');
          setStageState('idle');
        } else if (ev === 'error') {
          tool.remove();
          live.appendChild(el('small', { class: 'err' }, ERROR_TEXT[data.code] || ERROR_TEXT.failed));
          live.classList.add('is-error');
          log.scrollTop = log.scrollHeight;
          announce(ERROR_TEXT[data.code] || ERROR_TEXT.failed);
          setStageState('error');
        }
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
      lock(true);
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
          if (log.querySelector('.empty')) log.textContent = '';
          addMsg('user', text);
          var live = addMsg('assistant', '');
          var tool = el('div', { class: 'tool' });
          log.appendChild(tool);
          input.value = '';
          setStageState('thinking');
          return api('POST', '/api/chats/' + c.id + '/messages', { text: text }).then(function (r) {
            if (r.status === 200) {
              return readStream(r, live, tool);
            }
            live.remove();
            tool.remove();
            setStageState('idle');
            if (r.status === 429)
              return say(
                'Too many messages. Wait ' + (r.headers.get('Retry-After') || 'a few') + ' seconds.',
              );
            if (r.status === 409) return say('The agent is busy with another run.');
            if (r.status === 503) return say('Web chat is switched off or the service is not reachable.');
            if (r.status === 413) return say('That message is too long.');
            return say('The message was not accepted.');
          });
        })
        .catch(function () {
          setStageState('error');
          say('The connection was lost. The reply may still finish; reload to see it.');
        })
        .then(function () {
          if (token !== chat_.token) return;
          return loadList(chat_.conv && chat_.conv.id);
        });
    }

    bSend.addEventListener('click', send);
    bStop.addEventListener('click', function () {
      if (chat_.conv) api('POST', '/api/chats/' + chat_.conv.id + '/stop');
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
