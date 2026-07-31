# Docker deployment

The root `Dockerfile` builds a reusable `symphony-base` image. It runs the
TypeScript application directly with Bun; TypeScript is not precompiled to a
single JavaScript bundle. The browser dashboard is built during the image
build because the Bun server serves `typescript/frontend/dist` at runtime.

## Build the base image

From the Symphony repository root:

```bash
docker build --progress=plain -t symphony-base:local .
```

The image contains Symphony, Bun, Codex CLI, Git, and SSH client tooling. It
does not contain a `WORKFLOW.md`, credentials, or any project source code.
The base image deliberately does not set `NODE_ENV=production`; derived project
images can install their development toolchains while task agents build and
test project code.

The default workflow argument is the relative path `WORKFLOW.md` from the
container work directory `/opt/symphony`. Set `SYMPHONY_WORKFLOW_FILE` to
replace it with another relative path.

## Project-local deployment

The current xz-system deployment files intentionally live outside Git under
`projects/xz-system/`. That directory is ignored by the Symphony repository
because it contains machine-specific workflow and deployment settings.

The xz-system Compose file starts:

- one Symphony container derived from `symphony-base:local`;
- one shared MySQL 8.4 container;
- one shared Redis container.

The Symphony container receives the project workflow as a read-only mount at
the relative container path selected by `SYMPHONY_WORKFLOW_FILE`. The host
source is selected by `SYMPHONY_WORKFLOW_HOST_PATH`, which is resolved relative
to `projects/xz-system/` when using the Compose file. The workflow's workspaces
and agent output are mounted below `runtime/xz-system/`, while MySQL and Redis
state stays below `projects/xz-system/data/`.

The xz-system Compose service sets `seccomp=unconfined` because Codex's
`workspace-write` sandbox uses `bwrap` user namespaces, which the default
Docker seccomp profile blocks on this local runtime. This is a local-only
deployment setting; keep the service bound to localhost and do not expose it
publicly. `--privileged` is not required.

Before starting the live stack, provide the local `GITEA_API_TOKEN`, the
directory containing `auth.json`, and the SSH directory through the environment
used by Compose. The Compose file mounts only `auth.json` read-only; Codex's
writable SQLite state is persisted below `runtime/xz-system/codex/`. These
values must not be written to the image or committed.

```bash
export XZ_SYSTEM_DB_ROOT_PASSWORD='choose-a-local-password'
export GITEA_API_TOKEN='your-gitea-token'
export GIT_USER_NAME='your-gitea-username'
export GIT_USER_EMAIL='your-email@example.com'
export CODEX_AUTH_DIR=/absolute/path/to/.codex
export SSH_DIR=/absolute/path/to/.ssh
export SYMPHONY_WORKFLOW_FILE=WORKFLOW.md
export SYMPHONY_WORKFLOW_HOST_PATH=./workflow.md

docker build --progress=plain -t symphony-base:local .
docker compose -f projects/xz-system/docker-compose.yml up -d
docker compose -f projects/xz-system/docker-compose.yml ps
```

The first assigned task prepares the xz-system schema and seed data in the
shared database. The xz-system backend is then started from that task's
workspace with `NODE_ENV=docker node bootstrap.js`; the Symphony container is
the task orchestrator, not the xz-system application server.

## Log semantics

`--logs-root /var/lib/symphony` persists agent output JSONL under
`/var/lib/symphony/log/agents`. The base entrypoint also appends the normal
Symphony stdout/stderr stream to `/var/lib/symphony/log/symphony.log` and
mirrors it to the container log, while Compose's local log driver provides
rotation for `docker compose logs`.

## xz-system environment

xz-system currently uses Node/TypeScript, MySQL 8.4, Redis, and COOL startup
initialization (`initDB`/`initMenu`). The local project image installs the
Node/pnpm and database-client tooling needed by agent workspaces. It does not
bake MySQL data into an image.

The current xz-system application configuration uses loopback DB/Redis hosts.
The local workflow installs a Docker-specific configuration overlay into each
cloned workspace so the application can use the Compose service names
`cool-db` and `cool-redis`. That overlay is local deployment configuration and
should move into the xz-system repository when this setup is promoted there.

The first task workspace runs `/opt/xz-system/init-db.sh`. It installs the
workspace dependencies, builds the backend, performs one TypeORM schema sync
with `DB_SYNCHRONIZE=true`, and waits for COOL's `init_db_base` and
`init_menu_base` markers. Subsequent runs skip this step and the Compose
service explicitly uses `DB_SYNCHRONIZE=false`. The init script also creates
the one current xz-system table whose duplicate index declarations prevent a
fresh TypeORM sync, refuses to touch a partially initialized database, and
restores the missing `statusStartDate` index after synchronization; this
workaround stays in the local deployment layer until the corresponding entity
is corrected in xz-system.
