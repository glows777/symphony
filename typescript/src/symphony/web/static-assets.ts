// Literal port of `symphony_elixir_web/static_assets.ex` +
// `web/controllers/static_asset_controller.ex`.
//
// Serves the dashboard's embedded CSS and favicon with content-addressed
// (`?v=<digest>`) URLs. Elixir embeds the assets at compile time via
// `File.read!`; the TS port reads them from `priv/static` at module load. The
// vendored Phoenix JS assets are intentionally dropped — the TS dashboard
// replaces Phoenix LiveView with server-rendered HTML + SSE, so phoenix.js /
// phoenix_live_view.js / phoenix_html.js are not served.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const STATIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../priv/static");

type Asset = { contentType: string; body: Uint8Array; digest: string };

const dashboardCss = loadAsset("dashboard.css", "text/css; charset=utf-8");
const favicon = loadAsset("favicon.png", "image/png; charset=utf-8");

const ASSETS: Record<string, Asset> = {
  "/dashboard.css": dashboardCss,
  "/favicon.png": favicon,
};

function loadAsset(name: string, contentType: string): Asset {
  const body = fs.readFileSync(path.join(STATIC_DIR, name));
  const digest = createHash("sha256").update(body).digest("hex").slice(0, 12);
  return { contentType, body: new Uint8Array(body), digest };
}

// `dashboard_css_url/0`.
export function dashboardCssUrl(): string {
  return `/dashboard.css?v=${dashboardCss.digest}`;
}

// `favicon_url/0`.
export function faviconUrl(): string {
  return `/favicon.png?v=${favicon.digest}`;
}

// `fetch/1`: returns the asset for a path (ignoring any `?v=` query), or null.
export function fetchAsset(assetPath: string): { contentType: string; body: Uint8Array } | null {
  const asset = ASSETS[assetPath];
  if (asset === undefined) {
    return null;
  }
  return { contentType: asset.contentType, body: asset.body };
}

// `StaticAssetController.serve/2`: a request handler for the static routes.
export function serveStaticAsset(req: Request): Response {
  const { pathname } = new URL(req.url);
  const asset = fetchAsset(pathname);
  if (asset === null) {
    return new Response("Not Found", { status: 404 });
  }
  return new Response(asset.body, {
    status: 200,
    headers: {
      "content-type": asset.contentType,
      "cache-control": "public, max-age=31536000",
    },
  });
}
