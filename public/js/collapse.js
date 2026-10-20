// Collapsible sections. Each section has a <button class="sec-toggle" data-section="<id>"> inside its
// <h2> with aria-controls pointing at the body. The body is hidden with the `hidden` attribute (never
// removed, so the views keep updating it). The state persists per section in localStorage; every
// storage access is in try/catch and a failure just means the default is used.

export const KEY_PREFIX = 'agent-dashboard.section.';

// Only the exact strings "open" and "closed" are trusted; anything else falls back to the default.
export function parseStored(raw, fallbackOpen) {
  if (raw === 'open') return true;
  if (raw === 'closed') return false;
  return fallbackOpen;
}

export function readOpen(getStorage, id, fallbackOpen) {
  try {
    return parseStored(getStorage().getItem(KEY_PREFIX + id), fallbackOpen);
  } catch {
    return fallbackOpen;
  }
}

export function writeOpen(getStorage, id, open) {
  try {
    getStorage().setItem(KEY_PREFIX + id, open ? 'open' : 'closed');
  } catch {
    // not persisted; the section still toggles
  }
}

export function mountCollapse(root = document, getStorage = () => window.localStorage) {
  const cleanups = [];
  for (const btn of root.querySelectorAll('button.sec-toggle[data-section]')) {
    const id = btn.dataset.section;
    const body = root.getElementById(btn.getAttribute('aria-controls'));
    if (!body) continue;
    const apply = (open) => {
      btn.setAttribute('aria-expanded', String(open));
      body.hidden = !open;
    };
    apply(readOpen(getStorage, id, btn.dataset.default !== 'closed'));
    const onClick = () => {
      const open = btn.getAttribute('aria-expanded') !== 'true';
      apply(open);
      writeOpen(getStorage, id, open);
    };
    btn.addEventListener('click', onClick);
    cleanups.push(() => btn.removeEventListener('click', onClick));
  }
  return () => cleanups.forEach((f) => f());
}
