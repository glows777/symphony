// A small structural deep-diff used to report parity mismatches between recorded
// Elixir fixtures and TypeScript output. Both inputs should already be normalized.

export interface Difference {
  /** JSON-path-ish location of the difference, e.g. `counts.running`. */
  readonly path: string;
  readonly kind: "missing" | "extra" | "changed" | "type";
  readonly expected?: unknown;
  readonly actual?: unknown;
}

function kindOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function join(path: string, key: string | number): string {
  if (typeof key === "number") return `${path}[${key}]`;
  return path === "" ? key : `${path}.${key}`;
}

/**
 * Compare `expected` (the recorded fixture) against `actual` (TS output) and
 * return every difference. An empty array means they are structurally equal.
 */
export function diff(expected: unknown, actual: unknown, path = ""): Difference[] {
  const expectedKind = kindOf(expected);
  const actualKind = kindOf(actual);

  if (expectedKind !== actualKind) {
    return [{ path, kind: "type", expected, actual }];
  }

  if (expectedKind === "array") {
    const e = expected as unknown[];
    const a = actual as unknown[];
    const out: Difference[] = [];
    const len = Math.max(e.length, a.length);
    for (let i = 0; i < len; i++) {
      if (i >= e.length) {
        out.push({ path: join(path, i), kind: "extra", actual: a[i] });
      } else if (i >= a.length) {
        out.push({ path: join(path, i), kind: "missing", expected: e[i] });
      } else {
        out.push(...diff(e[i], a[i], join(path, i)));
      }
    }
    return out;
  }

  if (expectedKind === "object") {
    const e = expected as Record<string, unknown>;
    const a = actual as Record<string, unknown>;
    const out: Difference[] = [];
    for (const key of Object.keys(e)) {
      if (!(key in a)) {
        out.push({ path: join(path, key), kind: "missing", expected: e[key] });
      } else {
        out.push(...diff(e[key], a[key], join(path, key)));
      }
    }
    for (const key of Object.keys(a)) {
      if (!(key in e)) {
        out.push({ path: join(path, key), kind: "extra", actual: a[key] });
      }
    }
    return out;
  }

  if (expected !== actual) {
    return [{ path, kind: "changed", expected, actual }];
  }
  return [];
}

/** Render differences as a human-readable, multi-line report. */
export function formatDifferences(differences: readonly Difference[]): string {
  if (differences.length === 0) return "no differences";
  return differences
    .map((d) => {
      const at = d.path === "" ? "(root)" : d.path;
      switch (d.kind) {
        case "missing":
          return `  - ${at}: missing (expected ${JSON.stringify(d.expected)})`;
        case "extra":
          return `  + ${at}: unexpected (actual ${JSON.stringify(d.actual)})`;
        case "type":
        case "changed":
          return `  ~ ${at}: expected ${JSON.stringify(d.expected)}, got ${JSON.stringify(d.actual)}`;
      }
    })
    .join("\n");
}
