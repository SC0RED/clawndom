import { describe, it, expect, afterEach } from 'vitest';

import { getSettings, resetSettings } from '../../src/config';
import { resolveHmacSecret } from '../../src/controllers/webhook.controller';
import { EnvSecretProvider } from '../../src/secrets/env.provider';
import { SecretManager } from '../../src/secrets/manager';
import { registerSecretProvider } from '../../src/secrets/registry';

describe('resolveHmacSecret', () => {
  let manager: SecretManager | null = null;

  afterEach(() => {
    manager?.close();
    manager = null;
    delete process.env.WEBHOOK_TEST_SECRET;
  });

  it('returns the inline literal when only hmacSecret is set', () => {
    expect(resolveHmacSecret({ hmacSecret: 'literal-secret' })).toBe('literal-secret');
  });

  it('returns null when neither hmacSecret nor hmacSecretKey is set', () => {
    expect(resolveHmacSecret({})).toBeNull();
  });

  it('resolves hmacSecretKey from the SecretManager', async () => {
    registerSecretProvider(new EnvSecretProvider());
    process.env.WEBHOOK_TEST_SECRET = 'resolved-from-manager';
    manager = new SecretManager([
      {
        key: 'intake-webhook-secret',
        provider: 'env',
        reference: 'WEBHOOK_TEST_SECRET',
        required: true,
      },
    ]);
    await manager.initialize();

    expect(resolveHmacSecret({ hmacSecretKey: 'intake-webhook-secret' })).toBe(
      'resolved-from-manager',
    );
  });

  it('returns null when hmacSecretKey has no resolved binding (fail closed)', async () => {
    registerSecretProvider(new EnvSecretProvider());
    manager = new SecretManager([]);
    await manager.initialize();

    expect(resolveHmacSecret({ hmacSecretKey: 'never-declared' })).toBeNull();
  });
});

describe('provider invariant: hmacSecret vs hmacSecretKey', () => {
  const savedProvidersConfig = process.env.PROVIDERS_CONFIG;

  afterEach(() => {
    process.env.PROVIDERS_CONFIG = savedProvidersConfig;
    resetSettings();
  });

  it('rejects a provider that sets both hmacSecret and hmacSecretKey', () => {
    process.env.PROVIDERS_CONFIG = JSON.stringify([
      {
        name: 'dup',
        routePath: '/hooks/dup',
        signatureStrategy: 'bearer',
        hmacSecret: 'literal',
        hmacSecretKey: 'a-key',
      },
    ]);
    resetSettings();
    expect(() => getSettings()).toThrow(/exactly one/);
  });

  it('rejects a non-oidc provider that has neither hmacSecret nor hmacSecretKey', () => {
    process.env.PROVIDERS_CONFIG = JSON.stringify([
      { name: 'naked', routePath: '/hooks/naked', signatureStrategy: 'bearer' },
    ]);
    resetSettings();
    expect(() => getSettings()).toThrow(/needs 'hmacSecret' or 'hmacSecretKey'/);
  });

  it('accepts a provider that sets only hmacSecretKey', () => {
    process.env.PROVIDERS_CONFIG = JSON.stringify([
      {
        name: 'keyed',
        routePath: '/hooks/keyed',
        signatureStrategy: 'bearer',
        hmacSecretKey: 'intake-webhook-secret',
      },
    ]);
    resetSettings();
    const settings = getSettings();
    const provider = settings.providers.find((p) => p.name === 'keyed');
    expect(provider?.transport).toBe('webhook');
  });
});
