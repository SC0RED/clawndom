import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual('node:child_process');
  return { ...actual, execFile: vi.fn() };
});

import { execFile } from 'node:child_process';
import { OnePasswordProvider } from '../../src/secrets/onepassword.provider';
import type { SecretBinding } from '../../src/secrets/types';

describe('OnePasswordProvider', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.OP_SERVICE_ACCOUNT_TOKEN = 'test-op-token';
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('should have name "onepassword"', () => {
    const provider = new OnePasswordProvider({ type: 'onepassword' });
    expect(provider.name).toBe('onepassword');
  });

  it('should throw if OP_SERVICE_ACCOUNT_TOKEN is not set', () => {
    delete process.env.OP_SERVICE_ACCOUNT_TOKEN;
    expect(() => new OnePasswordProvider({ type: 'onepassword' })).toThrow(
      'OP_SERVICE_ACCOUNT_TOKEN is required',
    );
  });

  it('should resolve secrets via op read', async () => {
    // Mock execFile to simulate `op read` returning a value
    vi.mocked(execFile).mockImplementation(
      (
        _cmd: string,
        args: readonly string[],
        _opts: unknown,
        callback?: (...args: unknown[]) => void,
      ) => {
        if (typeof _opts === 'function') {
          callback = _opts;
        }
        if (args[0] === 'read') {
          callback!(null, { stdout: 'resolved-secret-value' });
        } else {
          callback!(null, { stdout: 'op 2.0.0' });
        }
        return {} as ReturnType<typeof execFile>;
      },
    );

    const provider = new OnePasswordProvider({ type: 'onepassword' });
    const bindings: SecretBinding[] = [
      {
        key: 'jira_hmac',
        provider: 'onepassword',
        reference: 'op://Clawndom/jira/hmac',
        required: true,
      },
    ];
    const result = await provider.resolve(bindings);
    expect(result.get('jira_hmac')).toBe('resolved-secret-value');
  });

  it('should omit secrets that fail to resolve', async () => {
    vi.mocked(execFile).mockImplementation(
      (
        _cmd: string,
        args: readonly string[],
        _opts: unknown,
        callback?: (...args: unknown[]) => void,
      ) => {
        if (typeof _opts === 'function') {
          callback = _opts;
        }
        callback!(new Error('item not found'), { stdout: '' });
        return {} as ReturnType<typeof execFile>;
      },
    );

    const provider = new OnePasswordProvider({ type: 'onepassword' });
    const bindings: SecretBinding[] = [
      {
        key: 'missing',
        provider: 'onepassword',
        reference: 'op://Clawndom/missing/field',
        required: true,
      },
    ];
    const result = await provider.resolve(bindings);
    expect(result.has('missing')).toBe(false);
  });

  it('retries on "Too many requests" and eventually succeeds', async () => {
    let attempts = 0;
    vi.mocked(execFile).mockImplementation(
      (
        _cmd: string,
        args: readonly string[],
        _opts: unknown,
        callback?: (...args: unknown[]) => void,
      ) => {
        if (typeof _opts === 'function') {
          callback = _opts;
        }
        if (args[0] === '--version') {
          callback!(null, { stdout: 'op 2.0.0' });
          return {} as ReturnType<typeof execFile>;
        }
        attempts += 1;
        if (attempts < 3) {
          callback!(
            new Error(
              'Command failed: op read [...]\n[ERROR] could not get item: Too many requests. Your client has been rate-limited.',
            ),
            { stdout: '' },
          );
        } else {
          callback!(null, { stdout: 'success-on-third-try' });
        }
        return {} as ReturnType<typeof execFile>;
      },
    );

    const provider = new OnePasswordProvider({
      type: 'onepassword',
      retryBaseDelayMs: 1, // tight loop for the test
    });
    const bindings: SecretBinding[] = [
      {
        key: 'eventually_ok',
        provider: 'onepassword',
        reference: 'op://Clawndom/eventually/ok',
        required: true,
      },
    ];
    const result = await provider.resolve(bindings);
    expect(result.get('eventually_ok')).toBe('success-on-third-try');
    expect(attempts).toBe(3);
  });

  it('gives up after maxAttempts on persistent rate-limit', async () => {
    let attempts = 0;
    vi.mocked(execFile).mockImplementation(
      (
        _cmd: string,
        args: readonly string[],
        _opts: unknown,
        callback?: (...args: unknown[]) => void,
      ) => {
        if (typeof _opts === 'function') {
          callback = _opts;
        }
        if (args[0] === '--version') {
          callback!(null, { stdout: 'op 2.0.0' });
          return {} as ReturnType<typeof execFile>;
        }
        attempts += 1;
        callback!(new Error('Too many requests. Your client has been rate-limited.'), {
          stdout: '',
        });
        return {} as ReturnType<typeof execFile>;
      },
    );

    const provider = new OnePasswordProvider({
      type: 'onepassword',
      maxAttempts: 3,
      retryBaseDelayMs: 1,
    });
    const bindings: SecretBinding[] = [
      {
        key: 'stuck',
        provider: 'onepassword',
        reference: 'op://Clawndom/stuck/field',
        required: true,
      },
    ];
    const result = await provider.resolve(bindings);
    expect(result.has('stuck')).toBe(false);
    expect(attempts).toBe(3);
  });

  it('resolves bindings serially, not in parallel', async () => {
    const callOrder: string[] = [];
    const inflight = new Set<string>();
    let maxInflight = 0;
    vi.mocked(execFile).mockImplementation(
      (
        _cmd: string,
        args: readonly string[],
        _opts: unknown,
        callback?: (...args: unknown[]) => void,
      ) => {
        if (typeof _opts === 'function') {
          callback = _opts;
        }
        if (args[0] === '--version') {
          callback!(null, { stdout: 'op 2.0.0' });
          return {} as ReturnType<typeof execFile>;
        }
        const ref = args[1];
        if (!ref) return {} as ReturnType<typeof execFile>;
        inflight.add(ref);
        maxInflight = Math.max(maxInflight, inflight.size);
        // Defer the callback so any concurrent call would be visible.
        setTimeout(() => {
          callOrder.push(ref);
          inflight.delete(ref);
          callback!(null, { stdout: `value-for-${ref}` });
        }, 5);
        return {} as ReturnType<typeof execFile>;
      },
    );

    const provider = new OnePasswordProvider({ type: 'onepassword' });
    const bindings: SecretBinding[] = ['a', 'b', 'c'].map((k) => ({
      key: k,
      provider: 'onepassword',
      reference: `op://Clawndom/${k}/field`,
      required: true,
    }));
    await provider.resolve(bindings);
    expect(maxInflight).toBe(1);
    expect(callOrder).toEqual([
      'op://Clawndom/a/field',
      'op://Clawndom/b/field',
      'op://Clawndom/c/field',
    ]);
  });
});
