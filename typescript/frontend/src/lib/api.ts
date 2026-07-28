export type Backend = "codex" | "claude_code" | string;

export type RunItem = {
  issue_id?: string | null;
  issue_identifier: string;
  title?: string | null;
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
  last_event_at?: string | null;
  tokens?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
  };
  error?: string | null;
  path?: string | null;
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
  payload?: unknown;
  raw?: string;
  terminal?: boolean;
  [key: string]: unknown;
};

export type RunMetadata = {
  issue_id: string | null;
  issue_identifier: string;
  title: string | null;
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

export type OutputPayload = {
  events: AgentOutputEvent[];
  next_cursor: number | null;
  has_more: boolean;
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
  return fetchJson<OutputPayload>(
    `/api/v1/${encodeURIComponent(identifier)}/output?limit=160`,
    signal,
  );
}

export function subscribeToOutput(
  identifier: string,
  onEvent: (event: AgentOutputEvent) => void,
  onError?: () => void,
): () => void {
  const source = new EventSource(`/api/v1/${encodeURIComponent(identifier)}/output/stream`);
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

async function fetchJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal, headers: { accept: "application/json" } });
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
