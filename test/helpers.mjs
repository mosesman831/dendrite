import { mkdtempSync, rmSync, mkdirSync, writeFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const dist = (p) => import(join(ROOT, "dist", p));

/** Temp workspace with a vault, compartments.yaml, and a config file. */
export function makeWorkspace(extraYaml = "") {
  const dir = mkdtempSync(join(tmpdir(), "dendrite-test-"));
  mkdirSync(join(dir, "vault", "brain"), { recursive: true });
  cpSync(join(ROOT, "compartments.yaml"), join(dir, "compartments.yaml"));
  const configPath = join(dir, "dendrite.config.yaml");
  writeFileSync(
    configPath,
    `vault:
  path: ./vault
  compartments_file: compartments.yaml
  timezone: UTC
providers:
  llm:
    primary:
      baseURL: http://127.0.0.1:9/v1
      model: none
      apiKeyEnv: NONE
  stt:
    provider: openai-audio
    baseURL: http://127.0.0.1:9/v1
    model: none
    apiKeyEnv: NONE
classification:
  confidence: {}
inputs: {}
index:
  db_path: ./index.db
${extraYaml}`,
  );
  return { dir, configPath, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
