// Literal port of `symphony_elixir_web/observability_pubsub.ex`.
//
// PubSub helpers for observability dashboard updates. Per the OTP→TS rulebook,
// `Phoenix.PubSub` becomes a typed in-process emitter: `subscribe/1` registers a
// listener (returning an unsubscribe handle) and `broadcast_update/0` fans the
// `:observability_updated` message out to every listener. `broadcast_update` is
// a no-op when the pubsub is unavailable, mirroring the `Process.whereis` guard.

export type UpdateListener = () => void;

const listeners = new Set<UpdateListener>();
let available = true;

// `subscribe/0`: registers the listener; the returned function unsubscribes.
export function subscribe(listener: UpdateListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// `broadcast_update/0`: notifies subscribers, or a no-op when pubsub is down.
export function broadcastUpdate(): void {
  if (!available) {
    return;
  }
  for (const listener of [...listeners]) {
    listener();
  }
}

// ---- test seams ------------------------------------------------------------

// Mirrors terminating/restarting the `SymphonyElixir.PubSub` supervisor child.
export function setAvailableForTest(value: boolean): void {
  available = value;
}

export function resetForTest(): void {
  listeners.clear();
  available = true;
}
