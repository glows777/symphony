# syntax=docker/dockerfile:1.7

ARG BUN_VERSION=1.3.14

FROM oven/bun:${BUN_VERSION} AS build

WORKDIR /opt/symphony

COPY typescript/package.json typescript/bun.lock ./
RUN bun install --frozen-lockfile

COPY typescript/ ./
RUN bun run frontend:build

FROM oven/bun:${BUN_VERSION}

WORKDIR /opt/symphony

# Symphony launches Codex, runs Git hooks, and uses SSH-based project clones.
# Node/npm are also installed here because project-specific derived images use
# this image as their common toolchain base.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    git \
    nodejs \
    npm \
    openssh-client \
  && npm install --global @openai/codex \
  && rm -rf /var/lib/apt/lists/*

COPY typescript/package.json typescript/bun.lock ./
RUN bun install --frozen-lockfile --production

COPY --from=build /opt/symphony/src ./src
COPY --from=build /opt/symphony/frontend/dist ./frontend/dist
COPY --from=build /opt/symphony/priv ./priv
COPY docker/entrypoint.sh /usr/local/bin/symphony-entrypoint

RUN chmod 0755 /usr/local/bin/symphony-entrypoint \
  && mkdir -p /etc/symphony /var/lib/symphony/log /var/lib/symphony/workspaces

ENV HOME=/root

EXPOSE 4000

ENTRYPOINT ["/usr/local/bin/symphony-entrypoint"]
CMD ["--i-understand-that-this-will-be-running-without-the-usual-guardrails", "--port", "4000", "--logs-root", "/var/lib/symphony", "/etc/symphony/WORKFLOW.md"]
