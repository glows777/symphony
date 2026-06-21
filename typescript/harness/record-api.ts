#!/usr/bin/env bun
// record-api: capture normalized JSON-API fixtures from a *running Symphony*.
//
// Point it at the Elixir build (started with `--port`) to record the reference
// behavior. assert-parity.ts later replays the same requests against the TS
// build and diffs the normalized responses.
//
// Usage:
//   bun harness/record-api.ts [baseUrl]
//
// Environment:
//   SYMPHONY_BASE_URL        base URL of the running server (default http://127.0.0.1:4000)
//   SYMPHONY_WORKSPACE_ROOT  workspace root, redacted from response paths
//
// Routes (see lib/symphony_elixir_web/router.ex):
//   GET  /api/v1/state
//   POST /api/v1/refresh
//   GET  /api/v1/:issue_identifier

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { type NormalizeOptions, normalize } from "./normalize.ts";
import type { ApiFixture, ApiRequest } from "./types.ts";

const FIXTURE_DIR = join(import.meta.dir, "..", "test", "fixtures", "oracle", "api");

function normalizeOptions(): NormalizeOptions {
  const root = process.env.SYMPHONY_WORKSPACE_ROOT;
  return root ? { pathPrefixes: { [root]: "<WORKSPACE>" } } : {};
}

async function recordOne(
  baseUrl: string,
  name: string,
  request: ApiRequest,
  options: NormalizeOptions,
): Promise<ApiFixture> {
  const response = await fetch(new URL(request.path, baseUrl), { method: request.method });
  const text = await response.text();
  let body: unknown;
  try {
    body = normalize(JSON.parse(text), options);
  } catch {
    body = text;
  }
  return { name, request, response: { status: response.status, body } };
}

async function discoverIssueIdentifiers(baseUrl: string): Promise<string[]> {
  try {
    const res = await fetch(new URL("/api/v1/state", baseUrl));
    const state = (await res.json()) as { running?: { issue_identifier?: string }[] };
    return (state.running ?? [])
      .map((entry) => entry.issue_identifier)
      .filter((id): id is string => typeof id === "string");
  } catch {
    return [];
  }
}

async function main(): Promise<number> {
  const baseUrl = Bun.argv[2] ?? process.env.SYMPHONY_BASE_URL ?? "http://127.0.0.1:4000";
  const options = normalizeOptions();

  const requests: { name: string; request: ApiRequest }[] = [
    { name: "state", request: { method: "GET", path: "/api/v1/state" } },
    { name: "refresh", request: { method: "POST", path: "/api/v1/refresh" } },
    { name: "issue_not_found", request: { method: "GET", path: "/api/v1/SYM-DOES-NOT-EXIST" } },
    { name: "state_method_not_allowed", request: { method: "POST", path: "/api/v1/state" } },
  ];

  for (const id of await discoverIssueIdentifiers(baseUrl)) {
    requests.push({ name: `issue_${id}`, request: { method: "GET", path: `/api/v1/${id}` } });
  }

  await mkdir(FIXTURE_DIR, { recursive: true });
  for (const { name, request } of requests) {
    const fixture = await recordOne(baseUrl, name, request, options);
    await Bun.write(join(FIXTURE_DIR, `${name}.json`), `${JSON.stringify(fixture, null, 2)}\n`);
    console.log(
      `recorded ${name} -> ${request.method} ${request.path} (${fixture.response.status})`,
    );
  }
  return 0;
}

if (import.meta.main) {
  process.exit(await main());
}
