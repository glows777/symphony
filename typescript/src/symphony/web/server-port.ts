// Shared HTTP server bound-port state. The dashboard needs the live bound port
// to render the observability URL; the HttpServer (Phase 5) sets it on bind.

let bound: number | null = null;

export function boundPort(): number | null {
  return bound;
}

export function setBoundPort(port: number | null): void {
  bound = port;
}
