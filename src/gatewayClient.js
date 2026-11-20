'use strict';

const net = require('node:net');

class GatewayError extends Error {
  constructor(code) {
    super(`gateway: ${code}`);
    this.code = code;
  }
}

const RETRYABLE = new Set(['ENOENT', 'ECONNREFUSED']);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Talks to the host gateway over its unix socket. The path is re-resolved on every request, so a gateway
 * restart (a new socket file in the same, mounted directory) is survived by retrying the connect.
 */
function createGatewayClient({ socketPath, backoffMs = [200, 500, 1000] }) {
  async function connect() {
    for (let attempt = 0; ; attempt++) {
      try {
        return await new Promise((resolve, reject) => {
          const c = net.createConnection(socketPath);
          c.once('connect', () => resolve(c));
          c.once('error', reject);
        });
      } catch (e) {
        if (!RETRYABLE.has(e.code) || attempt >= backoffMs.length) throw new GatewayError('unavailable');
        await sleep(backoffMs[attempt]);
      }
    }
  }

  async function exchange(request, onEvent, finalTypes, signal) {
    const c = await connect();
    return new Promise((resolve, reject) => {
      let buf = '';
      let result = null;
      const onAbort = () => c.destroy();
      signal?.addEventListener('abort', onAbort, { once: true });
      c.setEncoding('utf8');
      c.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          let ev;
          try {
            ev = JSON.parse(line);
          } catch {
            continue;
          }
          if (ev.type === 'error') result = new GatewayError(String(ev.code || 'error'));
          else if (finalTypes.has(ev.type)) result = ev;
          else onEvent?.(ev);
        }
      });
      c.on('error', () => {});
      c.on('close', () => {
        signal?.removeEventListener('abort', onAbort);
        if (result instanceof Error) reject(result);
        else if (result) resolve(result);
        else reject(new GatewayError('closed'));
      });
      c.write(JSON.stringify(request) + '\n');
    });
  }

  return {
    /** Resolves with the exit event; `onLine` receives each raw stream-json line. */
    run(request, { onLine, signal } = {}) {
      return exchange(request, (ev) => ev.type === 'line' && onLine?.(ev.data), new Set(['exit']), signal);
    },
    async status() {
      return exchange({ op: 'status' }, undefined, new Set(['status']));
    },
    async cancel(runId) {
      try {
        await exchange({ cancel: runId }, undefined, new Set(['cancelled']));
        return true;
      } catch {
        return false;
      }
    },
  };
}

module.exports = { createGatewayClient, GatewayError };
