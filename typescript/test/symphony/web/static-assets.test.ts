import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  dashboardCssUrl,
  faviconUrl,
  fetchAsset,
  serveStaticAsset,
} from "../../../src/symphony/web/static-assets.ts";

const STATIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../priv/static");

// Translated from the embedded-asset assertions in extensions_test.exs (the
// dashboard.css / favicon.png serving). The vendored Phoenix JS routes are
// dropped in the SSE port and are not covered.
describe("StaticAssets", () => {
  test("exposes content-addressed asset URLs", () => {
    expect(dashboardCssUrl()).toMatch(/^\/dashboard\.css\?v=[0-9a-f]{12}$/);
    expect(faviconUrl()).toMatch(/^\/favicon\.png\?v=[0-9a-f]{12}$/);
  });

  test("serves the dashboard stylesheet", async () => {
    const res = serveStaticAsset(new Request("http://127.0.0.1/dashboard.css"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/css; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000");
    const css = await res.text();
    expect(css).toContain(":root {");
    expect(css).toContain(".status-badge-live");
    expect(css).toContain("text-decoration-thickness: 1px");
  });

  test("serves the favicon bytes", async () => {
    const res = serveStaticAsset(new Request("http://127.0.0.1/favicon.png"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png; charset=utf-8");
    const expected = fs.readFileSync(path.join(STATIC_DIR, "favicon.png"));
    const body = new Uint8Array(await res.arrayBuffer());
    expect(body).toEqual(new Uint8Array(expected));
  });

  test("returns null / 404 for unknown assets", () => {
    expect(fetchAsset("/vendor/phoenix/phoenix.js")).toBeNull();
    const res = serveStaticAsset(new Request("http://127.0.0.1/nope.css"));
    expect(res.status).toBe(404);
  });
});
