import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { load as parseYaml } from 'js-yaml';
import supertest from 'supertest';
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

import { createApp } from '../../../src/app';
import { getSettings, resetSettings } from '../../../src/config';
import { agentConfigSchema, mergeProviders } from '../../../src/services/agent-loader.service';
import type { ResolvedAgent } from '../../../src/services/agent-loader.service';
import { toolYamlSchema } from '../../../src/services/tools/descriptor';

vi.mock('../../../src/services/queue.service', () => ({
  getProviderQueue: vi.fn(() => ({ add: vi.fn().mockResolvedValue({ id: 'test-job' }) })),
}));

const SCAFFOLDS = join(process.cwd(), 'src/system-agents/builder/scaffolds');
const ORIGINAL_PROVIDERS_CONFIG = process.env.PROVIDERS_CONFIG;

function readScaffold(relativePath: string): string {
  return readFileSync(join(SCAFFOLDS, relativePath), 'utf-8');
}

/** Fill the route scaffold's placeholders into a parseable agent config. */
function instantiateRoute(name: string, opts?: { inlineSecret?: string }): ResolvedAgent {
  let yaml = readScaffold('route/route.yaml').replace(/__ROUTE_NAME__/g, name);
  yaml = opts?.inlineSecret
    ? yaml.replace('hmacSecretKey: __SECRET_KEY__', `hmacSecret: ${opts.inlineSecret}`)
    : yaml.replace(/__SECRET_KEY__/g, `${name}-secret`);
  return { name, dir: `/agents/${name}`, config: agentConfigSchema.parse(parseYaml(yaml)) };
}

describe('Builder scaffolds', () => {
  describe('route scaffold', () => {
    it('instantiates into a valid agent config (provider + matching routing rule)', () => {
      const agent = instantiateRoute('practice-intake');
      expect(agent.config.providers.map((p) => p.name)).toEqual(['practice-intake']);
      expect(agent.config.routing['practice-intake']?.rules[0]?.id).toBe('practice-intake-handle');
    });

    it('is portable: clawndom fills runner.workDirectory from the agent clone dir', () => {
      const agent = instantiateRoute('practice-intake');
      const merged = mergeProviders([], [agent], []);
      expect(merged[0]).toMatchObject({
        name: 'practice-intake',
        transport: 'webhook',
        runner: { type: 'claude-cli', workDirectory: '/agents/practice-intake' },
      });
    });
  });

  describe('tool scaffold', () => {
    it('tool.yaml parses against the tool descriptor schema', () => {
      const parsed = toolYamlSchema.parse(parseYaml(readScaffold('tool/tool.yaml')));
      expect(parsed.description.length).toBeGreaterThan(0);
      expect(Object.keys(parsed.args)).toContain('subject');
      // secrets are declared as SecretManager key references, never values
      expect(Object.keys(parsed.secrets).length).toBeGreaterThan(0);
    });

    it('impl.py exposes a keyword-only invoke() returning a structured result', () => {
      const impl = readScaffold('tool/impl.py');
      expect(impl).toMatch(/def invoke\(\*,/);
      expect(impl).toMatch(/return \{/);
      expect(impl).not.toMatch(/os\.environ/); // no inline credential reads
    });
  });

  describe('template scaffold', () => {
    it('encodes the distilled best-practice sections', () => {
      const template = readScaffold('template/agent-task.md');
      for (const section of [
        'The trigger:',
        '## Step 0 — Guard',
        '## Memory',
        '## Anti-patterns',
        '## Test-first guarantee',
      ]) {
        expect(template).toContain(section);
      }
    });
  });

  describe('API integration — a scaffolded route yields a working authenticated endpoint', () => {
    const SECRET = 'scaffold-bearer-secret';

    beforeEach(() => {
      vi.clearAllMocks();
    });

    afterAll(() => {
      if (ORIGINAL_PROVIDERS_CONFIG === undefined) delete process.env.PROVIDERS_CONFIG;
      else process.env.PROVIDERS_CONFIG = ORIGINAL_PROVIDERS_CONFIG;
      resetSettings();
    });

    function bootApp(agent: ResolvedAgent): ReturnType<typeof createApp> {
      process.env.PROVIDERS_CONFIG = '[]';
      resetSettings();
      const settings = getSettings();
      const merged = mergeProviders(settings.providers, [agent], []);
      settings.providers.length = 0;
      settings.providers.push(...merged);
      return createApp([agent]);
    }

    it('accepts a correctly-authenticated request (bearer → 202)', async () => {
      const app = bootApp(instantiateRoute('practice-intake', { inlineSecret: SECRET }));
      const response = await supertest(app)
        .post('/hooks/practice-intake')
        .set('Content-Type', 'application/json')
        .set('Authorization', `Bearer ${SECRET}`)
        .send(JSON.stringify({ event: 'new_intake' }));
      expect(response.status).toBe(202);
      expect(response.body).toEqual({ accepted: true });
    });

    it('rejects a bad token (401) — auth is enforced', async () => {
      const app = bootApp(instantiateRoute('practice-intake', { inlineSecret: SECRET }));
      const response = await supertest(app)
        .post('/hooks/practice-intake')
        .set('Content-Type', 'application/json')
        .set('Authorization', 'Bearer wrong-token')
        .send(JSON.stringify({ event: 'new_intake' }));
      expect(response.status).toBe(401);
    });
  });
});
