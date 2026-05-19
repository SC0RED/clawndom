/**
 * Test-only embedding provider.
 *
 * Hashes word tokens (FNV-1a) into a 32-dim bag-of-words space.
 * Deterministic across runs, distinguishes inputs with disjoint
 * vocabulary, and overlaps inputs that share words — exactly what
 * EntityEmbeddingService tests need without pulling in a real model.
 *
 * Lives in tests/helpers/ to avoid duplicating the implementation
 * across each test file that needs an embedder (SonarQube duplication
 * gate).
 */
export class DeterministicEmbedder {
  readonly name = 'test-embedder';
  readonly dimensions = 32;

  async embed(text: string): Promise<number[]> {
    const vector = new Array<number>(this.dimensions).fill(0);
    const words = text.toLowerCase().split(/\W+/).filter(Boolean);
    for (const word of words) {
      let hash = 0x811c9dc5;
      for (let index = 0; index < word.length; index++) {
        hash ^= word.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193) >>> 0;
      }
      const bucket = hash % this.dimensions;
      vector[bucket]! += 1;
    }
    const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
    if (magnitude === 0) return vector;
    return vector.map((value) => value / magnitude);
  }
}
