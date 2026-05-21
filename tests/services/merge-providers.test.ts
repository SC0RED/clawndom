import { describe, expect, it } from 'vitest';

import { providerSchema, type ProviderConfig } from '../../src/config';
import {
  agentConfigSchema,
  mergeProviders,
  type ResolvedAgent,
} from '../../src/services/agent-loader.service';

function provider(name: string): ProviderConfig {
  return providerSchema.parse({
    name,
    transport: 'webhook',
    routePath: `/hooks/${name}`,
    signatureStrategy: 'bearer',
    hmacSecretKey: `${name}_secret`,
  });
}

function agent(name: string, providers: ProviderConfig[]): ResolvedAgent {
  return { name, dir: `/agents/${name}`, config: agentConfigSchema.parse({ providers }) };
}

describe('mergeProviders', () => {
  it('unions providers from env fallback, workspaces, and system providers', () => {
    const merged = mergeProviders(
      [provider('env-only')],
      [agent('winston', [provider('gmail-pubsub')]), agent('patch', [provider('jira')])],
      [provider('builder-callback')],
    );
    expect(merged.map((p) => p.name).sort((a, b) => a.localeCompare(b))).toEqual([
      'builder-callback',
      'env-only',
      'gmail-pubsub',
      'jira',
    ]);
  });

  it('errors when two workspaces declare the same provider name', () => {
    expect(() =>
      mergeProviders(
        [],
        [agent('winston', [provider('shared')]), agent('patch', [provider('shared')])],
        [],
      ),
    ).toThrow("Provider 'shared' is declared more than once");
  });

  it('errors when a workspace provider collides with the env fallback', () => {
    expect(() =>
      mergeProviders([provider('jira')], [agent('patch', [provider('jira')])], []),
    ).toThrow('declared more than once');
  });

  it('errors when a workspace provider collides with a system provider', () => {
    expect(() =>
      mergeProviders(
        [],
        [agent('winston', [provider('builder-callback')])],
        [provider('builder-callback')],
      ),
    ).toThrow('declared more than once');
  });

  it('returns an empty list when no providers are declared anywhere', () => {
    expect(mergeProviders([], [agent('winston', [])], [])).toEqual([]);
  });

  it('preserves full provider config, not just names', () => {
    const merged = mergeProviders([], [agent('winston', [provider('gmail-pubsub')])], []);
    expect(merged[0]).toMatchObject({
      name: 'gmail-pubsub',
      transport: 'webhook',
      signatureStrategy: 'bearer',
    });
  });
});
