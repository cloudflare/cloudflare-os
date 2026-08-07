// Embedding generation via Workers AI @cf/qwen/qwen3-embedding-0.6b (1024 dims, cosine).
// Both indexing and query-time embedding go through this single helper so the model stays aligned
// with the Vectorize index dimensions.

export const EMBEDDING_MODEL = "@cf/qwen/qwen3-embedding-0.6b";
export const EMBEDDING_DIMENSIONS = 1024;

export type EmbeddingInput = { text: string; id?: string };

// Runs the embedding model over a batch of strings, returning an embedding array aligned with the
// input order. Tolerates a provider returning extra fields alongside the vectors.
export async function embedBatch(
  ai: Ai,
  inputs: EmbeddingInput[],
): Promise<number[][]> {
  const result = (await ai.run(EMBEDDING_MODEL, {
    text: inputs.map((i) => i.text),
  })) as { data: number[][]; shape?: number[] };
  const data = result.data;
  if (!Array.isArray(data) || data.length !== inputs.length) {
    throw new Error(
      `Embedding model returned ${Array.isArray(data) ? data.length : "no"} vectors for ` +
      `${inputs.length} inputs`,
    );
  }
  return data.map((vec) => {
    if (!Array.isArray(vec)) {
      throw new Error("Embedding model returned a malformed vector");
    }
    return vec;
  });
}

// Embeds a single text (used at query time). Returns a Float32Array (Vectorize accepts number[],
// Float32Array, or Float64Array).
export async function embedQuery(ai: Ai, text: string): Promise<Float32Array> {
  const [vec] = await embedBatch(ai, [{ text }]);
  return Float32Array.from(vec);
}

// Rough token guard: ~4 chars/token is a safe upper bound for English + identifiers. The model's
// context window is 8192 tokens; we truncate well under that so batches behave predictably.
export const MAX_CHARS_PER_INPUT = 16_000;

export function truncateForEmbedding(text: string): string {
  if (text.length <= MAX_CHARS_PER_INPUT) return text;
  return text.slice(0, MAX_CHARS_PER_INPUT);
}
