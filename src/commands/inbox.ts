import { loadConfig } from "../config.js";
import { DendriteIndex } from "../pipeline/index.js";

export async function runInbox(opts: { config?: string }): Promise<void> {
  const { config } = loadConfig(opts.config);
  const index = new DendriteIndex(config.index.db_path);
  const items = index.listInboxNotes();
  if (!items.length) {
    console.log("Inbox is empty.");
  } else {
    for (const item of items) {
      console.log(`- ${item.title} (${item.path})`);
    }
  }
  index.close();
}
