// Shared config helpers for tracker plugins. The `$VAR` reference and secret
// resolution semantics were extracted from config/schema.ts so every plugin's
// finalize pass resolves environment values identically; the cast helper
// mirrors the changeset `field` semantics (absent -> fallback; invalid ->
// `${section}.${key} <message>` error + fallback).

import type { JsonMap } from "../config/schema.ts";
import type { PluginFieldError } from "./types.ts";

export function envOrNull(name: string): string | null {
  const value = process.env[name];
  return value === undefined ? null : value;
}

// Resolves a secret-ish setting: `$VAR` references are expanded, absent values
// fall back to the canonical env variable, and empty strings normalize to null.
export function resolveSecretSetting(value: string | null, fallback: string | null): string | null {
  if (value === null) {
    return normalizeSecretValue(fallback);
  }
  const resolved = resolveEnvValue(value, fallback);
  return typeof resolved === "string" ? normalizeSecretValue(resolved) : resolved;
}

export function resolveEnvValue(value: string, fallback: string | null): string | null {
  const envName = envReferenceName(value);
  if (envName === null) {
    return value;
  }
  const envValue = process.env[envName];
  if (envValue === undefined) {
    return fallback;
  }
  if (envValue === "") {
    return null;
  }
  return envValue;
}

export function envReferenceName(value: string): string | null {
  if (!value.startsWith("$")) {
    return null;
  }
  const name = value.slice(1);
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : null;
}

function normalizeSecretValue(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  return value === "" ? null : value;
}

// Casts one optional string field out of a raw plugin config section.
export function castPluginString(
  raw: JsonMap,
  key: string,
  section: string,
  fallback: string | null,
  errors: PluginFieldError[],
): string | null {
  if (!(key in raw)) {
    return fallback;
  }
  const value = raw[key];
  if (typeof value === "string") {
    return value;
  }
  errors.push({ path: `${section}.${key}`, message: "is invalid" });
  return fallback;
}
