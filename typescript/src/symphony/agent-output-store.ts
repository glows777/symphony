import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getEnv } from "./app-env.ts";
import { settingsBang } from "./config.ts";
import type { AgentOutputMode } from "./config/schema.ts";
import { defaultLogFile } from "./log-file.ts";
import { logger } from "./logger.ts";
import type { AgentMessage } from "./plugins/agents/types.ts";

const DEFAULT_MAX_EVENT_BYTES = 64 * 1024;
const DEFAULT_MAX_FILE_BYTES = 64 * 1024 * 1024;
const RECENT_EVENT_BUFFER_SIZE = 200;
const FINISHED_RUN_CACHE_SIZE = 256;
const MAX_PENDING_WRITES = 256;
const RUN_METADATA_SUFFIX = ".meta.json";

export type AgentOutputEvent = {
  seq: number;
  at: string;
  issue_id?: string;
  issue_identifier: string;
  title?: string;
  backend: string;
  worker_host: string;
  run_id: string;
  session_id?: string;
  turn?: number;
  stream?: "stdout" | "stderr";
  event: string;
  event_detail?: string;
  message?: string;
  chat_id?: string;
  chat_phase?: "start" | "delta" | "complete";
  chat_delta?: string;
  chat_delta_truncated?: boolean;
  activity_type?: AgentActivityType;
  activity_status?: AgentActivityStatus;
  activity_id?: string;
  parent_message_id?: string;
  thinking_summary_delta?: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_command?: string;
  tool_output_delta?: string;
  tool_error?: string;
  payload?: unknown;
  raw?: string;
  [key: string]: unknown;
};

export type AgentActivityType =
  | "assistant_message"
  | "thinking"
  | "tool_call"
  | "system"
  | "unknown";

export type AgentActivityStatus = "streaming" | "completed" | "failed";

export type AgentOutputMessage = {
  message_id: string;
  activity_id: string;
  activity_type: AgentActivityType;
  activity_status: AgentActivityStatus;
  issue_identifier: string;
  backend: string;
  run_id: string;
  session_id?: string;
  turn?: number;
  parent_message_id?: string;
  role?: "assistant";
  content: string;
  status: AgentActivityStatus;
  seq_start: number;
  seq_end: number;
  at: string;
  updated_at: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_command?: string;
  tool_output?: string;
  tool_error?: string;
};

export type AgentOutputRunMetadata = {
  issue_id: string | null;
  issue_identifier: string;
  title: string | null;
  backend: string;
  worker_host: string;
  run_id: string;
  session_id: string | null;
  path: string;
  size: number;
  started_at: string | null;
  ended_at: string | null;
  status: "running" | "completed" | "failed" | "cancelled";
  event_count: number;
  last_seq: number;
  truncated: boolean;
};

export type AgentOutputReadResult = {
  events: AgentOutputEvent[];
  messages: AgentOutputMessage[];
  nextCursor: number | null;
  hasMore: boolean;
  run: AgentOutputRunMetadata | null;
  error?: { code: string; message: string };
};

export type AgentOutputStoreOptions = {
  root: string;
  mode: AgentOutputMode;
  maxEventBytes?: number;
  maxFileBytes?: number;
};

export type StartAgentOutputRun = {
  issueId: string | null;
  issueIdentifier: string;
  title?: string | null;
  backend: string;
  workerHost: string | null;
  runId?: string;
};

export type AgentOutputListener = (event: AgentOutputEvent) => void;

type PersistedRun = {
  metadata: AgentOutputRunMetadata;
  seq: number;
  recent: AgentOutputEvent[];
  closed: boolean;
  startedEventWritten: boolean;
  fileBytes: number;
  malformed: boolean;
  mode: AgentOutputMode;
  maxEventBytes: number;
  maxFileBytes: number;
  writeChain: Promise<void>;
  pendingWrites: number;
  activeChatId: string | null;
  activeChatTurn: number | null;
  chatSequence: number;
  activeActivityIds: Map<string, string>;
  activitySequence: number;
};

export class AgentOutputRun {
  constructor(
    private readonly store: AgentOutputStore,
    private readonly state: PersistedRun,
  ) {}

  get runId(): string {
    return this.state.metadata.run_id;
  }

  bindRunId(runId: string | null | undefined): void {
    this.store.bindRunId(this.state, runId);
  }

  record(message: AgentMessage, turn: number, summary: string | null = null): void {
    this.store.recordMessage(this.state, message, turn, summary);
  }

  finish(status: "completed" | "failed" | "cancelled", reason: unknown = null): Promise<void> {
    return this.store.finishRun(this.state, status, reason);
  }

  metadata(): AgentOutputRunMetadata {
    return { ...this.state.metadata };
  }
}

export class AgentOutputStore {
  private agentsRoot: string;
  private mode: AgentOutputMode;
  private maxEventBytes: number;
  private maxFileBytes: number;
  private readonly knownAgentsRoots: Set<string>;
  private readonly runs = new Map<string, PersistedRun>();
  private readonly listeners = new Map<string, Set<AgentOutputListener>>();

  constructor(options: AgentOutputStoreOptions) {
    this.agentsRoot = path.join(path.resolve(options.root), "log", "agents");
    this.mode = options.mode;
    this.maxEventBytes = positiveOr(options.maxEventBytes, DEFAULT_MAX_EVENT_BYTES);
    this.maxFileBytes = positiveOr(options.maxFileBytes, DEFAULT_MAX_FILE_BYTES);
    this.knownAgentsRoots = new Set([this.agentsRoot]);
  }

  reconfigure(options: AgentOutputStoreOptions): void {
    const nextRoot = path.join(path.resolve(options.root), "log", "agents");
    this.knownAgentsRoots.add(nextRoot);
    this.agentsRoot = nextRoot;
    this.mode = options.mode;
    this.maxEventBytes = positiveOr(options.maxEventBytes, DEFAULT_MAX_EVENT_BYTES);
    this.maxFileBytes = positiveOr(options.maxFileBytes, DEFAULT_MAX_FILE_BYTES);
  }

  startRun(context: StartAgentOutputRun): AgentOutputRun {
    const runId = context.runId ?? `run-${Date.now()}-${crypto.randomUUID()}`;
    const issueIdentifier = context.issueIdentifier.trim() || "unknown-issue";
    const metadata: AgentOutputRunMetadata = {
      issue_id: context.issueId,
      issue_identifier: issueIdentifier,
      title: context.title ?? null,
      backend: context.backend,
      worker_host: context.workerHost ?? "local",
      run_id: runId,
      session_id: null,
      path: this.runPath(issueIdentifier, runId),
      size: 0,
      started_at: new Date().toISOString(),
      ended_at: null,
      status: "running",
      event_count: 0,
      last_seq: 0,
      truncated: false,
    };
    const state: PersistedRun = {
      metadata,
      seq: 0,
      recent: [],
      closed: false,
      startedEventWritten: false,
      fileBytes: 0,
      malformed: false,
      mode: this.mode,
      maxEventBytes: this.maxEventBytes,
      maxFileBytes: this.maxFileBytes,
      writeChain: Promise.resolve(),
      pendingWrites: 0,
      activeChatId: null,
      activeChatTurn: null,
      chatSequence: 0,
      activeActivityIds: new Map(),
      activitySequence: 0,
    };
    if (state.mode !== "off") {
      this.ensureUniqueRunPath(state);
      this.runs.set(metadata.path, state);
      this.pruneCachedRuns();
    }
    return new AgentOutputRun(this, state);
  }

  latestRun(issueIdentifier: string): AgentOutputRunMetadata | null {
    return this.runsForIssue(issueIdentifier)[0] ?? null;
  }

  bindRunId(state: PersistedRun, runId: string | null | undefined): void {
    if (state.mode === "off" || state.closed || typeof runId !== "string") {
      return;
    }
    const normalized = runId.trim();
    if (normalized === "" || normalized === state.metadata.run_id) {
      return;
    }
    // The runner binds the backend's stable session/run id before the first
    // event is written. Refuse a late rebind rather than leaving a JSONL file
    // whose path and event run_id disagree.
    if (state.startedEventWritten || state.fileBytes > 0) {
      logger.warning(
        `Agent output run id arrived after output started for ${state.metadata.issue_identifier}`,
      );
      return;
    }
    const previousPath = state.metadata.path;
    state.metadata.run_id = normalized;
    state.metadata.path = this.runPath(state.metadata.issue_identifier, normalized);
    this.ensureUniqueRunPath(state);
    this.runs.delete(previousPath);
    this.runs.set(state.metadata.path, state);
  }

  listRecentRuns(limit = 50): AgentOutputRunMetadata[] {
    const all = this.loadAllRunMetadata();
    return all
      .sort((left, right) => dateValue(right.started_at) - dateValue(left.started_at))
      .slice(0, Math.max(0, limit));
  }

