// Port of `symphony_elixir_web/live/dashboard_live.ex` + `components/layouts.ex`.
//
// Per the locked decision, Phoenix LiveView becomes server-rendered HTML + SSE:
// `GET /` renders the full dashboard from the Presenter payload, and a `GET
// /events` Server-Sent-Events stream (subscribed to ObservabilityPubSub) pushes
// a freshly rendered dashboard section whenever the orchestrator broadcasts an
// update. A tiny inline client swaps the section in — no Phoenix JS, no
// LiveSocket, no runtime-clock setInterval (the Elixir test refutes those).

import { broadcastUpdate, subscribe } from "./observability-pubsub.ts";
import { statePayload } from "./presenter.ts";
import type { SnapshotProvider } from "./presenter.ts";
import type { RequestHandler } from "./server.ts";
import { dashboardCssUrl, faviconUrl } from "./static-assets.ts";

type Json = Record<string, unknown>;

// ---- handlers --------------------------------------------------------------

export function makeDashboardHandler(
  provider: SnapshotProvider,
  snapshotTimeoutMs: number,
): RequestHandler {
  return async () => {
    const payload = await statePayload(provider, snapshotTimeoutMs);
    return new Response(renderPage(payload, new Date()), {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  };
}

// `GET /events`: an SSE stream that re-renders the dashboard section on each
// observability broadcast.
export function makeEventsHandler(
  provider: SnapshotProvider,
  snapshotTimeoutMs: number,
): RequestHandler {
  return () => {
    let unsubscribe: () => void = () => {};
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        const send = async (): Promise<void> => {
          const payload = await statePayload(provider, snapshotTimeoutMs);
          const section = renderDashboardSection(payload, new Date());
          controller.enqueue(encoder.encode(sseEvent("update", section)));
        };
        controller.enqueue(encoder.encode(": connected\n\n"));
        unsubscribe = subscribe(() => {
          void send();
        });
      },
      cancel() {
        unsubscribe();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      },
    });
  };
}

// Re-export so callers can trigger a broadcast (e.g. the orchestrator's
// notify_dashboard wiring) without importing the pubsub module directly.
export { broadcastUpdate };

function sseEvent(event: string, data: string): string {
  const lines = data.split("\n").map((line) => `data: ${line}`);
  return `event: ${event}\n${lines.join("\n")}\n\n`;
}

// ---- page shell (layouts.ex) -----------------------------------------------

