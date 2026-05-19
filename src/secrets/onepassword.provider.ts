import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getLogger } from '../lib/logging';
import type { SecretProvider, SecretBinding, OnePasswordProviderConfig } from './types';

const execFileAsync = promisify(execFile);
const logger = getLogger('secret:onepassword');

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_RETRY_BASE_DELAY_MS = 1000;
const RATE_LIMIT_SIGNAL = 'Too many requests';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRateLimited(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes(RATE_LIMIT_SIGNAL);
}

/**
 * Resolves secrets from 1Password using the `op` CLI with a service account token.
 * Requires OP_SERVICE_ACCOUNT_TOKEN in the process environment.
 *
 * The `reference` field in a SecretBinding is a 1Password secret reference URI:
 *   op://vault/item/field
 *
 * Example: op://Clawndom/jira-webhook/hmac-secret
 *
 * Reads are serialized + retry-on-rate-limit. 1P's service-account API
 * returns "Too many requests" (no Retry-After header) on burst, which
 * is trivial to hit when boot fans out N parallel reads in one go. The
 * provider walks bindings one at a time and retries each with
 * exponential backoff. Cold boot cost is ~1s × N secrets; in exchange
 * we never trip the per-item rate limit. Tune via `maxAttempts` and
 * `retryBaseDelayMs` if a tenant's headroom is wildly different.
 */
export class OnePasswordProvider implements SecretProvider {
  readonly name = 'onepassword';
  private readonly binary: string;
  private readonly token: string;
  private readonly maxAttempts: number;
  private readonly retryBaseDelayMs: number;

  constructor(config: OnePasswordProviderConfig) {
    this.binary = config.binary ?? 'op';
    const token = process.env['OP_SERVICE_ACCOUNT_TOKEN'];
    if (!token) {
      throw new Error('OP_SERVICE_ACCOUNT_TOKEN is required for the onepassword secret provider');
    }
    this.token = token;
    this.maxAttempts = config.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.retryBaseDelayMs = config.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
  }

  async initialize(): Promise<void> {
    // Verify the op CLI is available and authenticated
    try {
      await execFileAsync(this.binary, ['--version'], {
        env: { ...process.env, OP_SERVICE_ACCOUNT_TOKEN: this.token },
        timeout: 10_000,
      });
      logger.info('1Password CLI verified');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`1Password CLI not available: ${message}`);
    }
  }

  async resolve(bindings: readonly SecretBinding[]): Promise<ReadonlyMap<string, string>> {
    const result = new Map<string, string>();
    const env = { ...process.env, OP_SERVICE_ACCOUNT_TOKEN: this.token };

    // Serial walk: 1P's per-item rate limit is easy to trip with a
    // parallel burst, and the boot cost of serializing (~1s per secret)
    // is acceptable. Each read retries with exponential backoff on the
    // 'Too many requests' signal.
    for (const binding of bindings) {
      const value = await this.readOneWithRetry(binding, env);
      if (value !== null) {
        result.set(binding.key, value);
      }
      // Caller (SecretManager) handles missing required secrets.
    }

    return result;
  }

  private async readOneWithRetry(
    binding: SecretBinding,
    env: NodeJS.ProcessEnv,
  ): Promise<string | null> {
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        const { stdout } = await execFileAsync(
          this.binary,
          ['read', binding.reference, '--no-newline'],
          { env, timeout: 15_000, encoding: 'utf-8' },
        );
        return stdout;
      } catch (error) {
        if (isRateLimited(error) && attempt < this.maxAttempts) {
          const backoffMs = this.retryBaseDelayMs * Math.pow(2, attempt - 1);
          logger.warn(
            { key: binding.key, attempt, maxAttempts: this.maxAttempts, backoffMs },
            '1P rate-limited; backing off',
          );
          await sleep(backoffMs);
          continue;
        }
        const message = error instanceof Error ? error.message : String(error);
        logger.error(
          { key: binding.key, reference: binding.reference, attempt, error: message },
          'Failed to resolve secret from 1Password',
        );
        return null;
      }
    }
    return null;
  }
}