  listRecentIssues(limit = 50): AgentOutputRunMetadata[] {
    const seen = new Set<string>();
    const latest: AgentOutputRunMetadata[] = [];
    for (const run of this.listRecentRuns(Math.max(limit * 3, limit))) {
      if (seen.has(run.issue_identifier)) {
        continue;
      }
      seen.add(run.issue_identifier);
      latest.push(run);
      if (latest.length >= limit) {
        break;
      }
    }
    return latest;
  }

  readIssueOutput(
    issueIdentifier: string,
    options: { limit?: number; after?: number | null } = {},
  ): AgentOutputReadResult {
    const run = this.latestRun(issueIdentifier);
    if (run === null) {
      return { events: [], messages: [], nextCursor: null, hasMore: false, run: null };
    }
    const loaded = this.loadRun(run.path, false);
    if (loaded === null) {
      const active = this.runs.get(run.path);
      if (active !== undefined && active.fileBytes === 0) {
        return {
          events: [],
          messages: [],
          nextCursor: null,
          hasMore: false,
          run: { ...active.metadata },
        };
      }
      return {
        events: [],
        messages: [],
        nextCursor: null,
        hasMore: false,
        run,
        error: { code: "log_read_failed", message: "Agent log could not be read" },
      };
    }
    const limit = clampLimit(options.limit);
    const after = options.after === null || options.after === undefined ? null : options.after;
    const ordered = loaded.events.sort((left, right) => left.seq - right.seq);
    const filtered = after === null ? ordered : ordered.filter((event) => event.seq > after);
    const hasMore = after === null ? filtered.length > limit : filtered.length > limit;
    const events = after === null ? filtered.slice(-limit) : filtered.slice(0, limit);
    const nextCursor = events.at(-1)?.seq ?? after;
    const result: AgentOutputReadResult = {
      events,
      messages: buildAgentOutputMessages(ordered, loaded.metadata.status),
      nextCursor: nextCursor ?? null,
      hasMore,
      run: loaded.metadata,
    };
    if (loaded.malformed) {
      result.error = {
        code: "log_corrupt",
        message: "Some lines in the agent log were not valid JSON",
      };
    }
    return result;
  }

  subscribe(
    issueIdentifier: string,
    listener: AgentOutputListener,
    runId?: string | null,
  ): () => void {
    const key = issueKey(issueIdentifier);
    const expectedRunId = typeof runId === "string" && runId.trim() !== "" ? runId : null;
    const filteredListener: AgentOutputListener = (event) => {
      if (expectedRunId !== null && event.run_id !== expectedRunId) {
        return;
      }
      listener(event);
    };
    const listeners = this.listeners.get(key) ?? new Set<AgentOutputListener>();
    listeners.add(filteredListener);
    this.listeners.set(key, listeners);
    return () => {
      listeners.delete(filteredListener);
      if (listeners.size === 0) {
        this.listeners.delete(key);
      }
    };
  }

  recordMessage(
    state: PersistedRun,
    message: AgentMessage,
    turn: number,
    summary: string | null,
  ): void {
    this.ensureStarted(state);
    const event = normalizeMessageEvent(message.event, message);
    const sessionId = typeof message.sessionId === "string" ? message.sessionId : null;
    if (sessionId !== null) {
      state.metadata.session_id = sessionId;
    }
    const value: Record<string, unknown> = {
      at: dateFromMessage(message.timestamp),
      issue_id: state.metadata.issue_id ?? undefined,
      issue_identifier: state.metadata.issue_identifier,
      backend: state.metadata.backend,
      worker_host: state.metadata.worker_host,
      run_id: state.metadata.run_id,
      session_id: sessionId ?? state.metadata.session_id ?? undefined,
      turn,
      stream: message.stream ?? undefined,
      event,
      event_detail: message.event,
      message: summary ?? genericSummary(message),
    };
    const chatFields = chatFieldsForMessage(state, message, turn);
    Object.assign(value, chatFields);
    Object.assign(value, activityFieldsForMessage(state, message, turn, event, chatFields));
    for (const key of ["reason", "decision", "answer"] as const) {
      const detail = message[key];
      if (detail !== undefined) {
        if (key === "reason" && state.mode !== "raw") {
          const sanitized = sanitizeReason(detail);
          if (sanitized !== undefined) {
            value[key] = sanitized;
          }
        } else {
          const bounded = boundValue(detail, Math.min(state.maxEventBytes, 8 * 1024));
          value[key] = bounded.value;
          if (bounded.truncated) {
            value[`${key}_truncated`] = true;
          }
        }
      }
    }
    if (state.mode === "raw") {
      if (message.payload !== undefined) {
        value.payload = message.payload;
      }
      if (typeof message.raw === "string") {
        value.raw = message.raw;
      }
    }
    this.append(state, value);
  }

  async finishRun(
    state: PersistedRun,
    status: "completed" | "failed" | "cancelled",
    reason: unknown,
  ): Promise<void> {
    if (state.closed) {
      return;
    }
    this.ensureStarted(state);
    state.metadata.status = status;
    state.metadata.ended_at = new Date().toISOString();
    if (state.mode !== "off") {
      const terminalReason =
        reason === null
          ? undefined
          : state.mode === "raw"
            ? boundValue(reason, Math.min(state.maxEventBytes, 8 * 1024)).value
            : sanitizeReason(reason);
      const event = this.append(state, {
        at: state.metadata.ended_at,
        issue_id: state.metadata.issue_id ?? undefined,
        issue_identifier: state.metadata.issue_identifier,
        backend: state.metadata.backend,
        worker_host: state.metadata.worker_host,
        run_id: state.metadata.run_id,
        session_id: state.metadata.session_id ?? undefined,
        event: status === "completed" ? "run_completed" : `run_${status}`,
        message: status === "completed" ? "Agent run completed" : `Agent run ${status}`,
        activity_type: "system",
        activity_status: status === "failed" ? "failed" : "completed",
        terminal: true,
        reason: terminalReason,
      });
      if (event !== null) {
        state.metadata.ended_at = event.at;
      }
    }
    state.closed = true;
    this.persistMetadata(state, true);
    this.pruneCachedRuns();
    await state.writeChain;
  }

  private ensureStarted(state: PersistedRun): void {
    if (state.mode === "off" || state.startedEventWritten) {
      return;
    }
    this.ensureUniqueRunPath(state);
    const event = this.append(state, {
      at: state.metadata.started_at ?? new Date().toISOString(),
      issue_id: state.metadata.issue_id ?? undefined,
      issue_identifier: state.metadata.issue_identifier,
      title: state.metadata.title ?? undefined,
      backend: state.metadata.backend,
      worker_host: state.metadata.worker_host,
      run_id: state.metadata.run_id,
      event: "run_started",
      message: "Agent run started",
      activity_type: "system",
      activity_status: "completed",
    });
    if (event !== null) {
      state.startedEventWritten = true;
    }
  }

  private ensureUniqueRunPath(state: PersistedRun): void {
    const occupied = this.runs.get(state.metadata.path);
    const onDisk =
      fs.existsSync(state.metadata.path) || fs.existsSync(metadataPath(state.metadata.path));
    if (state.fileBytes > 0 || ((occupied === undefined || occupied === state) && !onDisk)) {
      return;
    }
    const originalPath = state.metadata.path;
    const baseRunId = state.metadata.run_id;
    let suffix = 2;
    let candidateRunId = `${baseRunId}-${suffix}`;
    let candidatePath = this.runPath(state.metadata.issue_identifier, candidateRunId);
    while (this.runPathExists(candidatePath)) {
      suffix += 1;
      candidateRunId = `${baseRunId}-${suffix}`;
      candidatePath = this.runPath(state.metadata.issue_identifier, candidateRunId);
    }
    state.metadata.run_id = candidateRunId;
    state.metadata.path = candidatePath;
    if (this.runs.get(originalPath) === state) {
      this.runs.delete(originalPath);
      this.runs.set(candidatePath, state);
    }
    logger.warning(
      `Agent output run id already exists for ${state.metadata.issue_identifier}; using ${candidateRunId}`,
    );
  }

  private runPathExists(filePath: string): boolean {
    return (
      this.runs.has(filePath) || fs.existsSync(filePath) || fs.existsSync(metadataPath(filePath))
    );
  }

  private append(state: PersistedRun, input: Record<string, unknown>): AgentOutputEvent | null {
    if (state.mode === "off" || (state.metadata.truncated && input.terminal !== true)) {
      return null;
    }
    const event = this.boundedEvent(state, input);
    const line = `${JSON.stringify(event)}\n`;
    const lineBytes = Buffer.byteLength(line, "utf8");

    try {
      if (
        state.fileBytes + lineBytes > state.maxFileBytes ||
        (input.event !== "log_truncated" &&
          state.fileBytes + lineBytes + this.truncationMarkerBytes(state) > state.maxFileBytes)
      ) {
        if (state.metadata.truncated || input.terminal === true) {
          return null;
        }
        return this.appendTruncationMarker(state);
      }
      if (!this.queueWrite(state, state.metadata.path, line, input.terminal === true)) {
        return this.appendTruncationMarker(state);
      }
      state.fileBytes += lineBytes;
      state.metadata.size = state.fileBytes;
      state.metadata.event_count += 1;
      state.metadata.last_seq = event.seq;
      state.recent.push(event);
      if (state.recent.length > RECENT_EVENT_BUFFER_SIZE) {
        state.recent.shift();
      }
      this.notify(state.metadata.issue_identifier, event);
      return event;
    } catch (error) {
      logger.warning(
        `Agent output log write failed for ${state.metadata.issue_identifier}: ${inspect(error)}`,
      );
      return null;
    }
  }

