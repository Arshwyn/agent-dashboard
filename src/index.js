'use strict';

const { loadConfig, startupWarnings } = require('./config');
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
  const app = createApp(config);
  app.server.listen(config.port, config.host, () => {
    console.log(`agent-hub listening on ${config.host}:${config.port}`);
  });
  const shutdown = () => {
    app.close().then(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main();
