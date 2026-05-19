import type { Entity, EntityStore } from './entity-store.service';

/**
 * Pluggable text→vector embedder. Mirrors `EmbeddingProvider` from
 * the memory subsystem so the same OpenAI / null-fake / future-local
 * implementations can back both stores. We don't import that interface
 * directly to keep entities decoupled from the memory namespace's
 * configuration shape; a thin adapter wires them together at server
 * boot.
 */
export interface EntityEmbeddingProvider {
  readonly name: string;
  readonly dimensions: number;
  embed(text: string): Promise<number[]>;
}

export interface VectorizableEntity {
  kind: string;
  textProperty: string;
}

/**
 * Per-kind configuration of which property carries the embedding text.
 * Workspaces declare this on the kind schema (e.g. memory.text,
 * interaction.inbound_text). Kinds not listed here aren't embedded.
 */
export type VectorizableConfig = ReadonlyArray<VectorizableEntity>;

export interface EmbeddingHit {
  entity: Entity;
  similarity: number;
}

const FLOAT_BYTES = 4;

function encodeVector(vector: number[]): Buffer {
  const buffer = Buffer.allocUnsafe(vector.length * FLOAT_BYTES);
  for (let index = 0; index < vector.length; index++) {
    const value = vector[index];
    if (value === undefined) {
      throw new Error(`vector index ${index} is undefined`);
    }
    buffer.writeFloatLE(value, index * FLOAT_BYTES);
  }
  return buffer;
}

function decodeVector(buffer: Buffer, expectedDimensions: number): number[] {
  if (buffer.byteLength % FLOAT_BYTES !== 0) {
    throw new Error(
      `embedding blob byteLength ${buffer.byteLength} is not a multiple of ${FLOAT_BYTES}`,
    );
  }
  const length = buffer.byteLength / FLOAT_BYTES;
  if (length !== expectedDimensions) {
    throw new Error(`embedding blob has ${length} dims but provider expects ${expectedDimensions}`);
  }
  const result = new Array<number>(length);
  for (let index = 0; index < length; index++) {
    result[index] = buffer.readFloatLE(index * FLOAT_BYTES);
  }
  return result;
}

function computeCosineSimilarity(left: number[], right: number[]): number {
  if (left.length !== right.length) {
    throw new Error(`vector length mismatch: ${left.length} vs ${right.length}`);
  }
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index++) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dot += leftValue * rightValue;
    leftMagnitude += leftValue * leftValue;
    rightMagnitude += rightValue * rightValue;
  }
  if (leftMagnitude === 0 || rightMagnitude === 0) return 0;
  return dot / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude));
}

interface EmbeddingRow {
  entity_id: string;
  model_name: string;
  dimensions: number;
  vector: Buffer;
  embedded_at: number;
}

export class EntityEmbeddingService {
  private vectorizableByKind: Map<string, string>;

  constructor(
    private store: EntityStore,
    private provider: EntityEmbeddingProvider,
    vectorizable: VectorizableConfig,
  ) {
    this.vectorizableByKind = new Map(
      vectorizable.map((entry) => [entry.kind, entry.textProperty]),
    );
  }

  /**
   * Generate + persist the embedding for an entity if its kind is
   * vectorizable AND the configured text property has content.
   * Best-effort: throwing from here propagates to the caller; callers
   * that want fire-and-forget semantics (worker hooks) should wrap
   * accordingly.
   */
  async ensureEmbedded(entity: Entity): Promise<void> {
    const textProperty = this.vectorizableByKind.get(entity.kind);
    if (textProperty === undefined) return;
    const rawText = entity.properties[textProperty];
    if (typeof rawText !== 'string' || rawText.trim() === '') return;
    const vector = await this.provider.embed(rawText);
    this.persistEmbedding(entity.id, vector);
  }

  /**
   * Re-rank a candidate entity list by semantic similarity to the
   * provided query. Only entities with stored embeddings participate;
   * un-embedded entities are returned with similarity 0 at the tail
   * so the caller can decide whether to drop them or keep them.
   */
  async semanticRank(query: string, candidates: ReadonlyArray<Entity>): Promise<EmbeddingHit[]> {
    if (candidates.length === 0) return [];
    const queryVector = await this.provider.embed(query);
    const embeddings = this.loadEmbeddingsFor(candidates.map((entity) => entity.id));
    const hits: EmbeddingHit[] = candidates.map((entity) => {
      const stored = embeddings.get(entity.id);
      if (stored === undefined) return { entity, similarity: 0 };
      return { entity, similarity: computeCosineSimilarity(queryVector, stored) };
    });
    hits.sort((a, b) => b.similarity - a.similarity);
    return hits;
  }

  get providerName(): string {
    return this.provider.name;
  }

  private persistEmbedding(entityId: string, vector: number[]): void {
    const buffer = encodeVector(vector);
    this.store.database
      .prepare(
        `INSERT INTO entity_embeddings (entity_id, model_name, dimensions, vector, embedded_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(entity_id) DO UPDATE SET
           model_name = excluded.model_name,
           dimensions = excluded.dimensions,
           vector     = excluded.vector,
           embedded_at = excluded.embedded_at`,
      )
      .run(entityId, this.provider.name, this.provider.dimensions, buffer, Date.now());
  }

  private loadEmbeddingsFor(entityIds: ReadonlyArray<string>): Map<string, number[]> {
    if (entityIds.length === 0) return new Map();
    const placeholders = entityIds.map(() => '?').join(',');
    const rows = this.store.database
      .prepare<unknown[], EmbeddingRow>(
        `SELECT entity_id, model_name, dimensions, vector, embedded_at
         FROM entity_embeddings
         WHERE entity_id IN (${placeholders})
           AND model_name = ?`,
      )
      .all(...entityIds, this.provider.name);
    const out = new Map<string, number[]>();
    for (const row of rows) {
      out.set(row.entity_id, decodeVector(row.vector, this.provider.dimensions));
    }
    return out;
  }
}
