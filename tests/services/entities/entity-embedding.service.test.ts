import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EntityEmbeddingService } from '../../../src/services/entities/entity-embedding.service';
import { EntityStore } from '../../../src/services/entities/entity-store.service';

let tempDir: string;
let store: EntityStore;

class DeterministicEmbedder {
  readonly name = 'test-embedder';
  readonly dimensions = 32;

  async embed(text: string): Promise<number[]> {
    // Word-token bag-of-words into a 32-dim space. Tokens are hashed
    // with FNV-1a so the bucketing has decent spread; identical inputs
    // produce identical vectors, inputs sharing tokens overlap, and
    // inputs with no shared tokens are near-orthogonal.
    const vector = new Array<number>(this.dimensions).fill(0);
    const words = text.toLowerCase().split(/\W+/).filter(Boolean);
    for (const word of words) {
      let hash = 0x811c9dc5;
      for (let index = 0; index < word.length; index++) {
        hash ^= word.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193) >>> 0;
      }
      const bucket = hash % this.dimensions;
      vector[bucket] = (vector[bucket] ?? 0) + 1;
    }
    const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
    if (magnitude === 0) return vector;
    return vector.map((value) => value / magnitude);
  }
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'clawndom-entity-embed-'));
  store = new EntityStore({
    filePath: join(tempDir, 'entities.db'),
    naturalKeys: {
      memory: { fields: ['text'] },
    },
  });
});

afterEach(() => {
  store.close();
  rmSync(tempDir, { recursive: true, force: true });
});

describe('EntityEmbeddingService.ensureEmbedded', () => {
  it('embeds vectorizable entities', async () => {
    const service = new EntityEmbeddingService(store, new DeterministicEmbedder(), [
      { kind: 'memory', textProperty: 'text' },
    ]);
    const memory = store.upsert('memory', 'a-memory', {
      text: 'family is moving in August',
      status: 'active',
    });
    await service.ensureEmbedded(memory);
    const row = store.database
      .prepare<
        [string],
        { entity_id: string; dimensions: number }
      >('SELECT entity_id, dimensions FROM entity_embeddings WHERE entity_id = ?')
      .get(memory.id);
    expect(row?.entity_id).toBe(memory.id);
    expect(row?.dimensions).toBe(32);
  });

  it('no-ops on un-vectorizable kinds', async () => {
    const service = new EntityEmbeddingService(store, new DeterministicEmbedder(), [
      { kind: 'memory', textProperty: 'text' },
    ]);
    const team = store.upsert('team_member', 'Heather', { email: 'h@x.com', status: 'active' });
    await service.ensureEmbedded(team);
    const row = store.database
      .prepare('SELECT entity_id FROM entity_embeddings WHERE entity_id = ?')
      .get(team.id);
    expect(row).toBeUndefined();
  });

  it('no-ops when configured text property is empty', async () => {
    const service = new EntityEmbeddingService(store, new DeterministicEmbedder(), [
      { kind: 'memory', textProperty: 'text' },
    ]);
    const empty = store.upsert('memory', 'blank', { text: '', status: 'active' });
    await service.ensureEmbedded(empty);
    const row = store.database
      .prepare('SELECT entity_id FROM entity_embeddings WHERE entity_id = ?')
      .get(empty.id);
    expect(row).toBeUndefined();
  });

  it('overwrites the embedding on re-embed (upsert semantics)', async () => {
    const service = new EntityEmbeddingService(store, new DeterministicEmbedder(), [
      { kind: 'memory', textProperty: 'text' },
    ]);
    const memory = store.upsert('memory', 'm', { text: 'first', status: 'active' });
    await service.ensureEmbedded(memory);
    const updated = store.upsert(
      'memory',
      'm',
      { text: 'second', status: 'active' },
      { id: memory.id },
    );
    await service.ensureEmbedded(updated);
    const rows = store.database
      .prepare('SELECT COUNT(*) AS n FROM entity_embeddings WHERE entity_id = ?')
      .get(memory.id) as { n: number };
    expect(rows.n).toBe(1);
  });
});

describe('EntityEmbeddingService.semanticRank', () => {
  it('ranks candidates by cosine similarity to the query', async () => {
    const service = new EntityEmbeddingService(store, new DeterministicEmbedder(), [
      { kind: 'memory', textProperty: 'text' },
    ]);
    const matching = store.upsert('memory', 'about-scheduling', {
      text: 'discussed scheduling conflict with Heather',
      status: 'active',
    });
    const unrelated = store.upsert('memory', 'about-paperwork', {
      text: 'paperwork status is good',
      status: 'active',
    });
    await service.ensureEmbedded(matching);
    await service.ensureEmbedded(unrelated);

    const candidates = store.find({ kinds: ['memory'] });
    const ranked = await service.semanticRank('scheduling conflict', candidates);
    expect(ranked).toHaveLength(2);
    expect(ranked[0]!.entity.id).toBe(matching.id);
    expect(ranked[0]!.similarity).toBeGreaterThan(ranked[1]!.similarity);
  });

  it('returns similarity 0 for candidates without stored embeddings', async () => {
    const service = new EntityEmbeddingService(store, new DeterministicEmbedder(), [
      { kind: 'memory', textProperty: 'text' },
    ]);
    const memory = store.upsert('memory', 'unembedded', {
      text: 'something',
      status: 'active',
    });
    const ranked = await service.semanticRank('something', [memory]);
    expect(ranked[0]!.similarity).toBe(0);
  });

  it('handles empty candidate list without calling the embedder', async () => {
    const embedder = new DeterministicEmbedder();
    let calls = 0;
    const wrapped = {
      name: embedder.name,
      dimensions: embedder.dimensions,
      embed: async (text: string): Promise<number[]> => {
        calls += 1;
        return embedder.embed(text);
      },
    };
    const service = new EntityEmbeddingService(store, wrapped, [
      { kind: 'memory', textProperty: 'text' },
    ]);
    const ranked = await service.semanticRank('anything', []);
    expect(ranked).toEqual([]);
    expect(calls).toBe(0);
  });
});

describe('EntityEmbeddingService round-trip', () => {
  it('preserves vector values through pack/unpack via cosine equality', async () => {
    const service = new EntityEmbeddingService(store, new DeterministicEmbedder(), [
      { kind: 'memory', textProperty: 'text' },
    ]);
    const memory = store.upsert('memory', 'check', {
      text: 'consistent input always',
      status: 'active',
    });
    await service.ensureEmbedded(memory);
    const ranked = await service.semanticRank('consistent input always', [memory]);
    // Same string in, same string out → cosine similarity ≈ 1.0
    expect(ranked[0]!.similarity).toBeCloseTo(1.0, 4);
  });
});