export function renderPage(payload: Json, now: Date): string {
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Symphony Observability</title>
    <link rel="icon" type="image/png" sizes="128x128" href="${escapeAttr(faviconUrl())}" />
    <link rel="stylesheet" href="${escapeAttr(dashboardCssUrl())}" />
  </head>
  <body>
    <main class="app-shell" id="dashboard-root">
${renderDashboardSection(payload, now)}
    </main>
    <script>
      (function () {
        var source = new EventSource("/events");
        source.addEventListener("update", function (event) {
          var root = document.getElementById("dashboard-root");
          if (root) root.innerHTML = event.data;
        });
      })();
    </script>
  </body>
</html>
`;
}

// ---- dashboard section (DashboardLive.render) ------------------------------

export function renderDashboardSection(payload: Json, now: Date): string {
  return `<section class="dashboard-shell">
  ${heroCard()}
  ${payload.error ? errorCard(asObj(payload.error)) : dashboardBody(payload, now)}
</section>`;
}

function heroCard(): string {
  return `<header class="hero-card">
    <div class="hero-grid">
      <div>
        <p class="eyebrow">Symphony Observability</p>
        <h1 class="hero-title">Operations Dashboard</h1>
        <p class="hero-copy">Current state, retry pressure, token usage, and orchestration health for the active Symphony runtime.</p>
      </div>
      <div class="status-stack">
        <span class="status-badge status-badge-live"><span class="status-badge-dot"></span>Live</span>
        <span class="status-badge status-badge-offline"><span class="status-badge-dot"></span>Offline</span>
      </div>
    </div>
  </header>`;
}

function errorCard(error: Json): string {
  return `<section class="error-card">
    <h2 class="error-title">Snapshot unavailable</h2>
    <p class="error-copy"><strong>${escapeHtml(str(error.code))}:</strong> ${escapeHtml(str(error.message))}</p>
  </section>`;
}

function dashboardBody(payload: Json, now: Date): string {
  const counts = asObj(payload.counts);
  const totals = asObj(payload.codex_totals);
  const running = asArr(payload.running);
  const blocked = asArr(payload.blocked);
  const retrying = asArr(payload.retrying);

  return `${metricGrid(counts, totals, payload, now)}
  ${rateLimitsSection(payload.rate_limits)}
  ${runningSection(running, now)}
  ${blockedSection(blocked)}
  ${retrySection(retrying)}`;
}

function metricGrid(counts: Json, totals: Json, payload: Json, now: Date): string {
  return `<section class="metric-grid">
    ${metricCard("Running", String(counts.running ?? 0), "Active issue sessions in the current runtime.")}
    ${metricCard("Retrying", String(counts.retrying ?? 0), "Issues waiting for the next retry window.")}
    ${metricCard("Blocked", String(counts.blocked ?? 0), "Issues paused for operator input or approval.")}
    ${metricCard(
      "Total tokens",
      formatInt(totals.total_tokens),
      `In ${formatInt(totals.input_tokens)} / Out ${formatInt(totals.output_tokens)}`,
      "numeric",
    )}
    ${metricCard(
      "Runtime",
      formatRuntimeSeconds(totalRuntimeSeconds(payload, now)),
      "Total Codex runtime across completed and active sessions.",
    )}
  </section>`;
}

function metricCard(label: string, value: string, detail: string, detailClass = ""): string {
  const detailCls = detailClass ? `metric-detail ${detailClass}` : "metric-detail";
  return `<article class="metric-card">
      <p class="metric-label">${escapeHtml(label)}</p>
      <p class="metric-value numeric">${escapeHtml(value)}</p>
      <p class="${detailCls}">${escapeHtml(detail)}</p>
    </article>`;
}

function rateLimitsSection(rateLimits: unknown): string {
  return `<section class="section-card">
    <div class="section-header"><div>
      <h2 class="section-title">Rate limits</h2>
      <p class="section-copy">Latest upstream rate-limit snapshot, when available.</p>
    </div></div>
    <pre class="code-panel">${escapeHtml(prettyValue(rateLimits))}</pre>
  </section>`;
}

function runningSection(running: Json[], now: Date): string {
  const body =
    running.length === 0
      ? `<p class="empty-state">No active sessions.</p>`
      : `<div class="table-wrap"><table class="data-table data-table-running">
        <thead><tr><th>Issue</th><th>State</th><th>Session</th><th>Runtime / turns</th><th>Codex update</th><th>Tokens</th></tr></thead>
        <tbody>${running.map((entry) => runningRow(entry, now)).join("")}</tbody>
      </table></div>`;
  return section(
    "Running sessions",
    "Active issues, last known agent activity, and token usage.",
    body,
  );
}

function runningRow(entry: Json, now: Date): string {
  const tokens = asObj(entry.tokens);
  return `<tr>
    <td><div class="issue-stack">${issueIdentifier(str(entry.issue_identifier), entry.issue_url)}${jsonDetailsLink(str(entry.issue_identifier))}</div></td>
    <td><span class="${stateBadgeClass(str(entry.state))}">${escapeHtml(str(entry.state))}</span></td>
    <td><div class="session-stack">${sessionCell(entry.session_id)}</div></td>
    <td class="numeric">${escapeHtml(formatRuntimeAndTurns(entry.started_at, entry.turn_count, now))}</td>
    <td>${eventCell(entry)}</td>
    <td><div class="token-stack numeric"><span>Total: ${escapeHtml(formatInt(tokens.total_tokens))}</span><span class="muted">In ${escapeHtml(formatInt(tokens.input_tokens))} / Out ${escapeHtml(formatInt(tokens.output_tokens))}</span></div></td>
  </tr>`;
}

function blockedSection(blocked: Json[]): string {
  const body =
    blocked.length === 0
      ? `<p class="empty-state">No blocked sessions.</p>`
      : `<div class="table-wrap"><table class="data-table" style="min-width: 760px;">
        <thead><tr><th>Issue</th><th>State</th><th>Session</th><th>Blocked at</th><th>Last update</th><th>Error</th></tr></thead>
        <tbody>${blocked.map(blockedRow).join("")}</tbody>
      </table></div>`;
  return section(
    "Blocked sessions",
    "Issues paused because Codex requested operator input or approval.",
    body,
  );
}

function blockedRow(entry: Json): string {
  const state = str(entry.state) || "Blocked";
  return `<tr>
    <td><div class="issue-stack">${issueIdentifier(str(entry.issue_identifier), entry.issue_url)}${jsonDetailsLink(str(entry.issue_identifier))}</div></td>
    <td><span class="${stateBadgeClass(state)}">${escapeHtml(state)}</span></td>
    <td>${sessionCell(entry.session_id)}</td>
    <td class="mono">${escapeHtml(str(entry.blocked_at) || "n/a")}</td>
    <td>${eventCell(entry)}</td>
    <td>${escapeHtml(str(entry.error) || "n/a")}</td>
  </tr>`;
}

function retrySection(retrying: Json[]): string {
  const body =
    retrying.length === 0
      ? `<p class="empty-state">No issues are currently backing off.</p>`
      : `<div class="table-wrap"><table class="data-table" style="min-width: 680px;">
        <thead><tr><th>Issue</th><th>Attempt</th><th>Due at</th><th>Error</th></tr></thead>
        <tbody>${retrying.map(retryRow).join("")}</tbody>
      </table></div>`;
  return section("Retry queue", "Issues waiting for the next retry window.", body);
}

function retryRow(entry: Json): string {
  return `<tr>
    <td><div class="issue-stack">${issueIdentifier(str(entry.issue_identifier), entry.issue_url)}${jsonDetailsLink(str(entry.issue_identifier))}</div></td>
    <td>${escapeHtml(String(entry.attempt ?? ""))}</td>
    <td class="mono">${escapeHtml(str(entry.due_at) || "n/a")}</td>
    <td>${escapeHtml(str(entry.error) || "n/a")}</td>
  </tr>`;
}

function section(title: string, copy: string, body: string): string {
  return `<section class="section-card">
    <div class="section-header"><div>
      <h2 class="section-title">${escapeHtml(title)}</h2>
      <p class="section-copy">${escapeHtml(copy)}</p>
    </div></div>
    ${body}
  </section>`;
}

function eventCell(entry: Json): string {
  const lastMessage = str(entry.last_message);
  const lastEvent = str(entry.last_event);
  const text = lastMessage || lastEvent || "n/a";
  const meta = lastEvent || "n/a";
  const at = str(entry.last_event_at);
  const atFragment = at ? ` · <span class="mono numeric">${escapeHtml(at)}</span>` : "";
  return `<div class="detail-stack">
      <span class="event-text" title="${escapeAttr(text)}">${escapeHtml(text)}</span>
      <span class="muted event-meta">${escapeHtml(meta)}${atFragment}</span>
    </div>`;
}

function sessionCell(sessionId: unknown): string {
  const id = str(sessionId);
  if (id === "") {
    return `<span class="muted">n/a</span>`;
  }
  return `<button type="button" class="subtle-button" data-label="Copy ID" data-copy="${escapeAttr(id)}" onclick="navigator.clipboard.writeText(this.dataset.copy); this.textContent = 'Copied'; clearTimeout(this._copyTimer); this._copyTimer = setTimeout(() => { this.textContent = this.dataset.label }, 1200);">Copy ID</button>`;
}

function jsonDetailsLink(identifier: string): string {
  return `<a class="issue-link" href="/api/v1/${escapeAttr(identifier)}">JSON details</a>`;
}

function issueIdentifier(identifier: string, url: unknown): string {
  const href = externalIssueUrl(url);
  if (href !== null) {
    return `<a class="issue-id issue-id-link" href="${escapeAttr(href)}" target="_blank" rel="noopener noreferrer" aria-label="Open ${escapeAttr(identifier)} in the issue tracker">${escapeHtml(identifier)}</a>`;
  }
  return `<span class="issue-id">${escapeHtml(identifier)}</span>`;
}

// ---- helpers (DashboardLive private fns) -----------------------------------

function externalIssueUrl(url: unknown): string | null {
  if (typeof url !== "string") {
    return null;
  }
  const trimmed = url.trim();
  try {
    const parsed = new URL(trimmed);
    if ((parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.host !== "") {
      return trimmed;
    }
  } catch {
    return null;
  }
  return null;
}

function completedRuntimeSeconds(payload: Json): number {
  const totals = asObj(payload.codex_totals);
  return typeof totals.seconds_running === "number" ? totals.seconds_running : 0;
}

function totalRuntimeSeconds(payload: Json, now: Date): number {
  return asArr(payload.running).reduce(
    (total, entry) => total + runtimeSecondsFromStartedAt(entry.started_at, now),
    completedRuntimeSeconds(payload),
  );
}

function formatRuntimeAndTurns(startedAt: unknown, turnCount: unknown, now: Date): string {
  const runtime = formatRuntimeSeconds(runtimeSecondsFromStartedAt(startedAt, now));
  if (typeof turnCount === "number" && Number.isInteger(turnCount) && turnCount > 0) {
    return `${runtime} / ${turnCount}`;
  }
  return runtime;
}

function formatRuntimeSeconds(seconds: number): string {
  const whole = Math.max(Math.trunc(seconds), 0);
  return `${Math.floor(whole / 60)}m ${whole % 60}s`;
}

function runtimeSecondsFromStartedAt(startedAt: unknown, now: Date): number {
  if (typeof startedAt !== "string") {
    return startedAt instanceof Date ? Math.floor((now.getTime() - startedAt.getTime()) / 1000) : 0;
  }
  const parsed = new Date(startedAt);
  if (Number.isNaN(parsed.getTime())) {
    return 0;
  }
  return Math.floor((now.getTime() - parsed.getTime()) / 1000);
}

function formatInt(value: unknown): string {
  if (typeof value === "number" && Number.isInteger(value)) {
    return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  }
  return "n/a";
}

function stateBadgeClass(state: unknown): string {
  const base = "state-badge";
  const normalized = String(state ?? "").toLowerCase();
  if (containsAny(normalized, ["progress", "running", "active"])) {
    return `${base} state-badge-active`;
  }
  if (containsAny(normalized, ["blocked", "error", "failed"])) {
    return `${base} state-badge-danger`;
  }
  if (containsAny(normalized, ["todo", "queued", "pending", "retry"])) {
    return `${base} state-badge-warning`;
  }
  return base;
}

function containsAny(value: string, needles: string[]): boolean {
  return needles.some((needle) => value.includes(needle));
}

function prettyValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "n/a";
  }
  return JSON.stringify(value, null, 2);
}

// ---- small accessors / escaping --------------------------------------------

function asObj(value: unknown): Json {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Json)
    : {};
}

function asArr(value: unknown): Json[] {
  return Array.isArray(value) ? (value as Json[]) : [];
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(value: string): string {
  return escapeHtml(value);
}
