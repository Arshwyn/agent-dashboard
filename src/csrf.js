'use strict';

// CSRF defence for state-changing requests (anything but GET and HEAD).
//
// The app sits behind Cloudflare Access, whose cookie the browser attaches to any request to the hostname, so a
// page on another site could otherwise make the owner's browser send a POST. Two independent checks must pass:
//   1. a custom request header (X-Hub-Request: 1). A cross-site page cannot set it without a CORS preflight, and
//      the app sends no CORS headers, so the preflight fails;
//   2. the browser's own provenance: Sec-Fetch-Site must be same-origin when present, and Origin (when present)
//      must name this host. A request with neither Sec-Fetch-Site nor Origin is refused (every browser sends one).
// State-changing bodies must also be application/json, which is not a "simple" cross-site content type.
function csrfOk(req) {
  if (req.headers['x-hub-request'] !== '1') return false;
  const site = req.headers['sec-fetch-site'];
  const origin = req.headers.origin;
  if (site === undefined && origin === undefined) return false;
  if (site !== undefined && site !== 'same-origin') return false;
  if (origin !== undefined) {
    let host;
    try {
      host = new URL(origin).host;
    } catch {
      return false;
    }
    if (host !== req.headers.host) return false;
  }
  return true;
}

function jsonContentType(req) {
  return /^application\/json\s*(;|$)/i.test(String(req.headers['content-type'] || ''));
}

module.exports = { csrfOk, jsonContentType };
