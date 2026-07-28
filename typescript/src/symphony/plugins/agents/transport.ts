// Shared line-framed JSON transport for agent backends. Extracted verbatim from
// codex/app-server.ts (originally the literal port of the Elixir Port) so a
// second backend (claude-code's stream-json subprocess) reuses the exact same
// process client — a real Bun.spawn (or SSH.startPort) process feeding a
// queue/waiter loop with per-read timeouts and an exit event.
//
// app-server.ts re-exports these symbols, so its existing import paths and the
// public `Transport` type are unchanged; the codex-only ReplayTransport (the
// differential-oracle in-memory transport) stays in app-server.ts.

export type AgentStream = "stdout" | "stderr";
export type StreamLineListener = (data: string) => void;

export type LineEvent =
  | { type: "line"; data: string; stream: AgentStream }
  | { type: "exit"; status: number }
  | { type: "timeout" };

export interface Transport {
  send(message: Record<string, unknown>): void;
  next(timeoutMs: number): Promise<LineEvent>;
  subscribeStderr(listener: StreamLineListener): () => void;
  close(): void;
  osPid(): string | undefined;
}

export class ProcessTransport implements Transport {
  private queue: LineEvent[] = [];
  private waiters: ((event: LineEvent) => void)[] = [];
  private outBuffer = "";
  private errBuffer = "";
  private exitPushed = false;
  private readonly stderrListeners = new Set<StreamLineListener>();

  constructor(private proc: Bun.Subprocess<"pipe", "pipe", "pipe">) {
    void this.pump(proc.stdout, "stdout");
    void this.pump(proc.stderr, "stderr");
    void proc.exited.then((status) => this.pushExit(status ?? 0));
  }

  send(message: Record<string, unknown>): void {
    const line = `${JSON.stringify(message)}\n`;
    const stdin = this.proc.stdin;
    stdin.write(line);
    stdin.flush();
  }

  next(timeoutMs: number): Promise<LineEvent> {
    const queued = this.queue.shift();
    if (queued) {
      return Promise.resolve(queued);
    }
    return new Promise<LineEvent>((resolve) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.indexOf(deliver);
        if (idx >= 0) {
          this.waiters.splice(idx, 1);
        }
        resolve({ type: "timeout" });
      }, timeoutMs);
      const deliver = (event: LineEvent): void => {
        clearTimeout(timer);
        resolve(event);
      };
      this.waiters.push(deliver);
    });
  }

  subscribeStderr(listener: StreamLineListener): () => void {
    this.stderrListeners.add(listener);
    return () => this.stderrListeners.delete(listener);
  }

  close(): void {
    try {
      this.proc.kill();
    } catch {
      // already exited
    }
  }

  osPid(): string | undefined {
    return this.proc.pid ? String(this.proc.pid) : undefined;
  }

  private async pump(stream: ReadableStream<Uint8Array>, which: AgentStream): Promise<void> {
    // One decoder per stream, decoding in streaming mode: a multibyte UTF-8
    // sequence split across a chunk boundary must be held until its remaining
    // bytes arrive. A non-streaming decode emits U+FFFD for the split halves,
    // silently corrupting backend protocol payloads (both backends share this
    // transport).
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      const text =
        (which === "stdout" ? this.outBuffer : this.errBuffer) +
        decoder.decode(chunk, { stream: true });
      const lines = text.split("\n");
      const remainder = lines.pop() ?? "";
      if (which === "stdout") {
        this.outBuffer = remainder;
      } else {
        this.errBuffer = remainder;
      }
      for (const line of lines) {
        this.pushLine({ type: "line", data: line, stream: which });
      }
    }
    const remainder = `${which === "stdout" ? this.outBuffer : this.errBuffer}${decoder.decode()}`;
    if (remainder !== "") {
      this.pushLine({ type: "line", data: remainder, stream: which });
    }
  }

  private pushLine(event: LineEvent): void {
    if (event.type === "line" && event.stream === "stderr" && this.stderrListeners.size > 0) {
      for (const listener of this.stderrListeners) {
        listener(event.data);
      }
      return;
    }
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(event);
    } else {
      this.queue.push(event);
    }
  }

  private pushExit(status: number): void {
    if (this.exitPushed) {
      return;
    }
    this.exitPushed = true;
    this.pushLine({ type: "exit", status });
  }
}
