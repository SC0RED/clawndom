/**
 * gateway-client.service.ts
 *
 * Delivers messages to an agent session via the OpenClaw gateway using the
 * `openclaw gateway call sessions.send` CLI subprocess. This delegates all
 * auth complexity (device identity, token, challenge-response) to the
 * installed openclaw CLI, which already has the right credentials loaded.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname } from 'node:path';
import { getLogger } from '../lib/logging/logger.js';
import { getSettings } from '../config.js';

const execFileAsync = promisify(execFile);

export interface SendToSessionParams {
  /** Target session key, e.g. "agent:patch:main" */
  key: string;
  /** Message content to deliver */
  message: string;
  /** Optional idempotency key */
  idempotencyKey?: string;
  /** Timeout in ms (default: 10000) */
  timeoutMs?: number;
}

export interface SendToSessionResult {
  runId?: string;
  status?: string;
  messageSeq?: number;
}

const logger = getLogger('gateway-client');

/**
 * Delivers a message to an agent session via `openclaw gateway call sessions.send`.
 * The openclaw CLI handles device identity, token auth, and WS handshake.
 */
export async function sendToSession(params: SendToSessionParams): Promise<SendToSessionResult> {
  const settings = getSettings();
  const { key, message, idempotencyKey, timeoutMs = 15_000 } = params;

  const callParams: Record<string, unknown> = { key, message };
  if (idempotencyKey) callParams.idempotencyKey = idempotencyKey;

  const args = [
    'gateway',
    'call',
    'sessions.send',
    '--json',
    '--timeout',
    String(timeoutMs),
    '--params',
    JSON.stringify(callParams),
  ];

  // Optionally override gateway URL and token from settings
  if (settings.openclawGatewayWsUrl) {
    args.push('--url', settings.openclawGatewayWsUrl);
  }
  if (settings.openclawToken) {
    args.push('--token', settings.openclawToken);
  }

  logger.debug({ sessionKey: key, idempotencyKey }, 'Calling openclaw gateway sessions.send');

  // Resolve full path to openclaw binary — launchd agents run with a stripped PATH
  const openclawBin =
    process.env.OPENCLAW_BIN_PATH ?? '/Volumes/SSD/nvm/versions/node/v24.5.0/bin/openclaw';

  // When running under launchd, PATH is stripped — node won't be found for
  // the openclaw shebang. Prepend the bin dir so `env node` resolves correctly.
  const openclawBinDir = dirname(openclawBin);
  const subPath = [openclawBinDir, process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin']
    .filter(Boolean)
    .join(':');

  const { stdout } = await execFileAsync(openclawBin, args, {
    timeout: timeoutMs + 5_000, // give the subprocess a bit more than the gateway timeout
    env: { ...process.env, PATH: subPath, OPENCLAW_ALLOW_INSECURE_PRIVATE_WS: '1' },
  });

  const result = JSON.parse(stdout.trim()) as SendToSessionResult;
  logger.debug({ sessionKey: key, result }, 'Gateway sessions.send acknowledged');
  return result;
}
