// Tiny control script for the mock stage: state toggle, auto loop, theme switch.
// Classic script so it works when a page is opened straight from the file system.
(function () {
  var root = document.documentElement;
  var bodies = document.querySelectorAll('[data-live]');
  var labels = document.querySelectorAll('[data-live-label]');
  var msgs = document.querySelectorAll('[data-live-msg]');
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
  var mode = 'auto';
  var state = 'idle';
  var timer = null;

  function setState(next) {
    state = next;
    bodies.forEach(function (el) {
      el.setAttribute('data-state', next);
    });
    labels.forEach(function (el) {
      el.setAttribute('data-now', next);
      el.textContent = next === 'active' ? 'Speaking' : 'Idle';
    });
    msgs.forEach(function (el) {
      el.setAttribute('data-now', next);
    });
  }

  function apply() {
    window.clearInterval(timer);
    if (mode === 'auto') {
      setState('idle');
      if (!reduce.matches) {
        timer = window.setInterval(function () {
          setState(state === 'idle' ? 'active' : 'idle');
        }, 5000);
      }
    } else {
      setState(mode);
    }
  }

  function press(group, button) {
    group.querySelectorAll('button').forEach(function (b) {
      b.setAttribute('aria-pressed', b === button ? 'true' : 'false');
    });
  }

  document.querySelectorAll('[data-mode]').forEach(function (button) {
    button.addEventListener('click', function () {
      mode = button.getAttribute('data-mode');
      press(button.parentNode, button);
      apply();
    });
  });

  document.querySelectorAll('[data-theme-set]').forEach(function (button) {
    button.addEventListener('click', function () {
      var value = button.getAttribute('data-theme-set');
      if (value === 'auto') {
        root.removeAttribute('data-theme');
      } else {
        root.setAttribute('data-theme', value);
      }
      press(button.parentNode, button);
    });
  });

  reduce.addEventListener('change', apply);
  apply();
})();
