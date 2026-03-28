import { Worker } from 'bullmq';
import type { Job } from 'bullmq';
import IORedis from 'ioredis';

import type { ProviderConfig } from '../config';
import { getSettings } from '../config';
import type { GatewayClient } from './gateway-client';
import { getLogger } from '../lib/logging';

const logger = getLogger('worker');

function buildQueueName(providerName: string): string {
  return `webhooks:${providerName}`;
}

export async function processJob(
  job: Job<string>,
  provider: ProviderConfig,
  gatewayClient: GatewayClient,
): Promise<void> {
  const settings = getSettings();
  logger.info({ jobId: job.id, provider: provider.name }, 'Processing webhook job');

  const result = await gatewayClient.runAndWait(
    {
      message: job.data,
      sessionKey: `hook:${provider.name}:${job.id}`,
      name: provider.name,
      deliver: true,
    },
    settings.agentWaitTimeoutMs,
  );

  if (result.status === 'error') {
    throw new Error(`Agent run failed: ${result.error ?? 'unknown error'}`);
  }

  if (result.status === 'timeout') {
    logger.warn(
      { jobId: job.id, provider: provider.name, runId: result.runId },
      'Agent run timed out',
    );
  }

  logger.info(
    { jobId: job.id, provider: provider.name, runId: result.runId, status: result.status },
    'Webhook delivered and agent run completed',
  );
}

export function createWorker(
  provider: ProviderConfig,
  gatewayClient: GatewayClient,
): Worker<string> {
  const settings = getSettings();
  const connection = new IORedis(settings.redisUrl, { maxRetriesPerRequest: null });

  const worker = new Worker<string>(
    buildQueueName(provider.name),
    (job) => processJob(job, provider, gatewayClient),
    {
      connection,
      concurrency: 1,
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 100 },
    },
  );

  worker.on('failed', (job, error) => {
    logger.error({ jobId: job?.id, provider: provider.name, error: error.message }, 'Job failed');
  });

  logger.info({ provider: provider.name, queue: buildQueueName(provider.name) }, 'Worker started');
  return worker;
}
