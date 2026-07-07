import { loadConfig } from "../config.js";
import { DendriteIndex } from "../pipeline/index.js";
import { undoCapture, resolveUndoTarget } from "../pipeline/remove.js";

export async function runRemove(opts: {
  config?: string;
  last?: boolean;
  id?: string;
  note?: string;
}): Promise<void> {
  const { config } = loadConfig(opts.config);
  const index = new DendriteIndex(config.index.db_path);

  try {
    const parentId = resolveUndoTarget(index, {
      last: opts.last,
      id: opts.id,
      note: opts.note,
    });
    const result = undoCapture(config.vault.path, index, parentId, config);
    console.log(JSON.stringify(result, null, 2));
    const actions = result.results.map((r) => `${r.action}: ${r.notePath}`).join("\n");
    console.log(`\nUndone capture ${parentId}:\n${actions}`);
  } finally {
    index.close();
  }
}