  private appendTruncationMarker(state: PersistedRun): AgentOutputEvent | null {
    const marker = this.boundedEvent(state, {
      at: new Date().toISOString(),
      issue_id: state.metadata.issue_id ?? undefined,
      issue_identifier: state.metadata.issue_identifier,
      backend: state.metadata.backend,
      worker_host: state.metadata.worker_host,
      run_id: state.metadata.run_id,
      session_id: state.metadata.session_id ?? undefined,
      event: "log_truncated",
      message: "Agent output log reached its file size limit",
      activity_type: "system",
      activity_status: "completed",
      truncated: true,
      terminal: true,
    });
    const line = `${JSON.stringify(marker)}\n`;
    if (state.fileBytes + Buffer.byteLength(line, "utf8") > state.maxFileBytes) {
      state.metadata.truncated = true;
      logger.warning(`Agent output log reached its file size limit: ${state.metadata.path}`);
      return null;
    }
    try {
      this.queueWrite(state, state.metadata.path, line, true);
      state.fileBytes += Buffer.byteLength(line, "utf8");
      state.metadata.size = state.fileBytes;
      state.metadata.event_count += 1;
      state.metadata.last_seq = marker.seq;
      state.metadata.truncated = true;
      state.recent.push(marker);
      this.notify(state.metadata.issue_identifier, marker);
      logger.warning(`Agent output log reached its file size limit: ${state.metadata.path}`);
      return marker;
    } catch (error) {
      logger.warning(
        `Agent output log truncation marker failed for ${state.metadata.issue_identifier}: ${inspect(error)}`,
      );
      state.metadata.truncated = true;
      return null;
    }
  }

  private truncationMarkerBytes(state: PersistedRun): number {
    const marker = {
      seq: state.seq + 1,
      at: new Date().toISOString(),
      issue_id: state.metadata.issue_id ?? undefined,
      issue_identifier: state.metadata.issue_identifier,
      backend: state.metadata.backend,
      worker_host: state.metadata.worker_host,
      run_id: state.metadata.run_id,
      session_id: state.metadata.session_id ?? undefined,
      event: "log_truncated",
      message: "Agent output log reached its file size limit",
      activity_type: "system",
      activity_status: "completed",
      truncated: true,
      terminal: true,
    };
    return Buffer.byteLength(`${JSON.stringify(marker)}\n`, "utf8");
  }

  private boundedEvent(state: PersistedRun, input: Record<string, unknown>): AgentOutputEvent {
    const nextSeq = state.seq + 1;
    state.seq = nextSeq;
    const event: Record<string, unknown> = { seq: nextSeq, ...input };
    let payloadTruncated = false;
    let rawTruncated = false;
    if (event.payload !== undefined) {
      const bounded = boundValue(event.payload, state.maxEventBytes);
      event.payload = bounded.value;
      payloadTruncated = bounded.truncated;
    }
    if (typeof event.raw === "string") {
      const bounded = boundText(event.raw, state.maxEventBytes);
      event.raw = bounded.value;
      rawTruncated = bounded.truncated;
    }
    if (payloadTruncated) {
      event.payload_truncated = true;
    }
    if (rawTruncated) {
      event.raw_truncated = true;
    }
    let serialized = JSON.stringify(event);
    if (Buffer.byteLength(serialized, "utf8") > state.maxEventBytes) {
      event.payload = undefined;
      event.raw = undefined;
      event.event_truncated = true;
      if (typeof event.message === "string") {
        event.message = boundText(event.message, Math.floor(state.maxEventBytes / 4)).value;
      }
      serialized = JSON.stringify(event);
      if (Buffer.byteLength(serialized, "utf8") > state.maxEventBytes) {
        return {
          seq: nextSeq,
          at: String(event.at ?? new Date().toISOString()),
          issue_identifier: state.metadata.issue_identifier,
          backend: state.metadata.backend,
          worker_host: state.metadata.worker_host,
          run_id: state.metadata.run_id,
          event: String(event.event ?? "notification"),
          event_truncated: true,
        };
      }
    }
    return event as AgentOutputEvent;
  }

  private runsForIssue(issueIdentifier: string): AgentOutputRunMetadata[] {
    return this.loadAllRunMetadata()
      .filter((run) => run.issue_identifier === issueIdentifier)
      .sort((left, right) => dateValue(right.started_at) - dateValue(left.started_at));
  }

