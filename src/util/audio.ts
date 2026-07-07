import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, unlinkSync } from "node:fs";
import { join, extname } from "node:path";

const exec = promisify(execFile);

/** Convert audio to 16kHz mono WAV for maximum STT compatibility. */
export async function ensureWav(audioPath: string): Promise<{ path: string; cleanup: () => void }> {
  const ext = extname(audioPath).toLowerCase();
  if (ext === ".wav") {
    return { path: audioPath, cleanup: () => {} };
  }

  const outPath = audioPath.replace(/\.[^.]+$/, "") + ".wav";
  try {
    await exec("ffmpeg", [
      "-y",
      "-i",
      audioPath,
      "-ar",
      "16000",
      "-ac",
      "1",
      "-c:a",
      "pcm_s16le",
      outPath,
    ]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`ffmpeg conversion failed (install ffmpeg): ${msg}`);
  }

  if (!existsSync(outPath)) {
    throw new Error("ffmpeg did not produce output WAV");
  }

  return {
    path: outPath,
    cleanup: () => {
      try {
        unlinkSync(outPath);
      } catch {
        /* ignore */
      }
    },
  };
}
