import { describe, expect, it } from 'vitest';

import { providerSchema, type ProviderConfig } from '../../src/config';
import {
  agentConfigSchema,
  mergeProviders,
  type ResolvedAgent,
} from '../../src/services/agent-loader.service';

function provider(name: string, routePath = `/hooks/${name}`): ProviderConfig {
  return providerSchema.parse({
    name,
    transport: 'webhook',
    routePath,
    signatureStrategy: 'bearer',
    hmacSecretKey: `${name}_secret`,
  });
}

function claudeCliProvider(name: string): ProviderConfig {
  return providerSchema.parse({
    name,
    transport: 'webhook',
    routePath: `/hooks/${name}`,
    signatureStrategy: 'bearer',
    hmacSecretKey: `${name}_secret`,
    runner: { type: 'claude-cli' }, // workDirectory omitted on purpose
  });
}

function oidcProvider(name: string): ProviderConfig {
  return providerSchema.parse({
    name,
    transport: 'webhook',
    routePath: `/hooks/${name}`,
    signatureStrategy: 'oidc',
    oidc: { serviceAccountEmail: 'svc@project.iam.gserviceaccount.com' }, // audience omitted
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
    ).toThrow("Provider 'shared' is declared by both");
  });

  it('errors when a workspace provider collides with a system provider', () => {
    expect(() =>
      mergeProviders(
        [],
        [agent('winston', [provider('builder-callback')])],
        [provider('builder-callback')],
      ),
    ).toThrow("Provider 'builder-callback' is declared by both");
  });

  it('lets a workspace provider shadow a same-named env fallback (workspace wins)', () => {
    const merged = mergeProviders(
      [provider('jira', '/hooks/env-jira')],
      [agent('patch', [provider('jira', '/hooks/workspace-jira')])],
      [],
    );
    const jira = merged.filter((p) => p.name === 'jira');
    expect(jira).toHaveLength(1);
    expect(jira[0]).toMatchObject({ routePath: '/hooks/workspace-jira' });
  });

  it('hydrates a claude-cli runner workDirectory from the agent clone dir', () => {
    const merged = mergeProviders([], [agent('winston', [claudeCliProvider('intake')])], []);
    expect(merged[0]).toMatchObject({
      runner: { type: 'claude-cli', workDirectory: '/agents/winston' },
    });
  });

  it('derives an OIDC audience from PUBLIC_URL + routePath, normalizing slashes', () => {
    const merged = mergeProviders(
      [],
      [agent('winston', [oidcProvider('gmail-pubsub')])],
      [],
      'https://winston-agent.example.ts.net/', // trailing slash must not double up
    );
    expect(merged[0]).toMatchObject({
      oidc: { audience: 'https://winston-agent.example.ts.net/hooks/gmail-pubsub' },
    });
  });

  it('throws when an OIDC provider has no audience and no PUBLIC_URL to derive one', () => {
    expect(() =>
      mergeProviders([], [agent('winston', [oidcProvider('gmail-pubsub')])], []),
    ).toThrow(/OIDC without an explicit audience/);
  });

  it('accepts (with deprecation) a provider using an inline hmacSecret literal', () => {
    const inline = providerSchema.parse({
      name: 'legacy',
      transport: 'webhook',
      routePath: '/hooks/legacy',
      signatureStrategy: 'bearer',
      hmacSecret: 'inline-literal',
    });
    const merged = mergeProviders([inline], [], []);
    expect(merged.map((p) => p.name)).toEqual(['legacy']);
  });

  it('returns an empty list when no providers are declared anywhere', () => {
    expect(mergeProviders([], [agent('winston', [])], [])).toEqual([]);
  });

  it('rejects a workspace provider with an invalid auth shape at boot', () => {
    const broken = providerSchema.parse({
      name: 'broken',
      transport: 'webhook',
      routePath: '/hooks/broken',
      signatureStrategy: 'bearer',
      // schema-valid but invariant-invalid: no hmacSecret / hmacSecretKey
    });
    expect(() => mergeProviders([], [agent('winston', [broken])], [])).toThrow(
      /needs 'hmacSecret' or 'hmacSecretKey'/,
    );
  });
});