  private loadAllRunMetadata(): AgentOutputRunMetadata[] {
    const result: AgentOutputRunMetadata[] = [];
    for (const state of this.runs.values()) {
      result.push({ ...state.metadata });
    }
    for (const agentsRoot of this.knownAgentsRoots) {
      if (!fs.existsSync(agentsRoot)) {
        continue;
      }
      let issueDirs: fs.Dirent[] = [];
      try {
        issueDirs = fs.readdirSync(agentsRoot, { withFileTypes: true });
      } catch (error) {
        logger.warning(`Agent output log directory read failed: ${inspect(error)}`);
        continue;
      }
      for (const issueDir of issueDirs) {
        if (!issueDir.isDirectory()) {
          continue;
        }
        const issuePath = path.join(agentsRoot, issueDir.name);
        let files: fs.Dirent[] = [];
        try {
          files = fs.readdirSync(issuePath, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const file of files) {
          if (!file.isFile() || !file.name.endsWith(".jsonl")) {
            continue;
          }
          const filePath = path.join(issuePath, file.name);
          const indexed = this.readMetadataSidecar(filePath);
          if (indexed !== null) {
            result.push(indexed);
            continue;
          }
          const loaded = this.loadRun(filePath);
          if (loaded !== null) {
            result.push(loaded.metadata);
          }
        }
      }
    }
    return uniqueRuns(result);
  }

  private loadRun(
    filePath: string,
    useCache = true,
  ): { metadata: AgentOutputRunMetadata; events: AgentOutputEvent[]; malformed: boolean } | null {
    const cached = this.runs.get(filePath);
    if (useCache && cached !== undefined && cached.fileBytes > 0) {
      return {
        metadata: { ...cached.metadata },
        events: [...cached.recent],
        malformed: cached.malformed,
      };
    }
    let raw: string;
    let size = 0;
    try {
      raw = fs.readFileSync(filePath, "utf8");
      size = fs.statSync(filePath).size;
    } catch {
      if (cached !== undefined) {
        return {
          metadata: { ...cached.metadata },
          events: [...cached.recent],
          malformed: cached.malformed,
        };
      }
      return null;
    }
    const events: AgentOutputEvent[] = [];
    let malformed = false;
    for (const line of raw.split("\n")) {
      if (line.trim() === "") {
        continue;
      }
      try {
        const value = JSON.parse(line) as AgentOutputEvent;
        if (typeof value.seq === "number" && typeof value.event === "string") {
          events.push(value);
        } else {
          malformed = true;
        }
      } catch {
        malformed = true;
      }
    }
    const derivedMetadata = metadataFromEvents(filePath, size, events, malformed);
    const indexedMetadata = this.readMetadataSidecar(filePath, size);
    const metadata =
      indexedMetadata === null
        ? derivedMetadata
        : {
            ...indexedMetadata,
            size,
            event_count: Math.max(indexedMetadata.event_count, derivedMetadata.event_count),
            last_seq: Math.max(indexedMetadata.last_seq, derivedMetadata.last_seq),
            truncated: indexedMetadata.truncated || derivedMetadata.truncated,
          };
    if (cached !== undefined) {
      cached.seq = Math.max(cached.seq, derivedMetadata.last_seq);
      cached.fileBytes = Math.max(cached.fileBytes, size);
      cached.metadata.size = Math.max(cached.metadata.size, size);
      cached.metadata.event_count = Math.max(
        cached.metadata.event_count,
        derivedMetadata.event_count,
      );
      cached.metadata.last_seq = Math.max(cached.metadata.last_seq, derivedMetadata.last_seq);
      cached.metadata.truncated ||= metadata.truncated;
      cached.malformed ||= malformed;
      cached.recent = mergeEvents(cached.recent, events).slice(-RECENT_EVENT_BUFFER_SIZE);
      if (cached.metadata.status === "running" && metadata.status !== "running") {
        cached.metadata.status = metadata.status;
        cached.metadata.ended_at = metadata.ended_at;
        cached.closed = true;
      }
      return {
        metadata: { ...cached.metadata },
        events: mergeEvents(events, cached.recent),
        malformed: cached.malformed,
      };
    }
    const state: PersistedRun = {
      metadata,
      seq: events.reduce((max, event) => Math.max(max, event.seq), 0),
      recent: events.slice(-RECENT_EVENT_BUFFER_SIZE),
      closed: metadata.status !== "running",
      startedEventWritten: events.some((event) => event.event === "run_started"),
      fileBytes: size,
      malformed,
      mode: this.mode,
      maxEventBytes: this.maxEventBytes,
      maxFileBytes: this.maxFileBytes,
      writeChain: Promise.resolve(),
      pendingWrites: 0,
      activeChatId: null,
      activeChatTurn: null,
      chatSequence: 0,
      activeActivityIds: new Map(),
      activitySequence: 0,
    };
    this.runs.set(filePath, state);
    this.pruneCachedRuns();
    return { metadata: { ...metadata }, events, malformed };
  }

  private runPath(issueIdentifier: string, runId: string): string {
    return path.join(this.agentsRoot, safeSegment(issueIdentifier), `${safeSegment(runId)}.jsonl`);
  }

  private readMetadataSidecar(filePath: string, knownSize?: number): AgentOutputRunMetadata | null {
    let size = knownSize;
    try {
      size ??= fs.statSync(filePath).size;
      const value = JSON.parse(fs.readFileSync(metadataPath(filePath), "utf8")) as unknown;
      if (!isRecord(value) || !isRunMetadata(value)) {
        return null;
      }
      return { ...value, path: filePath, size } as AgentOutputRunMetadata;
    } catch {
      return null;
    }
  }

  private queueWrite(
    state: PersistedRun,
    filePath: string,
    contents: string,
    terminal = false,
  ): boolean {
    if (state.pendingWrites >= MAX_PENDING_WRITES && !terminal) {
      state.metadata.truncated = true;
      logger.warning(`Agent output write queue reached its limit: ${state.metadata.path}`);
      return false;
    }
    state.pendingWrites += 1;
    state.writeChain = state.writeChain
      .then(async () => {
        await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
        if (filePath.endsWith(RUN_METADATA_SUFFIX)) {
          await fs.promises.writeFile(filePath, contents, "utf8");
        } else {
          await fs.promises.appendFile(filePath, contents, "utf8");
        }
      })
      .catch((error) => {
        logger.warning(
          `Agent output log write failed for ${state.metadata.issue_identifier}: ${inspect(error)}`,
        );
      })
      .finally(() => {
        state.pendingWrites -= 1;
      });
    return true;
  }

  private persistMetadata(state: PersistedRun, terminal = false): void {
    if (state.mode === "off") {
      return;
    }
    this.queueWrite(
      state,
      metadataPath(state.metadata.path),
      `${JSON.stringify(state.metadata)}\n`,
      terminal,
    );
  }

  private notify(issueIdentifier: string, event: AgentOutputEvent): void {
    for (const listener of [...(this.listeners.get(issueKey(issueIdentifier)) ?? [])]) {
      try {
        listener(event);
      } catch (error) {
        logger.warning(`Agent output listener failed: ${inspect(error)}`);
      }
    }
  }

  private pruneCachedRuns(): void {
    if (this.runs.size <= FINISHED_RUN_CACHE_SIZE) {
      return;
    }
    for (const [key, state] of this.runs) {
      if (this.runs.size <= FINISHED_RUN_CACHE_SIZE) {
        break;
      }
      if (state.closed) {
        this.runs.delete(key);
      }
    }
  }
}

let configuredStore: AgentOutputStore | null = null;

export function getAgentOutputStore(): AgentOutputStore {
  const options = configuredOptions();
  if (configuredStore === null) {
    configuredStore = new AgentOutputStore(options);
  } else {
    configuredStore.reconfigure(options);
  }
  return configuredStore;
}

export function resetAgentOutputStoreForTest(): void {
  configuredStore = null;
}

function configuredOptions(): AgentOutputStoreOptions {
  const rootOverride = getEnv<string | null>("agent_output_root", null);
  // Keep isolated store usage consistent with the schema default when a
  // workflow is not available yet.
  let mode: AgentOutputMode = "summary";
  let maxEventBytes = DEFAULT_MAX_EVENT_BYTES;
  let maxFileBytes = DEFAULT_MAX_FILE_BYTES;
  try {
    const observability = settingsBang().observability;
    mode = observability.agentOutput;
    maxEventBytes = observability.agentOutputMaxEventBytes;
    maxFileBytes = observability.agentOutputMaxFileBytes;
  } catch {
    // The store is also used by isolated API tests before a workflow is loaded.
  }
  return {
    root: rootOverride ?? configuredLogsRoot(),
    mode,
    maxEventBytes,
    maxFileBytes,
  };
}

function configuredLogsRoot(): string {
  const configuredLogFile = getEnv<string>("log_file", defaultLogFile());
  const absolute = path.resolve(configuredLogFile);
  const parent = path.dirname(absolute);
  return path.basename(parent) === "log" ? path.dirname(parent) : parent;
}

function metadataFromEvents(
  filePath: string,
  size: number,
  events: AgentOutputEvent[],
  malformed: boolean,
): AgentOutputRunMetadata {
  const first = events[0] ?? null;
  const last = events.at(-1) ?? null;
  const status = statusFromEvent(last?.event);
  return {
    issue_id: stringOrNull(first?.issue_id),
    issue_identifier: stringOr(first?.issue_identifier, path.basename(path.dirname(filePath))),
    title: stringOrNull(first?.title),
    backend: stringOr(first?.backend, "unknown"),
    worker_host: stringOr(first?.worker_host, "local"),
    run_id: stringOr(first?.run_id, path.basename(filePath, ".jsonl")),
    session_id: stringOrNull(last?.session_id ?? first?.session_id),
    path: filePath,
    size,
    started_at: first?.at ?? null,
    ended_at: status === "running" ? null : (last?.at ?? null),
    status,
    event_count: events.length,
    last_seq: events.reduce((max, event) => Math.max(max, event.seq), 0),
    truncated:
      events.some((event) => event.truncated === true || event.event === "log_truncated") ||
      malformed,
  };
}

function statusFromEvent(event: string | undefined): AgentOutputRunMetadata["status"] {
  switch (event) {
    case "run_completed":
      return "completed";
    case "run_cancelled":
      return "cancelled";
    case "run_failed":
      return "failed";
    default:
      return "running";
  }
}

function normalizeMessageEvent(event: string, message: AgentMessage): string {
  if (event === "turn_ended_with_error") {
    const tag = findReasonTag(message);
    if (tag === "turn_timeout") {
      return "turn_timeout";
    }
    if (tag === "port_exit") {
      return "port_exit";
    }
    return "turn_failed";
  }
  if (
    event === "tool_call_completed" ||
    event === "tool_call_failed" ||
    event === "unsupported_tool_call"
  ) {
    return "tool_call";
  }
  return event;
}

function findReasonTag(message: AgentMessage): string | null {
  const candidates: unknown[] = [message.payload, message.reason, message.details];
  for (const value of candidates) {
    if (isRecord(value) && typeof value.tag === "string") {
      return value.tag;
    }
    if (isRecord(value) && isRecord(value.reason) && typeof value.reason.tag === "string") {
      return value.reason.tag;
    }
  }
  return null;
}

function genericSummary(message: AgentMessage): string {
  if (typeof message.raw === "string" && message.raw.trim() !== "") {
    return message.raw.trim().slice(0, 240);
  }
  if (isRecord(message.reason) && typeof message.reason.tag === "string") {
    return `${message.event.replaceAll("_", " ")} (${message.reason.tag})`;
  }
  if (typeof message.event === "string") {
    return message.event.replaceAll("_", " ");
  }
  return "Agent event";
}

type ChatPhase = "start" | "delta" | "complete";

type ChatProjection = {
  phase: ChatPhase;
  chatId: string | null;
  delta?: string;
};

type StoredChatEvent = ChatProjection & {
  source: "stored" | "legacy";
};

function chatFieldsForMessage(
  state: PersistedRun,
  message: AgentMessage,
  turn: number,
): Record<string, unknown> {
  const projection = extractChatProjection(message.payload);
  if (projection === null) {
    return {};
  }

  let chatId = projection.chatId;
  if (projection.phase === "start") {
    chatId = chatId ?? allocateChatId(state, turn);
    state.activeChatId = chatId;
    state.activeChatTurn = turn;
  } else if (projection.phase === "delta") {
    if (chatId === null && state.activeChatTurn === turn) {
      chatId = state.activeChatId;
    }
    chatId = chatId ?? allocateChatId(state, turn);
    state.activeChatId = chatId;
    state.activeChatTurn = turn;
  } else {
    if (chatId === null && state.activeChatTurn === turn) {
      chatId = state.activeChatId;
    }
    if (chatId === null) {
      return {};
    }
    if (state.activeChatId === chatId && state.activeChatTurn === turn) {
      state.activeChatId = null;
      state.activeChatTurn = null;
    }
  }

  const fields: Record<string, unknown> = {
    chat_id: chatId,
    chat_phase: projection.phase,
  };
  if (projection.delta !== undefined) {
    const bounded = boundText(projection.delta, Math.min(state.maxEventBytes, 16 * 1024));
    fields.chat_delta = bounded.value;
    if (bounded.truncated) {
      fields.chat_delta_truncated = true;
    }
  }
  return fields;
}

type ActivityPhase = "start" | "delta" | "complete" | "failed";

type ActivityProjection = {
  type: AgentActivityType;
  phase: ActivityPhase;
  rawId: string | null;
  parentMessageId: string | null;
  contentDelta?: string;
  toolName?: string;
  toolInput?: unknown;
  toolCommand?: string;
  toolOutputDelta?: string;
  toolError?: string;
};

function activityFieldsForMessage(
  state: PersistedRun,
  message: AgentMessage,
  turn: number,
  event: string,
  chatFields: Record<string, unknown>,
): Record<string, unknown> {
  const chatPhase = chatFields.chat_phase;
  if (
    (chatPhase === "start" || chatPhase === "delta" || chatPhase === "complete") &&
    typeof chatFields.chat_id === "string"
  ) {
    return {
      activity_type: "assistant_message",
      activity_status: chatPhase === "complete" ? "completed" : "streaming",
      activity_id: chatFields.chat_id,
      ...parentMessageField(message.payload),
    };
  }

  const projection = extractActivityProjection(message.payload, event, message.event, message);
  if (projection === null) {
    return {
      activity_type: fallbackActivityType(event, message.event, methodFromPayload(message.payload)),
      activity_status: activityStatusForEvent(event, message.event),
    };
  }

  const activityId = resolveActivityId(state, turn, projection);
  const status = activityStatusForProjection(projection);
  const fields: Record<string, unknown> = {
    activity_type: projection.type,
    activity_status: status,
    activity_id: activityId,
  };
  if (projection.parentMessageId !== null) {
    fields.parent_message_id = projection.parentMessageId;
  }
  if (projection.type === "thinking" && projection.contentDelta !== undefined) {
    fields.thinking_summary_delta = projection.contentDelta;
  }
  if (projection.type === "tool_call") {
    if (projection.toolName !== undefined) {
      fields.tool_name = projection.toolName;
    }
    if (projection.toolInput !== undefined) {
      fields.tool_input = projection.toolInput;
    }
    if (projection.toolCommand !== undefined) {
      fields.tool_command = projection.toolCommand;
    }
    if (projection.toolOutputDelta !== undefined) {
      fields.tool_output_delta = projection.toolOutputDelta;
    }
    if (projection.toolError !== undefined) {
      fields.tool_error = projection.toolError;
    }
  }
  return fields;
}

function extractActivityProjection(
  payload: unknown,
  event: string,
  eventDetail: string,
  message: AgentMessage,
): ActivityProjection | null {
  const method = methodFromPayload(payload);
  const lifecycle = lifecyclePhase(method);
  const itemType = firstStringAtPaths(payload, itemTypePaths());
  const rawId = firstIdAtPaths(payload, activityIdPaths());
  const parentMessageId = firstIdAtPaths(payload, parentMessageIdPaths());

  if (method !== null && lifecycle !== null) {
    if (isReasoningType(itemType)) {
      return {
        type: "thinking",
        phase: lifecycle,
        rawId,
        parentMessageId,
      };
    }
    if (isToolItemType(itemType)) {
      return {
        type: "tool_call",
        phase: lifecycle,
        rawId,
        parentMessageId,
        ...toolMetadata(payload, message),
      };
    }
  }

  if (method !== null && isReasoningMethod(method)) {
    return {
      type: "thinking",
      phase: methodCompletionPhase(method),
      rawId,
      parentMessageId,
      ...reasoningSummaryDelta(payload, method),
    };
  }

  if (isToolActivity(method, event, eventDetail)) {
    return {
      type: "tool_call",
      phase: toolPhase(method, eventDetail),
      rawId,
      parentMessageId,
      ...toolMetadata(payload, message),
    };
  }

  return null;
}

function resolveActivityId(
  state: PersistedRun,
  turn: number,
  projection: ActivityProjection,
): string {
  if (projection.rawId !== null) {
    const scopedRawId = `${projection.type}:${turn}:${projection.rawId}`;
    if (projection.phase === "complete" || projection.phase === "failed") {
      state.activeActivityIds.delete(scopedRawId);
    } else {
      state.activeActivityIds.set(scopedRawId, projection.rawId);
    }
    return projection.rawId;
  }

  const activeScope = `${projection.type}:${turn}:active`;
  let activityId = state.activeActivityIds.get(activeScope);
  if (activityId === undefined) {
    state.activitySequence += 1;
    activityId = `${state.metadata.run_id}:turn-${turn}:${activityPrefix(projection.type)}-${state.activitySequence}`;
    state.activeActivityIds.set(activeScope, activityId);
  }
  if (projection.phase === "complete" || projection.phase === "failed") {
    state.activeActivityIds.delete(activeScope);
  }
  return activityId;
}

function activityPrefix(type: AgentActivityType): string {
  switch (type) {
    case "assistant_message":
      return "assistant";
    case "thinking":
      return "thinking";
    case "tool_call":
      return "tool";
    case "system":
      return "system";
    case "unknown":
      return "unknown";
  }
}

function activityStatusForProjection(projection: ActivityProjection): AgentActivityStatus {
  if (projection.phase === "failed") {
    return "failed";
  }
  return projection.phase === "complete" ? "completed" : "streaming";
}

function fallbackActivityType(
  event: string,
  eventDetail: string,
  method: string | null,
): AgentActivityType {
  if (isSystemEvent(event, eventDetail, method)) {
    return "system";
  }
  return "unknown";
}

function activityStatusForEvent(event: string, eventDetail: string): AgentActivityStatus {
  if (
    event.includes("failed") ||
    event.includes("timeout") ||
    event === "port_exit" ||
    eventDetail.includes("failed")
  ) {
    return "failed";
  }
  return "completed";
}

function isSystemEvent(event: string, eventDetail: string, method: string | null): boolean {
  if (
    event.startsWith("run_") ||
    event.startsWith("turn_") ||
    event.startsWith("approval_") ||
    event === "session_started" ||
    event === "startup_failed" ||
    event === "tool_input_auto_answered" ||
    event === "log_truncated"
  ) {
    return true;
  }
  if (eventDetail.startsWith("turn_") || eventDetail.startsWith("approval_")) {
    return true;
  }
  return method !== null && (method.startsWith("turn/") || method.startsWith("thread/"));
}

function lifecyclePhase(method: string | null): ActivityPhase | null {
  if (method === "item/started" || method?.endsWith("item_started")) {
    return "start";
  }
  if (method === "item/completed" || method?.endsWith("item_completed")) {
    return "complete";
  }
  return null;
}

function methodCompletionPhase(method: string): ActivityPhase {
  if (
    method.endsWith("/completed") ||
    method.endsWith("_completed") ||
    method.endsWith("/complete") ||
    method.endsWith("_complete")
  ) {
    return "complete";
  }
  return "delta";
}

function toolPhase(method: string | null, eventDetail: string): ActivityPhase {
  if (eventDetail === "tool_call_failed" || eventDetail === "unsupported_tool_call") {
    return "failed";
  }
  if (eventDetail === "tool_call_completed") {
    return "complete";
  }
  if (method === null) {
    return "delta";
  }
  if (
    method.endsWith("/completed") ||
    method.endsWith("_completed") ||
    method.endsWith("/complete") ||
    method.endsWith("_complete")
  ) {
    return "complete";
  }
  if (method.endsWith("/failed") || method.endsWith("_failed")) {
    return "failed";
  }
  return lifecyclePhase(method) ?? "delta";
}

function isReasoningMethod(method: string): boolean {
  return method.startsWith("item/reasoning/") || method.includes("reasoning");
}

function isToolActivity(method: string | null, event: string, eventDetail: string): boolean {
  if (event === "tool_call" || eventDetail.includes("tool_call")) {
    return true;
  }
  if (method === null) {
    return false;
  }
  return (
    method.startsWith("item/tool/") ||
    method.startsWith("item/commandExecution/") ||
    method.startsWith("item/fileChange/") ||
    method.includes("tool_call") ||
    method.startsWith("mcp_tool_call")
  );
}

function isReasoningType(value: string | null): boolean {
  const normalized = normalizeType(value);
  return normalized === "reasoning" || normalized === "reasoningitem";
}

function isToolItemType(value: string | null): boolean {
  const normalized = normalizeType(value);
  return (
    normalized === "toolcall" ||
    normalized === "commandexecution" ||
    normalized === "filechange" ||
    normalized === "mcpcall" ||
    normalized === "mcptoolcall"
  );
}

function normalizeType(value: string | null): string {
  return value?.replace(/[^a-z]/gi, "").toLowerCase() ?? "";
}

function reasoningSummaryDelta(
  payload: unknown,
  method: string,
): Pick<ActivityProjection, "contentDelta"> {
  const summary = firstStringAtPaths(payload, reasoningSummaryPaths(method));
  return summary === null ? {} : { contentDelta: summary };
}

function reasoningSummaryPaths(method: string): string[][] {
  const summaryOnly = [
    ["params", "summaryTextDelta"],
    ["params", "summaryText"],
    ["params", "summary"],
    ["params", "item", "summary"],
    ["params", "msg", "summaryTextDelta"],
    ["params", "msg", "summaryText"],
    ["params", "msg", "summary"],
    ["params", "msg", "payload", "summaryTextDelta"],
    ["params", "msg", "payload", "summaryText"],
    ["params", "msg", "payload", "summary"],
  ];
  if (!method.toLowerCase().includes("summary")) {
    return summaryOnly;
  }
  return [
    ...summaryOnly,
    ["params", "delta"],
    ["params", "text"],
    ["params", "msg", "delta"],
    ["params", "msg", "text"],
    ["params", "msg", "payload", "delta"],
    ["params", "msg", "payload", "text"],
  ];
}

function toolMetadata(
  payload: unknown,
  message: AgentMessage,
): Pick<
  ActivityProjection,
  "toolName" | "toolInput" | "toolCommand" | "toolOutputDelta" | "toolError"
> {
  const toolName = firstStringAtPaths(payload, toolNamePaths());
  const toolCommand = firstStringAtPaths(payload, toolCommandPaths());
  const toolOutputDelta = firstStringAtPaths(payload, toolOutputDeltaPaths());
  const toolInput = firstValueAtPaths(payload, toolInputPaths());
  const toolError = firstStringAtPaths(payload, toolErrorPaths()) ?? errorText(message.reason);
  return {
    ...(toolName !== null ? { toolName } : {}),
    ...(toolInput !== undefined ? { toolInput } : {}),
    ...(toolCommand !== null ? { toolCommand } : {}),
    ...(toolOutputDelta !== null ? { toolOutputDelta } : {}),
    ...(toolError !== null ? { toolError } : {}),
  };
}

function parentMessageField(payload: unknown): Record<string, unknown> {
  const parentMessageId = firstIdAtPaths(payload, parentMessageIdPaths());
  return parentMessageId === null ? {} : { parent_message_id: parentMessageId };
}

function allocateChatId(state: PersistedRun, turn: number): string {
  state.chatSequence += 1;
  return `${state.metadata.run_id}:turn-${turn}:assistant-${state.chatSequence}`;
}

function extractChatProjection(payload: unknown): ChatProjection | null {
  const method = firstStringAtPaths(payload, [["method"]]);
  if (method === null) {
    return null;
  }

  if (
    method === "item/agentMessage/delta" ||
    method.endsWith("agent_message_delta") ||
    method.endsWith("agent_message_content_delta")
  ) {
    const delta = firstStringAtPaths(payload, deltaPaths());
    return {
      phase: "delta",
      chatId: firstStringAtPaths(payload, chatIdPaths()),
      ...(delta !== null ? { delta } : {}),
    };
  }

  const isStart = method === "item/started" || method.endsWith("item_started");
  const isComplete = method === "item/completed" || method.endsWith("item_completed");
  if (!isStart && !isComplete) {
    return null;
  }

  const itemType = firstStringAtPaths(payload, itemTypePaths());
  if (!isAgentMessageType(itemType)) {
    return null;
  }
  return {
    phase: isStart ? "start" : "complete",
    chatId: firstStringAtPaths(payload, chatIdPaths()),
  };
}

function buildAgentOutputMessages(
  events: AgentOutputEvent[],
  runStatus: AgentOutputRunMetadata["status"],
): AgentOutputMessage[] {
  const messages: AgentOutputMessage[] = [];
  const active = new Map<string, AgentOutputMessage>();
  const seenActivityEvents = new Set<string>();

  for (const event of events) {
    if (isActivityClosingEvent(event)) {
      closeActiveMessages(active, event.run_id, event.turn, event, terminalStatusForEvent(event));
      continue;
    }

    const activity = storedActivityEvent(event);
    if (activity === null) {
      continue;
    }
    const dedupeKey = `${event.run_id}:${activity.type}:${activity.id ?? "active"}:${event.seq}`;
    if (seenActivityEvents.has(dedupeKey)) {
      continue;
    }
    seenActivityEvents.add(dedupeKey);

    const scope = activityScope(event, activity);
    let current = active.get(scope);
    const id = activity.id ?? current?.activity_id ?? legacyActivityId(event, activity);
    if (activity.phase === "start") {
      if (current !== undefined && current.status === "streaming" && current.activity_id !== id) {
        completeActivity(current, Math.max(current.seq_end, event.seq - 1), event.at);
      }
      if (current === undefined || current.activity_id !== id) {
        current = createOutputMessage(event, activity, id);
        messages.push(current);
        active.set(scope, current);
      }
    } else if (current === undefined || current.activity_id !== id) {
      if (current !== undefined && current.status === "streaming") {
        completeActivity(current, Math.max(current.seq_end, event.seq - 1), event.at);
      }
      current = createOutputMessage(event, activity, id);
      messages.push(current);
      active.set(scope, current);
    }

    applyActivityEvent(current, event, activity);
    current.seq_end = event.seq;
    current.updated_at = event.at;

    if (activity.status === "completed" || activity.status === "failed") {
      current.status = activity.status;
      current.activity_status = activity.status;
      active.delete(scope);
    }
  }

  if (runStatus !== "running") {
    for (const [scope, message] of active) {
      const last = events.at(-1);
      const status = runStatus === "failed" ? "failed" : "completed";
      if (last !== undefined && last.run_id === message.run_id) {
        completeActivity(message, Math.max(message.seq_end, last.seq), last.at, status);
      } else {
        completeActivity(message, message.seq_end, message.updated_at, status);
      }
      active.delete(scope);
    }
  }

  return messages;
}

type StoredActivityEvent = {
  type: AgentActivityType;
  phase: ActivityPhase;
  id: string | null;
  status: AgentActivityStatus;
  parentMessageId: string | null;
  contentDelta?: string;
  toolName?: string;
  toolInput?: unknown;
  toolCommand?: string;
  toolOutputDelta?: string;
  toolError?: string;
};

function storedActivityEvent(event: AgentOutputEvent): StoredActivityEvent | null {
  const activityType = storedActivityType(event.activity_type);
  if (activityType === "assistant_message") {
    const chat = storedChatEvent(event);
    const status = storedActivityStatus(event.activity_status);
    const phase = chat?.phase ?? phaseForStatus(status);
    return {
      type: "assistant_message",
      phase,
      id: typeof event.activity_id === "string" ? event.activity_id : (chat?.chatId ?? null),
      status,
      parentMessageId: typeof event.parent_message_id === "string" ? event.parent_message_id : null,
      ...(chat?.delta !== undefined ? { contentDelta: chat.delta } : {}),
    };
  }
  if (activityType === "thinking") {
    const status = storedActivityStatus(event.activity_status);
    return {
      type: "thinking",
      phase: phaseForStatus(status),
      id: typeof event.activity_id === "string" ? event.activity_id : null,
      status,
      parentMessageId: typeof event.parent_message_id === "string" ? event.parent_message_id : null,
      ...(typeof event.thinking_summary_delta === "string"
        ? { contentDelta: event.thinking_summary_delta }
        : {}),
    };
  }
  if (activityType === "tool_call") {
    const status = storedActivityStatus(event.activity_status);
    return {
      type: "tool_call",
      phase: phaseForStatus(status),
      id: typeof event.activity_id === "string" ? event.activity_id : null,
      status,
      parentMessageId: typeof event.parent_message_id === "string" ? event.parent_message_id : null,
      ...(typeof event.tool_name === "string" ? { toolName: event.tool_name } : {}),
      ...(event.tool_input !== undefined ? { toolInput: event.tool_input } : {}),
      ...(typeof event.tool_command === "string" ? { toolCommand: event.tool_command } : {}),
      ...(typeof event.tool_output_delta === "string"
        ? { toolOutputDelta: event.tool_output_delta }
        : {}),
      ...(typeof event.tool_error === "string" ? { toolError: event.tool_error } : {}),
    };
  }

  const chat = storedChatEvent(event);
  if (chat !== null) {
    return {
      type: "assistant_message",
      phase: chat.phase,
      id: chat.chatId,
      status: chat.phase === "complete" ? "completed" : "streaming",
      parentMessageId: null,
      ...(chat.delta !== undefined ? { contentDelta: chat.delta } : {}),
    };
  }

  return storedPayloadActivityEvent(event);
}

function storedPayloadActivityEvent(event: AgentOutputEvent): StoredActivityEvent | null {
  const method = methodFromPayload(event.payload);
  const lifecycle = lifecyclePhase(method);
  const itemType = firstStringAtPaths(event.payload, itemTypePaths());
  const id = firstIdAtPaths(event.payload, activityIdPaths());
  const parentMessageId = firstIdAtPaths(event.payload, parentMessageIdPaths());
  if (method !== null && lifecycle !== null) {
    if (isReasoningType(itemType)) {
      return {
        type: "thinking",
        phase: lifecycle,
        id,
        status: lifecycle === "complete" ? "completed" : "streaming",
        parentMessageId,
      };
    }
    if (isToolItemType(itemType)) {
      return {
        type: "tool_call",
        phase: lifecycle,
        id,
        status: lifecycle === "complete" ? "completed" : "streaming",
        parentMessageId,
        ...storedToolMetadata(event),
      };
    }
  }
  if (method !== null && isReasoningMethod(method)) {
    const phase = methodCompletionPhase(method);
    return {
      type: "thinking",
      phase,
      id,
      status: phase === "complete" ? "completed" : "streaming",
      parentMessageId,
      ...reasoningSummaryDelta(event.payload, method),
    };
  }
  if (isToolActivity(method, event.event, event.event_detail ?? event.event)) {
    const phase = toolPhase(method, event.event_detail ?? event.event);
    const status = activityStatusForProjection({
      type: "tool_call",
      phase,
      rawId: id,
      parentMessageId,
    });
    return {
      type: "tool_call",
      phase,
      id,
      status,
      parentMessageId,
      ...storedToolMetadata(event),
    };
  }
  return null;
}

function storedToolMetadata(
  event: AgentOutputEvent,
): Pick<
  StoredActivityEvent,
  "toolName" | "toolInput" | "toolCommand" | "toolOutputDelta" | "toolError"
> {
  const toolName = firstStringAtPaths(event.payload, toolNamePaths());
  const toolCommand = firstStringAtPaths(event.payload, toolCommandPaths());
  const toolOutputDelta = firstStringAtPaths(event.payload, toolOutputDeltaPaths());
  const toolInput = firstValueAtPaths(event.payload, toolInputPaths());
  const toolError =
    firstStringAtPaths(event.payload, toolErrorPaths()) ??
    errorText(event.reason) ??
    (typeof event.tool_error === "string" ? event.tool_error : null);
  return {
    ...(toolName !== null ? { toolName } : {}),
    ...(toolInput !== undefined ? { toolInput } : {}),
    ...(toolCommand !== null ? { toolCommand } : {}),
    ...(toolOutputDelta !== null ? { toolOutputDelta } : {}),
    ...(toolError !== null ? { toolError } : {}),
  };
}

function storedActivityType(value: unknown): AgentActivityType | null {
  return value === "assistant_message" ||
    value === "thinking" ||
    value === "tool_call" ||
    value === "system" ||
    value === "unknown"
    ? value
    : null;
}

function storedActivityStatus(value: unknown): AgentActivityStatus {
  return value === "completed" || value === "failed" || value === "streaming" ? value : "streaming";
}

function phaseForStatus(status: AgentActivityStatus): ActivityPhase {
  if (status === "failed") {
    return "failed";
  }
  return status === "completed" ? "complete" : "delta";
}

function storedChatEvent(event: AgentOutputEvent): StoredChatEvent | null {
  if (event.chat_phase !== undefined) {
    return {
      phase: event.chat_phase,
      chatId: typeof event.chat_id === "string" ? event.chat_id : null,
      ...(typeof event.chat_delta === "string" ? { delta: event.chat_delta } : {}),
      source: "stored",
    };
  }

  const message = typeof event.message === "string" ? event.message : "";
  const deltaPrefix = /^(agent message(?: content)? streaming)/;
  const deltaMatch = message.match(deltaPrefix);
  if (deltaMatch !== null) {
    return {
      phase: "delta",
      chatId: null,
      delta: message.slice(deltaMatch[0].length).replace(/^:\s?/, ""),
      source: "legacy",
    };
  }
  const lifecycle = message.match(
    /^item (started|completed)(?::\s+|\s+\()agent message(?: \(([^)]+)\))?\)?/,
  );
  if (lifecycle !== null) {
    return {
      phase: lifecycle[1] === "started" ? "start" : "complete",
      chatId: lifecycle[2]?.split(",", 1)[0]?.trim() || null,
      source: "legacy",
    };
  }
  return null;
}

