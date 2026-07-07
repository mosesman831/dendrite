import { createReadStream, existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import OpenAI from "openai";
import type { DendriteConfig } from "../config.js";
import { resolveApiKey } from "../config.js";
import type { SttConfig } from "./types.js";
import { ensureWav } from "../util/audio.js";

const exec = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export interface Transcriber {
  transcribe(audioPath: string): Promise<string>;
}

export function createTranscriber(config: DendriteConfig): Transcriber {
  const stt = config.providers.stt as SttConfig;

  switch (stt.provider) {
    case "openai-audio":
      return wrapWithWavConversion(createOpenAiTranscriber(stt));
    case "nvidia-nim":
      return wrapWithWavConversion(createNvidiaHttpTranscriber(stt));
    case "nvidia-riva-grpc":
      return wrapWithWavConversion(createNvidiaGrpcTranscriber(stt));
    case "whisper-cpp":
      return createWhisperCppTranscriber(stt);
    default:
      throw new Error(`Unknown STT provider: ${stt.provider}`);
  }
}

/** Telegram sends OGG/Opus — convert to 16kHz mono WAV before STT. */
function wrapWithWavConversion(inner: Transcriber): Transcriber {
  return {
    async transcribe(audioPath: string) {
      const { path, cleanup } = await ensureWav(audioPath);
      try {
        return await inner.transcribe(path);
      } finally {
        cleanup();
      }
    },
  };
}

function createOpenAiTranscriber(stt: SttConfig): Transcriber {
  if (!stt.baseURL || !stt.model) {
    throw new Error("STT openai-audio requires baseURL and model");
  }
  const apiKey = resolveApiKey(stt.apiKeyEnv, false);
  const client = new OpenAI({ baseURL: stt.baseURL, apiKey: apiKey || "not-needed" });
  return {
    async transcribe(audioPath: string) {
      if (!existsSync(audioPath)) throw new Error(`Audio not found: ${audioPath}`);
      const resp = await client.audio.transcriptions.create({
        file: createReadStream(audioPath) as unknown as File,
        model: stt.model!,
      });
      return resp.text;
    },
  };
}

/** NVIDIA NVCF HTTP — POST /v1/audio/transcriptions */
function createNvidiaHttpTranscriber(stt: SttConfig): Transcriber {
  if (!stt.baseURL) {
    throw new Error("STT nvidia-nim requires baseURL (NVCF invocation URL or local :9000)");
  }
  const base = stt.baseURL.replace(/\/$/, "");
  const language = stt.language ?? "en-US";

  return {
    async transcribe(audioPath: string) {
      if (!existsSync(audioPath)) throw new Error(`Audio not found: ${audioPath}`);

      const data = readFileSync(audioPath);
      const form = new FormData();
      form.append("file", new File([data], basename(audioPath)));
      form.append("language", language);
      if (stt.model) form.append("model", stt.model);
      if (stt.word_time_offsets) form.append("word_time_offsets", "True");
      form.append("response_format", "json");

      const headers: Record<string, string> = {};
      const apiKey = resolveApiKey(stt.apiKeyEnv, false);
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

      const resp = await fetch(`${base}/v1/audio/transcriptions`, {
        method: "POST",
        headers,
        body: form,
      });

      if (!resp.ok) {
        const body = await resp.text();
        throw new Error(`NVIDIA HTTP STT ${resp.status}: ${body.slice(0, 500)}`);
      }

      const json = (await resp.json()) as { text?: string };
      if (!json.text) throw new Error("NVIDIA HTTP STT returned empty transcript");
      return json.text;
    },
  };
}

/** NVIDIA NVCF gRPC — recommended for cloud (parakeet-ctc via Riva client). */
function createNvidiaGrpcTranscriber(stt: SttConfig): Transcriber {
  if (!stt.function_id) {
    throw new Error("STT nvidia-riva-grpc requires function_id");
  }
  const server = stt.server ?? "grpc.nvcf.nvidia.com:443";
  const language = stt.language ?? "en-US";
  const apiKeyEnv = stt.apiKeyEnv ?? "NVIDIA_API_KEY";
  const scriptPath = join(ROOT, "scripts", "nvidia_stt_grpc.py");
  const venvPython = join(ROOT, ".venv-stt", "bin", "python3");
  const pythonBin = existsSync(venvPython) ? venvPython : "python3";

  return {
    async transcribe(audioPath: string) {
      if (!existsSync(audioPath)) throw new Error(`Audio not found: ${audioPath}`);
      if (!existsSync(scriptPath)) throw new Error(`STT script missing: ${scriptPath}`);

      const apiKey = resolveApiKey(apiKeyEnv, true);
      const env = { ...process.env, [apiKeyEnv]: apiKey };

      try {
        const { stdout, stderr } = await exec(
          pythonBin,
          [
            scriptPath,
            "--server",
            server,
            "--function-id",
            stt.function_id!,
            "--audio",
            audioPath,
            "--language",
            language,
            "--api-key-env",
            apiKeyEnv,
          ],
          { env, maxBuffer: 10 * 1024 * 1024 },
        );
        const text = stdout.trim();
        if (!text && stderr) throw new Error(stderr.trim());
        if (!text) throw new Error("NVIDIA gRPC STT returned empty transcript");
        return text;
      } catch (err: unknown) {
        const e = err as { stderr?: string; message?: string };
        const detail = e.stderr?.trim() || e.message || String(err);
        if (detail.includes("No module named 'riva'")) {
          throw new Error(
            "nvidia-riva-client not installed. Run: python3 -m venv .venv-stt && .venv-stt/bin/pip install -r requirements-stt.txt",
          );
        }
        throw new Error(`NVIDIA gRPC STT failed: ${detail.slice(0, 600)}`);
      }
    },
  };
}

function createWhisperCppTranscriber(stt: SttConfig): Transcriber {
  const bin = stt.binPath ?? "whisper";
  const model = stt.model ?? "base.en";
  return {
    async transcribe(audioPath: string) {
      const { stdout } = await exec(bin, ["-m", model, "-f", audioPath, "--output-txt"]);
      return stdout.trim();
    },
  };
}
