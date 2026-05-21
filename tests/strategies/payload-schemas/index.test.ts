import { describe, expect, it } from 'vitest';

import { getProviderPayloadSchema, type JsonSchema } from '../../../src/strategies/payload-schemas';

describe('getProviderPayloadSchema', () => {
  it.each(['internal', 'schedule', 'jira', 'github', 'slack', 'gmail-pubsub'])(
    'returns a built-in family for the canonical provider name %s',
    (name) => {
      expect(getProviderPayloadSchema(name)).toBeDefined();
    },
  );

  it('resolves operator-named slack providers (slack-winston) to the slack family', () => {
    const schema = getProviderPayloadSchema('slack-winston');
    expect(schema?.properties?.['event']).toBeDefined();
  });

  it('resolves operator-named gmail providers (gmail-heather) to the gmail-pubsub family', () => {
    const schema = getProviderPayloadSchema('gmail-heather');
    expect(schema?.properties?.['emailAddress']).toBeDefined();
  });

  it('returns undefined for an unknown provider with no declaration', () => {
    expect(getProviderPayloadSchema('zapier')).toBeUndefined();
  });

  it('returns an inline payloadSchema declared on the provider', () => {
    const inline: JsonSchema = {
      type: 'object',
      properties: { ticketId: { type: 'string' } },
    };
    const schema = getProviderPayloadSchema('zapier', { payloadSchema: inline });
    expect(schema).toBe(inline);
  });

  it('an inline payloadSchema overrides the built-in family for the same name', () => {
    const inline: JsonSchema = { type: 'object', properties: { custom: { type: 'string' } } };
    const schema = getProviderPayloadSchema('jira', { payloadSchema: inline });
    expect(schema).toBe(inline);
  });

  it('resolves a declared payloadFamily to that built-in family', () => {
    const schema = getProviderPayloadSchema('custom-provider', { payloadFamily: 'slack' });
    expect(schema?.properties?.['event']).toBeDefined();
  });

  it('returns undefined for a payloadFamily that names no built-in family', () => {
    expect(getProviderPayloadSchema('custom-provider', { payloadFamily: 'nope' })).toBeUndefined();
  });
});
