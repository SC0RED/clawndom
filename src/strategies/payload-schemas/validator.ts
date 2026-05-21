import { z } from 'zod';

import type { JsonSchema } from './types';

/**
 * Zod validator for the narrow JSON-Schema subset (see `JsonSchema` in
 * `./types`). It serves two callers:
 *
 *  1. Boundary validation of an operator-declared `payloadSchema` on a
 *     workspace's `routing.<provider>` block (config is untrusted input).
 *  2. Parsing the built-in `provider-families.json` at module load, which
 *     both types the data as `JsonSchema` and fail-fast guards against a
 *     malformed family shape.
 *
 * Recursive, so it's defined with `z.lazy`. Kept in lockstep with the
 * `JsonSchema` interface — add a keyword in both places when a real
 * consumer needs one.
 */
const jsonSchemaTypeSchema = z.enum([
  'object',
  'array',
  'string',
  'number',
  'integer',
  'boolean',
  'null',
]);

export const jsonSchemaSchema: z.ZodType<JsonSchema> = z.lazy(() =>
  z
    .object({
      type: z.union([jsonSchemaTypeSchema, z.array(jsonSchemaTypeSchema)]).optional(),
      description: z.string().optional(),
      properties: z.record(z.string(), jsonSchemaSchema).optional(),
      required: z.array(z.string()).optional(),
      items: jsonSchemaSchema.optional(),
      additionalProperties: z.union([z.boolean(), jsonSchemaSchema]).optional(),
      enum: z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
      passthrough: z.boolean().optional(),
    })
    .strict(),
);
