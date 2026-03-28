import { createApp } from './app';
import { setupLogging } from './lib/logging';
import { getSettings } from './config';
import { getLogger } from './lib/logging';
import { createWorker } from './services/worker.service';
import { GatewayClient } from './services/gateway-client';

async function startServer(): Promise<void> {
  setupLogging();
  const logger = getLogger('server');
  const settings = getSettings();

  // Single gateway WS connection shared by all workers
  const gatewayClient = new GatewayClient(settings.openclawGatewayWsUrl, settings.openclawToken);
  await gatewayClient.connect();

  for (const provider of settings.providers) {
    createWorker(provider, gatewayClient);
  }
  logger.info({ providers: settings.providers.map((p) => p.name) }, 'Workers started');

  const app = createApp();
  const port = settings.port;

  app.listen(port, () => {
    logger.info({ port }, `Server running on port ${port}`);
  });

  const shutdown = async (): Promise<void> => {
    logger.info('Shutting down...');
    await gatewayClient.close();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

startServer().catch((error: unknown) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
