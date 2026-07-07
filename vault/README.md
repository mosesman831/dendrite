# Starter vault

This folder is a minimal example Obsidian vault layout for Dendrite. Point `vault.path` in config here (default: `./vault`).

On first `dendrite ingest` or `dendrite serve`, Dendrite writes structured notes under `brain/<compartment>/`.

Runtime files land in `brain/_dendrite/` (catalog, import archives). You can gitignore that folder in your own vault if you prefer.