function activityScope(event: AgentOutputEvent, activity: StoredActivityEvent): string {
  return `${event.run_id}:${event.turn ?? "unknown"}:${activity.type}:${activity.id ?? "active"}`;
}

function legacyActivityId(event: AgentOutputEvent, activity: StoredActivityEvent): string {
  return `legacy:${activity.type}:${event.run_id}:${event.turn ?? "unknown"}:${event.seq}`;
}

function createOutputMessage(
  event: AgentOutputEvent,
  activity: StoredActivityEvent,
  messageId: string,
): AgentOutputMessage {
  const message: AgentOutputMessage = {
    message_id: messageId,
    activity_id: messageId,
    activity_type: activity.type,
    activity_status: activity.status,
    issue_identifier: event.issue_identifier,
    backend: event.backend,
    run_id: event.run_id,
    content: "",
    status: activity.status,
    seq_start: event.seq,
    seq_end: event.seq,
    at: event.at,
    updated_at: event.at,
  };
  if (activity.type === "assistant_message") {
    message.role = "assistant";
  }
  if (event.session_id !== undefined) {
    message.session_id = event.session_id;
  }
  if (event.turn !== undefined) {
    message.turn = event.turn;
  }
  if (activity.parentMessageId !== null) {
    message.parent_message_id = activity.parentMessageId;
  }
  return message;
}

