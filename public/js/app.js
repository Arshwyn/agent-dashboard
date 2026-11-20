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

  function drawChat(a) {
    chat.textContent = '';
    var head = el('div', { class: 'chat-head' });
    head.appendChild(el('strong', {}, a.name));
    head.appendChild(el('span', { class: 'status', 'data-status': '', 'data-now': 'idle' }, 'Idle'));
    chat.appendChild(head);
    var body = el('div', { class: 'transcript' });
    if (a.chat === 'link') {
      body.appendChild(el('p', {}, a.name + ' chats in a separate app with its own sign-in.'));
      if (a.link) {
        var open = el(
          'a',
          { class: 'link-button', href: a.link, rel: 'noopener noreferrer' },
          'Open ' + a.name + ' chat',
        );
        body.appendChild(open);
      } else {
        body.appendChild(el('span', { class: 'notice' }, 'The chat link is not configured.'));
      }
      chat.appendChild(body);
      return;
    }
    body.appendChild(el('span', { class: 'notice' }, 'Chat is not connected yet'));
    body.appendChild(
      el('p', {}, 'Messages to ' + a.name + ' will appear here once the chat backend is switched on.'),
    );
    chat.appendChild(body);
    var composer = el('div', { class: 'composer' });
    var input = el('input', {
      type: 'text',
      'aria-label': 'Message',
      placeholder: 'Chat is not connected yet',
      disabled: '',
    });
    var send = el('button', { type: 'button', disabled: '' }, 'Send');
    composer.appendChild(input);
    composer.appendChild(send);
    chat.appendChild(composer);
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
