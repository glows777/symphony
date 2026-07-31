export type Backend = "codex" | "claude_code" | string;
export type RunKind = "normal" | "review";

export type RunItem = {
  issue_id?: string | null;
  issue_identifier: string;
  title?: string | null;
  display_name?: string | null;
  run_kind?: RunKind;
  state?: string | null;
  status?: string | null;
  backend?: Backend | null;
  worker_host?: string | null;
  workspace_path?: string | null;
  session_id?: string | null;
  run_id?: string | null;
  turn_count?: number;
  updated_at?: string | null;
  started_at?: string | null;
  ended_at?: string | null;
  last_event_at?: string | null;
  tokens?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
  };
  error?: string | null;
  blocked_reason?: string | null;
  disposition?: "blocked" | "retryable" | "terminal" | string | null;
  operator_prompt?: string | null;
  raw_blocker_payload?: unknown;
  manual_recovery?: ManualRecovery | null;
  retry_attempt?: number | null;
  path?: string | null;
  history?: RunMetadata[];
};

export type ManualRecovery = {
  action?: string;
  reason?: string;
  prompt?: string | null;
  payload?: unknown;
  session_id?: string | null;
  automatic_retry?: boolean;
  resume_supported?: boolean;
  rerun_supported?: boolean;
  rerun_endpoint?: string | null;
};

export type AgentOutputEvent = {
  seq: number;
  at: string;
  issue_id?: string;
  issue_identifier: string;
  title?: string;
  backend: Backend;
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
  activity_type?: "assistant_message" | "thinking" | "tool_call" | "system" | "unknown";
  activity_status?: "streaming" | "completed" | "failed";
  activity_id?: string;
  presentation_role?: "working" | "response";
  final_activity_id?: string;
  final_content?: string;
  parent_message_id?: string;
  parent_tool_use_id?: string;
  thinking_summary_delta?: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_command?: string;
  tool_output_delta?: string;
  tool_error?: string;
  payload?: unknown;
  raw?: string;
  terminal?: boolean;
  [key: string]: unknown;
};

export type AgentActivityStatus = "streaming" | "completed" | "failed";

export type AgentOutputMessage = {
  message_id: string;
  activity_id?: string;
  activity_type?: "assistant_message" | "thinking" | "tool_call" | "system" | "unknown";
  activity_status?: AgentActivityStatus;
  presentation_role?: "working" | "response";
  issue_identifier: string;
  backend: Backend;
  run_id: string;
  session_id?: string;
  turn?: number;
  parent_message_id?: string;
  parent_tool_use_id?: string;
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

export type RunMetadata = {
  issue_id: string | null;
  issue_identifier: string;
  title: string | null;
  display_name?: string | null;
  prompt?: string | null;
  run_kind?: RunKind;
  backend: Backend;
  worker_host: string;
  run_id: string;
  session_id: string | null;
  path: string;
  size: number;
  started_at: string | null;
  ended_at: string | null;
  status: string;
  event_count: number;
  last_seq: number;
  truncated: boolean;
};

export type StatePayload = {
  generated_at: string;
  counts?: { running: number; retrying: number; blocked: number };
  running?: RunItem[];
  retrying?: RunItem[];
  blocked?: RunItem[];
  completed?: RunItem[];
  error?: { code: string; message: string };
};

export type IssueDetail = {
  issue_identifier: string;
  title?: string | null;
  status: string;
  issue_id?: string | null;
  workspace?: { path?: string | null; host?: string | null };
  running?: RunItem | null;
  retry?: RunItem | null;
  blocked?: RunItem | null;
  logs?: {
    latest_run?: RunMetadata | null;
    agent_runs?: RunMetadata[];
  };
  last_error?: string | null;
};

export type RerunBlockedPayload = {
  queued: true;
  issue_id: string;
  issue_identifier: string | null;
  requested_at: string | null;
  operation: "rerun_blocked";
};

export type OutputPayload = {
  events: AgentOutputEvent[];
  messages?: AgentOutputMessage[];
  next_cursor: number | null;
  has_more: boolean;
  before_cursor: number | null;
  has_before: boolean;
  run: RunMetadata | null;
  backend: Backend | null;
  run_id: string | null;
  session_id: string | null;
  error?: { code: string; message: string };
};

export async function getState(signal?: AbortSignal): Promise<StatePayload> {
  return fetchJson<StatePayload>("/api/v1/state", signal);
}

export async function getIssue(identifier: string, signal?: AbortSignal): Promise<IssueDetail> {
  return fetchJson<IssueDetail>(`/api/v1/${encodeURIComponent(identifier)}`, signal);
}

export async function getOutput(identifier: string, signal?: AbortSignal): Promise<OutputPayload> {
  return getOutputForRun(identifier, null, signal);
}

export async function rerunBlockedIssue(
  identifier: string,
  signal?: AbortSignal,
): Promise<RerunBlockedPayload> {
  return fetchJson<RerunBlockedPayload>(`/api/v1/${encodeURIComponent(identifier)}/rerun`, signal, {
    method: "POST",
  });
}

export async function getOutputForRun(
  identifier: string,
  runId: string | null,
  signal?: AbortSignal,
  options: { after?: number | null; before?: number | null } = {},
): Promise<OutputPayload> {
  const query = new URLSearchParams({ limit: "160" });
  if (runId !== null) {
    query.set("run_id", runId);
  }
  if (options.after !== undefined && options.after !== null) {
    query.set("after", String(options.after));
  }
  if (options.before !== undefined && options.before !== null) {
    query.set("before", String(options.before));
  }
  return fetchJson<OutputPayload>(
    `/api/v1/${encodeURIComponent(identifier)}/output?${query.toString()}`,
    signal,
  );
}

export function subscribeToOutput(
  identifier: string,
  runId: string | null,
  onEvent: (event: AgentOutputEvent) => void,
  onError?: () => void,
): () => void {
  const query = runId === null ? "" : `?run_id=${encodeURIComponent(runId)}`;
  const source = new EventSource(`/api/v1/${encodeURIComponent(identifier)}/output/stream${query}`);
  const handleEvent = (message: MessageEvent<string>): void => {
    try {
      onEvent(JSON.parse(message.data) as AgentOutputEvent);
    } catch {
      onError?.();
    }
  };
  const handleError = (): void => onError?.();
  source.addEventListener("agent_output", handleEvent);
  source.addEventListener("error", handleError);
  return () => {
    source.removeEventListener("agent_output", handleEvent);
    source.removeEventListener("error", handleError);
    source.close();
  };
}

async function fetchJson<T>(url: string, signal?: AbortSignal, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("accept", "application/json");
  const response = await fetch(url, { ...init, signal, headers });
  const body = (await response.json()) as T | { error?: { message?: string } };
  if (!response.ok) {
    const message =
      typeof body === "object" && body !== null && "error" in body
        ? body.error?.message
        : undefined;
    throw new Error(message ?? `Request failed with status ${response.status}`);
  }
  return body as T;
}