function closeActiveMessages(
  active: Map<string, AgentOutputMessage>,
  runId: string,
  turn: number | undefined,
  event: AgentOutputEvent,
  status: AgentActivityStatus = "completed",
): void {
  for (const [scope, message] of active) {
    if (
      message.run_id !== runId ||
      (turn !== undefined && message.turn !== undefined && message.turn !== turn)
    ) {
      continue;
    }
    completeActivity(message, Math.max(message.seq_end, event.seq), event.at, status);
    active.delete(scope);
  }
}

function applyActivityEvent(
  message: AgentOutputMessage,
  event: AgentOutputEvent,
  activity: StoredActivityEvent,
): void {
  message.activity_status = activity.status;
  message.status = activity.status;
  if (activity.parentMessageId !== null) {
    message.parent_message_id = activity.parentMessageId;
  }
  if (activity.type === "assistant_message" || activity.type === "thinking") {
    if (activity.contentDelta !== undefined) {
      message.content += activity.contentDelta;
    }
  }
  if (activity.type === "tool_call") {
    if (activity.toolName !== undefined) {
      message.tool_name = activity.toolName;
    }
    if (activity.toolInput !== undefined) {
      message.tool_input = activity.toolInput;
    }
    if (activity.toolCommand !== undefined) {
      message.tool_command = activity.toolCommand;
    }
    if (activity.toolOutputDelta !== undefined) {
      message.tool_output = `${message.tool_output ?? ""}${activity.toolOutputDelta}`;
    }
    if (activity.toolError !== undefined) {
      message.tool_error = activity.toolError;
    }
  }
  message.seq_end = Math.max(message.seq_end, event.seq);
  message.updated_at = event.at;
}

