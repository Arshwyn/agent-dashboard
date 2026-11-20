'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { loadConfig, startupWarnings } = require('./config');
const { createApp } = require('./server');
const { openStore } = require('./store');
const { createGatewayClient } = require('./gatewayClient');

function main() {
  let config;
  try {
    config = loadConfig(process.env);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  for (const w of startupWarnings(config)) console.warn(`WARNING: ${w}`);
  // Chat needs the gateway socket and the history database; without a socket the shell runs and chat is offline.
  let store = null;
  let gateway = null;
  if (config.gatewaySocket) {
    fs.mkdirSync(path.dirname(path.resolve(config.dbPath)), { recursive: true });
    // the history is private: create the file 0600 before SQLite does (its -wal and -shm files follow its mode)
    fs.closeSync(fs.openSync(config.dbPath, 'a', 0o600));
    store = openStore(config.dbPath);
    gateway = createGatewayClient({ socketPath: config.gatewaySocket });
  }
  const app = createApp(config, { store, gateway });
  app.server.listen(config.port, config.host, () => {
    console.log(`agent-hub listening on ${config.host}:${config.port}`);
  });
  const shutdown = () => {
    app.close().then(() => {
      if (store) store.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main();
