import type { EventRecord } from "./types.js";

export type EventListener = (e: EventRecord) => void;

/** In-process fan-out of newly committed events (SSE, future triggers). Listener errors are isolated. */
export class EventBus {
  private listeners = new Set<EventListener>();

  subscribe(fn: EventListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  get size(): number {
    return this.listeners.size;
  }

  publish(events: EventRecord[]): void {
    if (!this.listeners.size) return;
    for (const e of events)
      for (const fn of this.listeners) {
        try {
          fn(e);
        } catch {
          /* one bad subscriber must not break ingestion */
        }
      }
  }
}
