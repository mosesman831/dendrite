import OpenAI from "openai";
import type { EmbeddingsConfig } from "../config.js";
import { resolveApiKey } from "../config.js";

export function createEmbeddingsClient(config: EmbeddingsConfig): OpenAI {
  const apiKey = resolveApiKey(config.apiKeyEnv, false);
  return new OpenAI({
    baseURL: config.baseURL,
    apiKey: apiKey || "not-needed",
  });
}

export async function embedTexts(
  texts: string[],
  config: EmbeddingsConfig,
): Promise<number[][]> {
  if (texts.length === 0) return [];
  const client = createEmbeddingsClient(config);
  const input = texts.map((t) => t.slice(0, 8000));
  const resp = await client.embeddings.create({
    model: config.model,
    input,
  });
  return resp.data
    .sort((a, b) => a.index - b.index)
    .map((d) => d.embedding as number[]);
}

export async function embedQuery(text: string, config: EmbeddingsConfig): Promise<number[]> {
  const [vec] = await embedTexts([text], config);
  if (!vec) throw new Error("Empty embedding response");
  return vec;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

export function vectorToBlob(vec: number[]): Buffer {
  const f32 = new Float32Array(vec);
  return Buffer.from(f32.buffer);
}

export function blobToVector(blob: Buffer): number[] {
  const f32 = new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
  return [...f32];
}

export async function testEmbeddingsEndpoint(config: EmbeddingsConfig): Promise<boolean> {
  const vecs = await embedTexts(["dendrite health check"], config);
  return vecs.length === 1 && vecs[0]!.length > 0;
}
