import OpenAI from "openai";
import type { EndpointConfig } from "./types.js";
import { resolveApiKey } from "../config.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatProvider {
  complete(opts: {
    messages: ChatMessage[];
    temperature?: number;
    jsonMode?: boolean;
  }): Promise<string>;
}

function createClient(endpoint: EndpointConfig & { model: string }): OpenAI {
  const apiKey = resolveApiKey(endpoint.apiKeyEnv, false);
  return new OpenAI({
    baseURL: endpoint.baseURL,
    apiKey: apiKey || "not-needed",
  });
}

async function completeWithEndpoint(
  endpoint: EndpointConfig & { model: string },
  opts: { messages: ChatMessage[]; temperature?: number; jsonMode?: boolean },
): Promise<string> {
  const client = createClient(endpoint);
  const resp = await client.chat.completions.create({
    model: endpoint.model,
    messages: opts.messages,
    temperature: opts.temperature ?? 0,
    response_format: opts.jsonMode ? { type: "json_object" } : undefined,
  });
  const content = resp.choices[0]?.message?.content;
  if (!content) throw new Error("Empty LLM response");
  return content;
}

export function createChatProvider(endpoints: {
  primary: EndpointConfig & { model: string };
  fallback?: EndpointConfig & { model: string };
}): ChatProvider {
  return {
    async complete(opts) {
      try {
        return await completeWithEndpoint(endpoints.primary, opts);
      } catch (primaryErr) {
        if (!endpoints.fallback) throw primaryErr;
        try {
          return await completeWithEndpoint(endpoints.fallback, opts);
        } catch (fallbackErr) {
          const p = primaryErr instanceof Error ? primaryErr.message : String(primaryErr);
          const f = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
          throw new Error(`LLM failed (primary: ${p}; fallback: ${f})`);
        }
      }
    },
  };
}

export async function testChatEndpoint(
  endpoint: EndpointConfig & { model: string },
): Promise<boolean> {
  const out = await completeWithEndpoint(endpoint, {
    messages: [{ role: "user", content: 'Reply with JSON: {"ok":true}' }],
    jsonMode: true,
  });
  return out.includes("ok");
}
