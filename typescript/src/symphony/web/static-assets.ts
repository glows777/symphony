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
const FRONTEND_DIST = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../frontend/dist",
);

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
  const frontend = fetchFrontendAsset(pathname);
  if (frontend !== null) {
    return new Response(frontend.body, {
      status: 200,
      headers: {
        "content-type": frontend.contentType,
        "cache-control": pathname === "/index.html" ? "no-cache" : "public, max-age=31536000",
      },
    });
  }
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

export function serveFrontendApp(req: Request): Response | null {
  const asset = fetchFrontendAsset(
    new URL(req.url).pathname === "/" ? "/index.html" : new URL(req.url).pathname,
  );
  if (asset === null) {
    return null;
  }
  return new Response(asset.body, {
    status: 200,
    headers: {
      "content-type": asset.contentType,
      "cache-control": "no-cache",
    },
  });
}

function fetchFrontendAsset(assetPath: string): { contentType: string; body: Uint8Array } | null {
  const relative = assetPath === "/" ? "index.html" : assetPath.replace(/^\/+/, "");
  const resolved = path.resolve(FRONTEND_DIST, relative);
  const root = path.resolve(FRONTEND_DIST);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    return null;
  }
  try {
    if (!fs.statSync(resolved).isFile()) {
      return null;
    }
    return {
      body: new Uint8Array(fs.readFileSync(resolved)),
      contentType: frontendContentType(resolved),
    };
  } catch {
    return null;
  }
}

function frontendContentType(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".woff2":
      return "font/woff2";
    default:
      return "application/octet-stream";
  }
}
