#!/usr/bin/env bun
// Entry point. Port of lib/symphony_elixir/cli.ex — implemented in Phase 6.
// This is a scaffold stub; orchestration logic has not been ported yet.

export function main(_argv: string[]): number {
  console.error("symphony: not yet implemented (TypeScript port in progress; see MIGRATION.md)");
  return 1;
}

if (import.meta.main) {
  process.exit(main(Bun.argv.slice(2)));
}
