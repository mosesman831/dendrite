import { z } from "zod";

/** Single OpenAI-compatible endpoint (LLM or STT base). */
export const EndpointSchema = z.object({
  baseURL: z.string().url(),
  model: z.string().optional(),
  apiKeyEnv: z.string().optional(),
});

export type EndpointConfig = z.infer<typeof EndpointSchema>;

export const LlmBlockSchema = z.union([
  EndpointSchema,
  z.object({
    primary: EndpointSchema,
    fallback: EndpointSchema.optional(),
  }),
]);

const SttBlockSchema = z.object({
  provider: z
    .enum(["openai-audio", "nvidia-nim", "nvidia-riva-grpc", "whisper-cpp"])
    .default("openai-audio"),
  /** HTTP only: NVCF invocation URL or local NIM :9000 */
  baseURL: z.string().url().optional(),
  /** gRPC only: NVCF function UUID */
  function_id: z.string().optional(),
  /** gRPC only: default grpc.nvcf.nvidia.com:443 */
  server: z.string().optional(),
  model: z.string().optional(),
  language: z.string().optional(),
  word_time_offsets: z.boolean().optional(),
  apiKeyEnv: z.string().optional(),
  binPath: z.string().optional(),
});

export type SttConfig = z.infer<typeof SttBlockSchema>;

export interface LlmEndpoints {
  primary: EndpointConfig & { model: string };
  fallback?: EndpointConfig & { model: string };
}

export function parseLlmBlock(raw: z.infer<typeof LlmBlockSchema>): LlmEndpoints {
  if ("primary" in raw) {
    if (!raw.primary.model) throw new Error("providers.llm.primary.model is required");
    const primary = { ...raw.primary, model: raw.primary.model };
    const fallback = raw.fallback?.model ? { ...raw.fallback, model: raw.fallback.model } : undefined;
    return { primary, fallback };
  }
  if (!raw.model) throw new Error("providers.llm.model is required");
  return { primary: { baseURL: raw.baseURL, model: raw.model, apiKeyEnv: raw.apiKeyEnv } };
}

export { SttBlockSchema };