function completeActivity(
  message: AgentOutputMessage,
  seqEnd: number,
  updatedAt: string,
  status: AgentActivityStatus = "completed",
): void {
  message.status = status;
  message.activity_status = status;
  message.seq_end = seqEnd;
  message.updated_at = updatedAt;
}

function isActivityClosingEvent(event: AgentOutputEvent): boolean {
  return (
    event.event === "turn_completed" ||
    event.event === "turn_failed" ||
    event.event === "turn_cancelled" ||
    event.event === "turn_timeout" ||
    event.event === "turn_input_required" ||
    event.event === "port_exit" ||
    event.event === "run_completed" ||
    event.event === "run_failed" ||
    event.event === "run_cancelled"
  );
}

function terminalStatusForEvent(event: AgentOutputEvent): AgentActivityStatus {
  return event.event === "run_failed" ||
    event.event === "turn_failed" ||
    event.event === "turn_timeout" ||
    event.event === "port_exit"
    ? "failed"
    : "completed";
}

function firstStringAtPaths(value: unknown, paths: string[][]): string | null {
  for (const path of paths) {
    const candidate = valueAtPath(value, path);
    if (typeof candidate === "string") {
      return candidate;
    }
  }
  return null;
}

function methodFromPayload(payload: unknown): string | null {
  return firstStringAtPaths(payload, [
    ["method"],
    ["params", "method"],
    ["params", "msg", "method"],
    ["params", "msg", "payload", "method"],
  ]);
}

function firstIdAtPaths(value: unknown, paths: string[][]): string | null {
  for (const path of paths) {
    const candidate = valueAtPath(value, path);
    if (typeof candidate === "string" && candidate.trim() !== "") {
      return candidate;
    }
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      return String(candidate);
    }
  }
  return null;
}

function firstValueAtPaths(value: unknown, paths: string[][]): unknown {
  for (const path of paths) {
    const candidate = valueAtPath(value, path);
    if (candidate !== null && candidate !== undefined) {
      return candidate;
    }
  }
  return undefined;
}

