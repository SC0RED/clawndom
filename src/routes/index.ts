import express from 'express';
import type { Express } from 'express';

import { getSettings } from '../config';
import { createHealthRoutes } from './health.routes';
import { createWebhookHandler } from '../controllers/webhook.controller';

export function registerRoutes(app: Express): void {
  app.use('/api/health', createHealthRoutes());

  const settings = getSettings();

  for (const provider of settings.providers) {
    app.post(
      provider.routePath,
      express.raw({ type: 'application/json', limit: '10mb' }),
      createWebhookHandler(provider),
    );
  }
}
