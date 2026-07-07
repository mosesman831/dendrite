import { mkdirSync, existsSync, writeFileSync, copyFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");

async function askEndpoint(
  rl: ReturnType<typeof createInterface>,
  label: string,
  defaults: { baseURL: string; model: string; apiKeyEnv: string },
): Promise<{ baseURL: string; model: string; apiKeyEnv: string }> {
  console.log(`\n${label}`);
  const baseURL = (await rl.question(`  baseURL [${defaults.baseURL}]: `)).trim() || defaults.baseURL;
  const model = (await rl.question(`  model [${defaults.model}]: `)).trim() || defaults.model;
  const keyHint = defaults.apiKeyEnv === "NONE" ? "NONE" : defaults.apiKeyEnv;
  const apiKeyEnv =
    (await rl.question(`  apiKeyEnv (env var name, or NONE) [${keyHint}]: `)).trim() || keyHint;
  return { baseURL, model, apiKeyEnv };
}

export async function runInit(): Promise<void> {
  const rl = createInterface({ input, output });
  console.log("Dendrite setup wizard\n");

  const vaultPath = await rl.question("Vault path [./vault]: ");
  const resolvedVault = vaultPath.trim() || "./vault";
  mkdirSync(resolvedVault, { recursive: true });

  console.log("\n--- LLM (classification) ---");
  console.log("Preset: 1) NVIDIA NIM  2) OpenAI  3) Custom");
  const llmPreset = (await rl.question("Choose [1]: ")).trim() || "1";

  let primaryDefaults = {
    baseURL: "https://integrate.api.nvidia.com/v1",
    model: "meta/llama-3.1-8b-instruct",
    apiKeyEnv: "NVIDIA_API_KEY",
  };
  if (llmPreset === "2") {
    primaryDefaults = {
      baseURL: "https://api.openai.com/v1",
      model: "gpt-4o-mini",
      apiKeyEnv: "OPENAI_API_KEY",
    };
  } else if (llmPreset === "3") {
    primaryDefaults = { baseURL: "http://localhost:11434/v1", model: "llama3.1", apiKeyEnv: "NONE" };
  }

  const llmPrimary = await askEndpoint(rl, "LLM primary endpoint", primaryDefaults);

  const useFallback = (await rl.question("Configure LLM fallback endpoint? [y/N]: "))
    .toLowerCase()
    .startsWith("y");
  let llmFallback: { baseURL: string; model: string; apiKeyEnv: string } | undefined;
  if (useFallback) {
    llmFallback = await askEndpoint(rl, "LLM fallback endpoint", {
      baseURL: "https://api.openai.com/v1",
      model: "gpt-4o-mini",
      apiKeyEnv: "OPENAI_API_KEY",
    });
  }

  console.log("\n--- STT (voice transcription) ---");
  console.log("Provider: 1) NVIDIA NIM Speech  2) OpenAI Whisper  3) whisper.cpp (local)");
  const sttChoice = (await rl.question("Choose [1]: ")).trim() || "1";

  let sttYaml: string;
  if (sttChoice === "2") {
    sttYaml = `  stt:
    provider: openai-audio
    baseURL: https://api.openai.com/v1
    model: whisper-1
    apiKeyEnv: OPENAI_API_KEY`;
  } else if (sttChoice === "3") {
    const bin = (await rl.question("whisper binary path [/usr/local/bin/whisper]: ")).trim();
    sttYaml = `  stt:
    provider: whisper-cpp
    model: base.en
    binPath: ${bin || "/usr/local/bin/whisper"}`;
  } else {
    const sttUrl =
      (await rl.question(
        "NVIDIA STT baseURL (NVCF or local) [https://YOUR-ID.invocation.api.nvcf.nvidia.com]: ",
      )).trim() || "https://YOUR-ID.invocation.api.nvcf.nvidia.com";
    const lang = (await rl.question("Language [en-US]: ")).trim() || "en-US";
    const sttKey = (await rl.question("apiKeyEnv [NVIDIA_API_KEY]: ")).trim() || "NVIDIA_API_KEY";
    sttYaml = `  stt:
    provider: nvidia-nim
    baseURL: ${sttUrl}
    language: ${lang}
    word_time_offsets: false
    apiKeyEnv: ${sttKey}`;
  }

  const enableTg = (await rl.question("\nEnable Telegram bot? [y/N]: ")).toLowerCase().startsWith("y");
  let tgBlock = "    enabled: false\n    tokenEnv: TELEGRAM_BOT_TOKEN\n    allowed_user_ids: []";
  if (enableTg) {
    const uid = await rl.question("Your Telegram user ID: ");
    tgBlock = `    enabled: true\n    tokenEnv: TELEGRAM_BOT_TOKEN\n    allowed_user_ids: [${uid.trim()}]`;
  }

  const fallbackBlock = llmFallback
    ? `    fallback:
      baseURL: ${llmFallback.baseURL}
      model: ${llmFallback.model}
      apiKeyEnv: ${llmFallback.apiKeyEnv}`
    : "";

  const configYaml = `vault:
  path: ${resolvedVault}
  compartments_file: compartments.yaml
  timezone: UTC

providers:
  llm:
    primary:
      baseURL: ${llmPrimary.baseURL}
      model: ${llmPrimary.model}
      apiKeyEnv: ${llmPrimary.apiKeyEnv}
${fallbackBlock}
${sttYaml}

classification:
  temperature: 0
  strong_match_threshold: 0.72
  weak_match_threshold: 0.45
  confidence:
    silent_above: 0.75
    confirm_below: 0.5
  split:
    enabled: true
    bias: conservative
    max_segments: 5
    min_segment_confidence: 0.5
    short_circuit_chars: 140
    min_coverage: 0.70

inputs:
  telegram:
${tgBlock}
  webhook:
    enabled: false
    port: 8787
    tokenEnv: DENDRITE_WEBHOOK_TOKEN
  daily_prompt:
    enabled: true
    cron: "0 21 * * *"
    skip_if_dumps_gte: 3

pattern_engine:
  cron: "0 9 * * MON"
  recurrence_min_count: 4

index:
  db_path: ~/.local/share/dendrite/index.db
  sync_mode: scheduled
  reindex_cron: "0 4 * * *"

organization: folders
tasks:
  render: frontmatter
queue:
  durable: true
  max_concurrency: 2
  max_retries: 5
voice:
  keep_audio: false
replies:
  mode: silent_high
`;

  const cwd = process.cwd();
  const configPath = join(cwd, "dendrite.config.yaml");
  writeFileSync(configPath, configYaml);

  const compSrc = join(ROOT, "compartments.yaml");
  const compDst = join(cwd, "compartments.yaml");
  if (!existsSync(compDst) && existsSync(compSrc)) {
    copyFileSync(compSrc, compDst);
  }

  const envLines = [`${llmPrimary.apiKeyEnv}=your-key-here`];
  if (llmFallback?.apiKeyEnv && llmFallback.apiKeyEnv !== "NONE") {
    envLines.push(`${llmFallback.apiKeyEnv}=your-fallback-key`);
  }
  if (sttChoice === "1" && sttYaml.includes("NVIDIA_API_KEY")) {
    envLines.push("NVIDIA_API_KEY=your-nim-key");
  }
  if (sttChoice === "2") envLines.push("OPENAI_API_KEY=your-openai-key");
  if (enableTg) envLines.push("TELEGRAM_BOT_TOKEN=your-bot-token");
  writeFileSync(join(cwd, ".env.example"), `# Dendrite environment variables\n${envLines.join("\n")}\n`);

  console.log(`\nWrote ${configPath}`);
  console.log("Copy .env.example to .env and fill in your API keys.");
  console.log("Then run: dendrite doctor");
  rl.close();
}
