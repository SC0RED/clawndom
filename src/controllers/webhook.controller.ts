import type { Request, Response } from 'express';

import type { ProviderConfig } from '../config';
import { getProviderQueue } from '../services/queue.service';
import { getSignatureStrategy } from '../strategies/signature';
import { getLogger } from '../lib/logging';

const logger = getLogger('webhook-controller');

export function createWebhookHandler(provider: ProviderConfig) {
  const strategy = getSignatureStrategy(provider.signatureStrategy);

  return async (request: Request, response: Response): Promise<void> => {
    const signatureHeader = request.headers[strategy.headerName];

    if (typeof signatureHeader !== 'string') {
      logger.warn({ provider: provider.name }, `Missing ${strategy.headerName} header`);
      response.status(401).json({ error: 'Missing signature' });
      return;
    }

    const rawBody = request.body as Buffer;

    if (!strategy.validate(rawBody, signatureHeader, provider.hmacSecret)) {
      logger.warn({ provider: provider.name }, 'Invalid HMAC signature');
      response.status(401).json({ error: 'Invalid signature' });
      return;
    }

    const queue = getProviderQueue(provider.name);
    await queue.add('webhook-event', rawBody.toString('utf-8'));

    logger.info({ provider: provider.name }, 'Webhook accepted and enqueued');
    response.status(202).json({ accepted: true });
  };
}
