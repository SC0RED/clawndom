import { z } from 'zod';

import providerFamiliesData from './provider-families.json';
import type { JsonSchema } from './types';
import { jsonSchemaSchema } from './validator';

/**
 * Built-in provider-family payload shapes, loaded from data
 * (`provider-families.json`) rather than compiled in. Parsing through
 * `jsonSchemaSchema` both types the records as `JsonSchema` and fail-fast
 * guards a malformed family at module load. These are *defaults*: a
 * workspace can override or extend them per-provider (see below), and a
 * brand-new provider can be added entirely from workspace config without
 * touching the runner.
 */
const providerFamilies: Readonly<Record<string, JsonSchema>> = z
  .record(z.string(), jsonSchemaSchema)
  .parse(providerFamiliesData);

/**
 * Operator-named providers inherit a canonical family by name prefix, so
 * `slack-winston` / `gmail-heather` resolve without re-declaring the shape.
 */
const PREFIX_FAMILIES: readonly { prefix: string; family: string }[] = [
  { prefix: 'slack-', family: 'slack' },
  { prefix: 'gmail-', family: 'gmail-pubsub' },
];

/**
 * What a provider's `routing.<provider>` block may carry to declare its
 * inbound payload shape. Both are optional; absent both, the resolver
 * falls back to the built-in families.
 */
export interface ProviderSchemaDeclaration {
  readonly payloadSchema?: JsonSchema;
  readonly payloadFamily?: string;
}

/**
 * Resolve the inbound payload schema for a provider. Resolution order:
 *   1. an inline `payloadSchema` declared on the provider's routing block,
 *   2. a `payloadFamily` naming a built-in family,
 *   3. an exact built-in family whose name matches the provider,
 *   4. a built-in family matched by well-known name prefix,
 *   5. undefined — callers degrade gracefully (free-text path entry, no audit).
 */
export function getProviderPayloadSchema(
  providerName: string,
  declaration?: ProviderSchemaDeclaration,
): JsonSchema | undefined {
  if (declaration?.payloadSchema !== undefined) return declaration.payloadSchema;
  if (declaration?.payloadFamily !== undefined) return providerFamilies[declaration.payloadFamily];

  const exact = providerFamilies[providerName];
  if (exact !== undefined) return exact;

  for (const entry of PREFIX_FAMILIES) {
    if (providerName.startsWith(entry.prefix)) return providerFamilies[entry.family];
  }
  return undefined;
}

export type { JsonSchema } from './types';
export { jsonSchemaSchema } from './validator';
export { resolveArrayItem, resolvePath } from './lookup';
