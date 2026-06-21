import { afterEach, describe, expect, test } from "bun:test";
import {
  broadcastUpdate,
  resetForTest,
  setAvailableForTest,
  subscribe,
} from "../../../src/symphony/web/observability-pubsub.ts";

// Translated from observability_pubsub_test.exs.
describe("ObservabilityPubSub", () => {
  afterEach(() => {
    resetForTest();
  });

  test("subscribe and broadcast_update deliver dashboard updates", () => {
    let received = 0;
    const unsubscribe = subscribe(() => {
      received += 1;
    });

    broadcastUpdate();
    expect(received).toBe(1);

    unsubscribe();
    broadcastUpdate();
    expect(received).toBe(1);
  });

  test("broadcast_update is a no-op when pubsub is unavailable", () => {
    let received = 0;
    subscribe(() => {
      received += 1;
    });

    setAvailableForTest(false);
    expect(() => broadcastUpdate()).not.toThrow();
    expect(received).toBe(0);
  });
});
