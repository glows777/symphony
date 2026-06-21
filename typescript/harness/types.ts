// Fixture schemas for the differential oracle.
//
// The oracle records reference behavior from the Elixir build and asserts the
// TypeScript build reproduces it. Two kinds of fixtures are captured:
//
//  1. JSON-API fixtures  — HTTP request/response pairs from the observability API
//                          (`/api/v1/state`, `/api/v1/<id>`, `/api/v1/refresh`).
//  2. Codex transcripts  — the newline-delimited JSON-RPC 2.0 traffic between
//                          Symphony and `codex app-server`, captured by codex-tee.
//
// See harness/README.md for the record/replay workflow.

/** A recorded HTTP request against the observability API. */
export interface ApiRequest {
  readonly method: string;
  readonly path: string;
}

/** A recorded HTTP response, with the body already normalized (see normalize.ts). */
export interface ApiResponse {
  readonly status: number;
  readonly body: unknown;
}

/** One JSON-API fixture: a request and its normalized response. */
export interface ApiFixture {
  readonly name: string;
  readonly request: ApiRequest;
  readonly response: ApiResponse;
}

/** Which side of the Codex stdio channel a message came from. */
export type TranscriptSide = "symphony" | "codex";

/**
 * One line of Codex stdio traffic. `message` holds parsed JSON for well-formed
 * JSON-RPC lines; `raw` holds the original text for anything that did not parse
 * (e.g. interleaved log output).
 */
export interface TranscriptEntry {
  readonly seq: number;
  readonly from: TranscriptSide;
  readonly message?: unknown;
  readonly raw?: string;
}

/** A full Codex session transcript. */
export interface CodexTranscript {
  readonly name: string;
  readonly entries: readonly TranscriptEntry[];
}