function valueAtPath(value: unknown, path: string[]): unknown {
  let current: unknown = value;
  for (const key of path) {
    if (!isRecord(current) || !(key in current)) {
      return null;
    }
    current = current[key];
  }
  return current;
}

function activityIdPaths(): string[][] {
  return [
    ["params", "itemId"],
    ["params", "item", "id"],
    ["params", "toolCallId"],
    ["params", "callId"],
    ["params", "id"],
    ["params", "msg", "itemId"],
    ["params", "msg", "item", "id"],
    ["params", "msg", "payload", "itemId"],
    ["params", "msg", "payload", "item", "id"],
    ["params", "msg", "payload", "toolCallId"],
    ["params", "msg", "payload", "callId"],
    ["params", "msg", "payload", "id"],
    ["params", "msg", "id"],
    ["id"],
  ];
}

function parentMessageIdPaths(): string[][] {
  return [
    ["params", "parentMessageId"],
    ["params", "parentItemId"],
    ["params", "parentId"],
    ["params", "item", "parentMessageId"],
    ["params", "item", "parentItemId"],
    ["params", "msg", "parentMessageId"],
    ["params", "msg", "parentItemId"],
    ["params", "msg", "payload", "parentMessageId"],
    ["params", "msg", "payload", "parentItemId"],
  ];
}

function chatIdPaths(): string[][] {
  return [
    ["params", "itemId"],
    ["params", "item", "id"],
    ["params", "id"],
    ["params", "msg", "itemId"],
    ["params", "msg", "item", "id"],
    ["params", "msg", "payload", "itemId"],
    ["params", "msg", "payload", "item", "id"],
    ["params", "msg", "payload", "id"],
    ["params", "msg", "id"],
  ];
}

function toolNamePaths(): string[][] {
  return [
    ["params", "name"],
    ["params", "tool"],
    ["params", "toolName"],
    ["params", "item", "name"],
    ["params", "item", "toolName"],
    ["params", "msg", "name"],
    ["params", "msg", "toolName"],
    ["params", "msg", "payload", "name"],
    ["params", "msg", "payload", "toolName"],
  ];
}

function toolInputPaths(): string[][] {
  return [
    ["params", "arguments"],
    ["params", "args"],
    ["params", "input"],
    ["params", "item", "arguments"],
    ["params", "item", "args"],
    ["params", "item", "input"],
    ["params", "msg", "arguments"],
    ["params", "msg", "args"],
    ["params", "msg", "input"],
    ["params", "msg", "payload", "arguments"],
    ["params", "msg", "payload", "args"],
    ["params", "msg", "payload", "input"],
  ];
}

function toolCommandPaths(): string[][] {
  return [
    ["params", "command"],
    ["params", "cmd"],
    ["params", "item", "command"],
    ["params", "item", "cmd"],
    ["params", "msg", "command"],
    ["params", "msg", "cmd"],
    ["params", "msg", "payload", "command"],
    ["params", "msg", "payload", "cmd"],
  ];
}

function toolOutputDeltaPaths(): string[][] {
  return [
    ["params", "outputDelta"],
    ["params", "delta"],
    ["params", "output"],
    ["params", "item", "outputDelta"],
    ["params", "item", "delta"],
    ["params", "item", "output"],
    ["params", "msg", "outputDelta"],
    ["params", "msg", "delta"],
    ["params", "msg", "output"],
    ["params", "msg", "payload", "outputDelta"],
    ["params", "msg", "payload", "delta"],
    ["params", "msg", "payload", "output"],
  ];
}

function toolErrorPaths(): string[][] {
  return [
    ["params", "error"],
    ["params", "error", "message"],
    ["params", "item", "error"],
    ["params", "item", "error", "message"],
    ["params", "msg", "error"],
    ["params", "msg", "error", "message"],
    ["params", "msg", "payload", "error"],
    ["params", "msg", "payload", "error", "message"],
  ];
}

function errorText(value: unknown): string | null {
  if (typeof value === "string" && value.trim() !== "") {
    return value;
  }
  if (isRecord(value)) {
    if (typeof value.message === "string") {
      return value.message;
    }
    if (typeof value.error === "string") {
      return value.error;
    }
    if (typeof value.tag === "string") {
      return value.tag;
    }
  }
  return null;
}

function deltaPaths(): string[][] {
  return [
    ["params", "delta"],
    ["params", "textDelta"],
    ["params", "outputDelta"],
    ["params", "text"],
    ["params", "summaryText"],
    ["params", "msg", "delta"],
    ["params", "msg", "textDelta"],
    ["params", "msg", "outputDelta"],
    ["params", "msg", "text"],
    ["params", "msg", "summaryText"],
    ["params", "msg", "payload", "delta"],
    ["params", "msg", "payload", "textDelta"],
    ["params", "msg", "payload", "outputDelta"],
    ["params", "msg", "payload", "text"],
    ["params", "msg", "payload", "summaryText"],
  ];
}

function itemTypePaths(): string[][] {
  return [
    ["params", "item", "type"],
    ["params", "itemType"],
    ["params", "msg", "type"],
    ["params", "msg", "payload", "type"],
  ];
}

function isAgentMessageType(value: string | null): boolean {
  return normalizeType(value) === "agentmessage";
}

function dateFromMessage(value: Date): string {
  return value instanceof Date && !Number.isNaN(value.getTime())
    ? value.toISOString()
    : new Date().toISOString();
}

function boundValue(value: unknown, maxBytes: number): { value: unknown; truncated: boolean } {
  const serialized = safeJson(value);
  if (Buffer.byteLength(serialized, "utf8") <= maxBytes) {
    return { value, truncated: false };
  }
  return {
    value: {
      truncated: true,
      original_bytes: Buffer.byteLength(serialized, "utf8"),
      preview: boundText(serialized, Math.max(32, maxBytes - 80)).value,
    },
    truncated: true,
  };
}

function boundText(value: string, maxBytes: number): { value: string; truncated: boolean } {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) {
    return { value, truncated: false };
  }
  let output = value;
  while (Buffer.byteLength(output, "utf8") > Math.max(0, maxBytes - 24)) {
    output = output.slice(0, Math.max(0, output.length - 16));
  }
  return { value: `${output} [truncated]`, truncated: true };
}

function safeJson(value: unknown): string {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? String(value) : serialized;
  } catch {
    return String(value);
  }
}

function safeSegment(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+$/, "_");
  return normalized.slice(0, 180) || "unknown";
}

function metadataPath(filePath: string): string {
  return `${filePath}${RUN_METADATA_SUFFIX}`;
}

function isRunMetadata(value: Record<string, unknown>): boolean {
  return (
    typeof value.issue_identifier === "string" &&
    typeof value.run_id === "string" &&
    typeof value.backend === "string" &&
    typeof value.worker_host === "string" &&
    typeof value.path === "string" &&
    typeof value.size === "number" &&
    typeof value.event_count === "number" &&
    typeof value.last_seq === "number" &&
    typeof value.truncated === "boolean" &&
    (value.status === "running" ||
      value.status === "completed" ||
      value.status === "failed" ||
      value.status === "cancelled")
  );
}

function mergeEvents(...groups: AgentOutputEvent[][]): AgentOutputEvent[] {
  const events = new Map<string, AgentOutputEvent>();
  for (const group of groups) {
    for (const event of group) {
      events.set(`${event.run_id}:${event.seq}`, event);
    }
  }
  return [...events.values()].sort((left, right) => {
    if (left.run_id === right.run_id) {
      return left.seq - right.seq;
    }
    return left.at.localeCompare(right.at);
  });
}

function sanitizeReason(value: unknown): Record<string, string> | undefined {
  const candidate = isRecord(value) && isRecord(value.reason) ? value.reason : value;
  if (!isRecord(candidate) && typeof candidate !== "string") {
    return undefined;
  }
  if (typeof candidate === "string") {
    return { message: boundText(candidate, 1_024).value };
  }
  const result: Record<string, string> = {};
  if (typeof candidate.tag === "string" && candidate.tag.trim() !== "") {
    result.tag = boundText(candidate.tag.trim(), 128).value;
  }
  if (typeof candidate.message === "string" && candidate.message.trim() !== "") {
    result.message = boundText(candidate.message.trim(), 1_024).value;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function issueKey(value: string): string {
  return value.trim().toLowerCase();
}

function uniqueRuns(runs: AgentOutputRunMetadata[]): AgentOutputRunMetadata[] {
  const seen = new Set<string>();
  return runs.filter((run) => {
    if (seen.has(run.path)) {
      return false;
    }
    seen.add(run.path);
    return true;
  });
}

function clampLimit(value: number | undefined): number {
  if (!Number.isInteger(value) || value === undefined) {
    return 100;
  }
  return Math.min(Math.max(value, 1), 500);
}

function positiveOr(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

function dateValue(value: string | null): number {
  if (value === null) {
    return 0;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" && value !== "" ? value : fallback;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function inspect(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
