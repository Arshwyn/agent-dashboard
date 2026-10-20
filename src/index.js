'use strict';

const { loadConfig, startupWarnings } = require('./config');
const { openDb } = require('./db');
const { createApp } = require('./server');

function main() {
  let config;
  try {
    config = loadConfig(process.env);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  for (const w of startupWarnings(config)) console.warn(`WARNING: ${w}`);
  const store = openDb(config.dbPath);
  const deleted = store.prune({ retentionDays: config.retentionDays, maxRows: config.maxRows });
  const app = createApp(config, store);
  app.server.listen(config.port, config.host, () => {
    console.log(`agent-dashboard listening on ${config.host}:${config.port} (pruned ${deleted} old rows)`);
  });
  const shutdown = () => {
    app.close().then(() => {
      store.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main();
