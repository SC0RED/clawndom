import { z } from 'zod';

import { resolveFieldPath } from './field-path';

const regexFlagsSchema = z
  .string()
  .regex(/^[gimsuy]*$/, 'flags must contain only g, i, m, s, u, y')
  .optional();

const equalsLeafSchema = z.object({
  equals: z.object({
    field: z.string().min(1),
    value: z.string(),
  }),
});

// SPE-2162 — the Rust Agency runtime substitutes `${shared.PATH}` against
// each workspace's `shared/*.json` data at config-load time. clawndom's audit
// runs on the *raw* YAML (no substitution), so it would reject a placeholder
// string at a `string[]` slot. Accept the whole-string placeholder shape here
// so the audit can validate roster-driven routes without a substitution pass
// of its own. Anything else still requires an array of strings.
const sharedPlaceholderSchema = z
  .string()
  .regex(/^\$\{shared\.[A-Za-z0-9_.-]+\}$/, 'must be a `${shared.X.Y}` placeholder');
const inLeafSchema = z.object({
  in: z.object({
    field: z.string().min(1),
    values: z.union([z.array(z.string()).min(1), sharedPlaceholderSchema]),
  }),
});

const matchesLeafSchema = z.object({
  matches: z.object({
    field: z.string().min(1),
    pattern: z.string().refine(
      (p) => {
        try {
          new RegExp(p);
          return true;
        } catch {
          return false;
        }
      },
      { message: 'pattern must be a valid regular expression' },
    ),
    flags: regexFlagsSchema,
  }),
});

const existsLeafSchema = z.object({
  exists: z.object({
    field: z.string().min(1),
  }),
});

export type Condition =
  | { equals: { field: string; value: string } }
  | { in: { field: string; values: string[] | string } }
  | { matches: { field: string; pattern: string; flags?: string } }
  | { exists: { field: string } }
  | { any_item: { path: string; where: Condition } }
  | { all_of: Condition[] }
  | { any_of: Condition[] }
  | { not: Condition };

export const conditionSchema: z.ZodType<Condition> = z.lazy(() =>
  z.union([
    equalsLeafSchema,
    inLeafSchema,
    matchesLeafSchema,
    existsLeafSchema,
    z.object({
      any_item: z.object({
        path: z.string().min(1),
        where: conditionSchema,
      }),
    }),
    z.object({ all_of: z.array(conditionSchema) }),
    z.object({ any_of: z.array(conditionSchema) }),
    z.object({ not: conditionSchema }),
  ]),
);

function stringifyResolved(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'object') {
    return JSON.stringify(value);
  }
  if (typeof value === 'symbol') {
    return value.toString();
  }
  // value is string | number | boolean | bigint — all convert losslessly.
  return String(value as string | number | boolean | bigint);
}

function evaluateEquals(payload: unknown, field: string, target: string): boolean {
  const resolved = resolveFieldPath(payload, field);
  if (resolved === undefined || resolved === null) {
    return false;
  }
  if (Array.isArray(resolved)) {
    return resolved.some((element) => stringifyResolved(element) === target);
  }
  return stringifyResolved(resolved) === target;
}

function evaluateIn(payload: unknown, field: string, values: readonly string[] | string): boolean {
  // SPE-2162 — clawndom's audit accepts `${shared.X}` placeholders so the
  // Rust runtime can substitute them at load time. If anything ever calls
  // `evaluateCondition` on an un-substituted placeholder, that's a bug in
  // the caller (clawndom shouldn't be evaluating live events anymore;
  // that's the Rust runtime's job), so fail loud rather than silently
  // never-match.
  if (typeof values === 'string') {
    throw new Error(
      `evaluateIn received an unresolved \`${values}\` placeholder for field "${field}" — ` +
        'clawndom does not substitute shared-data placeholders; only the Rust Agency runtime does.',
    );
  }
  const resolved = resolveFieldPath(payload, field);
  if (resolved === undefined || resolved === null) {
    return false;
  }
  const targets = new Set(values);
  if (Array.isArray(resolved)) {
    return resolved.some((element) => targets.has(stringifyResolved(element)));
  }
  return targets.has(stringifyResolved(resolved));
}

function evaluateMatches(
  payload: unknown,
  field: string,
  pattern: string,
  flags: string | undefined,
): boolean {
  const resolved = resolveFieldPath(payload, field);
  if (resolved === undefined || resolved === null) {
    return false;
  }
  const regex = new RegExp(pattern, flags);
  if (Array.isArray(resolved)) {
    return resolved.some((element) => regex.test(stringifyResolved(element)));
  }
  return regex.test(stringifyResolved(resolved));
}

function evaluateExists(payload: unknown, field: string): boolean {
  const resolved = resolveFieldPath(payload, field);
  return resolved !== undefined && resolved !== null;
}

/**
 * `any_item` iterates an array-valued field path and returns true when at
 * least one element satisfies the sub-condition. Each element becomes the
 * root for its own sub-evaluation — paths inside `where` resolve against
 * the array element, not the outer payload. Returns false if the path
 * doesn't resolve to an array or the array is empty.
 */
function evaluateAnyItem(payload: unknown, path: string, where: Condition): boolean {
  const items = resolveFieldPath(payload, path);
  if (!Array.isArray(items)) {
    return false;
  }
  return items.some((item) => evaluateCondition(item, where));
}

export function evaluateCondition(payload: unknown, condition: Condition): boolean {
  if ('equals' in condition) {
    return evaluateEquals(payload, condition.equals.field, condition.equals.value);
  }
  if ('in' in condition) {
    return evaluateIn(payload, condition.in.field, condition.in.values);
  }
  if ('matches' in condition) {
    return evaluateMatches(
      payload,
      condition.matches.field,
      condition.matches.pattern,
      condition.matches.flags,
    );
  }
  if ('exists' in condition) {
    return evaluateExists(payload, condition.exists.field);
  }
  if ('any_item' in condition) {
    return evaluateAnyItem(payload, condition.any_item.path, condition.any_item.where);
  }
  if ('all_of' in condition) {
    return condition.all_of.every((child) => evaluateCondition(payload, child));
  }
  if ('any_of' in condition) {
    return condition.any_of.some((child) => evaluateCondition(payload, child));
  }
  return !evaluateCondition(payload, condition.not);
}
