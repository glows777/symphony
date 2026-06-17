// Literal port of `elixir/test/symphony_elixir/live_e2e_test.exs`.
//
// The REAL Linear/Codex/Docker end-to-end test. It provisions a disposable
// Linear project + issue via GraphQL, writes a temp WORKFLOW.md, drives one real
// `codex app-server` run (AgentRunner) that must comment on and close the issue,
// asserts the outcomes, then marks the project complete. Two scenarios: a local
// worker and SSH workers (disposable Docker workers when
// SYMPHONY_LIVE_SSH_WORKER_HOSTS is unset).
//
// GUARDED: skips unless SYMPHONY_RUN_LIVE_E2E === "1". The default `bun test` /
// `bun run check` therefore runs nothing here — no Linear key, no Docker, no
// network. See HANDOFF.md "Real live e2e" and MIGRATION.md Phase 7.
//
// Adaptation note vs. the Elixir source: ExUnit boots the full OTP supervision
// tree, so the Elixir test terminates/restarts the `Orchestrator` child around
// the run. `bun test` starts nothing automatically, so there is no orchestrator
// to manage here — we drive `AgentRunner.run/3` directly, exactly as Elixir does
// after terminating the orchestrator. Everything else is a faithful port.

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import * as AgentRunner from "../src/symphony/agent-runner.ts";
import { graphql as linearGraphql } from "../src/symphony/linear/client.ts";
import { type Issue, newIssue } from "../src/symphony/linear/issue.ts";
import { logger } from "../src/symphony/logger.ts";
import * as SSH from "../src/symphony/ssh.ts";
import { setWorkflowFilePath, workflowFilePath } from "../src/symphony/workflow.ts";
import { writeWorkflowFile } from "./support/test-support.ts";

// Skip the whole suite unless explicitly enabled. Evaluated at import time so the
// default test run never touches Linear/Docker/the network.
const LIVE_E2E_ENABLED = process.env.SYMPHONY_RUN_LIVE_E2E === "1";

const DEFAULT_TEAM_KEY = "SYME2E";
const DEFAULT_DOCKER_AUTH_JSON = path.join(os.homedir(), ".codex/auth.json");
const DOCKER_WORKER_COUNT = 2;
const DOCKER_SUPPORT_DIR = path.join(import.meta.dir, "support", "live_e2e_docker");
const DOCKER_COMPOSE_FILE = path.join(DOCKER_SUPPORT_DIR, "docker-compose.yml");
const RESULT_FILE = "LIVE_E2E_RESULT.txt";
const TEST_TIMEOUT_MS = 300_000;

const TEAM_QUERY = `query SymphonyLiveE2ETeam($key: String!) {
  teams(filter: {key: {eq: $key}}, first: 1) {
    nodes {
      id
      key
      name
      states(first: 50) {
        nodes {
          id
          name
          type
        }
      }
    }
  }
}`;

const CREATE_PROJECT_MUTATION = `mutation SymphonyLiveE2ECreateProject($name: String!, $teamIds: [String!]!) {
  projectCreate(input: {name: $name, teamIds: $teamIds}) {
    success
    project {
      id
      name
      slugId
      url
    }
  }
}`;

const CREATE_ISSUE_MUTATION = `mutation SymphonyLiveE2ECreateIssue(
  $teamId: String!
  $projectId: String!
  $title: String!
  $description: String!
  $stateId: String
) {
  issueCreate(
    input: {
      teamId: $teamId
      projectId: $projectId
      title: $title
      description: $description
      stateId: $stateId
    }
  ) {
    success
    issue {
      id
      identifier
      title
      description
      url
      state {
        name
      }
    }
  }
}`;

const PROJECT_STATUSES_QUERY = `query SymphonyLiveE2EProjectStatuses {
  projectStatuses(first: 50) {
    nodes {
      id
      name
      type
    }
  }
}`;

const ISSUE_DETAILS_QUERY = `query SymphonyLiveE2EIssueDetails($id: String!) {
  issue(id: $id) {
    id
    identifier
    state {
      name
      type
    }
    comments(first: 20) {
      nodes {
        body
      }
    }
  }
}`;

const COMPLETE_PROJECT_MUTATION = `mutation SymphonyLiveE2ECompleteProject($id: String!, $statusId: String!, $completedAt: DateTime!) {
  projectUpdate(id: $id, input: {statusId: $statusId, completedAt: $completedAt}) {
    success
  }
}`;

type Backend = "local" | "ssh";

type WorkerSetup = {
  cleanup: () => void;
  codexCommand: string;
  sshWorkerHosts: string[];
  workspaceRoot: string;
};

type JsonObject = Record<string, unknown>;
type WorkflowState = { id?: unknown; name?: unknown; type?: unknown };

// Mirrors Elixir's `System.unique_integer([:positive])`: a process-unique,
// strictly increasing positive integer.
let uniqueCounter = 0;
function uniqueInteger(): number {
  uniqueCounter += 1;
  return uniqueCounter;
}

describe("live e2e (real Linear/Codex/Docker)", () => {
  test.skipIf(!LIVE_E2E_ENABLED)(
    "creates a real Linear project and issue with a local worker",
    async () => {
      await runLiveIssueFlow("local");
    },
    TEST_TIMEOUT_MS,
  );

  test.skipIf(!LIVE_E2E_ENABLED)(
    "creates a real Linear project and issue with an ssh worker",
    async () => {
      await runLiveIssueFlow("ssh");
    },
    TEST_TIMEOUT_MS,
  );
});

async function runLiveIssueFlow(backend: Backend): Promise<void> {
  const runId = `symphony-live-e2e-${backend}-${uniqueInteger()}`;
  const testRoot = path.join(os.tmpdir(), runId);
  const workflowRoot = path.join(testRoot, "workflow");
  const workflowFile = path.join(workflowRoot, "WORKFLOW.md");
  const workerSetup = await liveWorkerSetup(backend, runId, testRoot);
  const teamKey = process.env.SYMPHONY_LIVE_LINEAR_TEAM_KEY || DEFAULT_TEAM_KEY;
  const originalWorkflowPath = workflowFilePath();

  fs.mkdirSync(workflowRoot, { recursive: true });

  try {
    setWorkflowFilePath(workflowFile);

    writeWorkflowFile(workflowFile, {
      tracker_api_token: "$LINEAR_API_KEY",
      tracker_project_slug: "bootstrap",
      workspace_root: workerSetup.workspaceRoot,
      worker_ssh_hosts: workerSetup.sshWorkerHosts,
      codex_command: workerSetup.codexCommand,
      codex_approval_policy: "never",
      observability_enabled: false,
    });

    const team = await fetchTeam(teamKey);
    const activeState = activeStateBang(team);
    const completedProjectStatus = await completedProjectStatusBang();
    const terminalStates = terminalStateNames(team);

    const project = await createProject(
      stringField(team, "id"),
      `Symphony Live E2E ${backend} ${uniqueInteger()}`,
    );

    const issue = await createIssue(
      stringField(team, "id"),
      stringField(project, "id"),
      stringField(activeState, "id"),
      `Symphony live e2e ${backend} issue for ${stringField(project, "name")}`,
    );

    writeWorkflowFile(workflowFile, {
      tracker_api_token: "$LINEAR_API_KEY",
      tracker_project_slug: stringField(project, "slugId"),
      tracker_active_states: activeStateNames(team),
      tracker_terminal_states: terminalStates,
      workspace_root: workerSetup.workspaceRoot,
      worker_ssh_hosts: workerSetup.sshWorkerHosts,
      codex_command: workerSetup.codexCommand,
      codex_approval_policy: "never",
      codex_turn_timeout_ms: 600_000,
      codex_stall_timeout_ms: 600_000,
      observability_enabled: false,
      prompt: livePrompt(stringField(project, "slugId")),
    });

    let runtimeInfo: { workerHost: string | null; workspacePath: string } | null = null;
    const recipient: AgentRunner.UpdateRecipient = (update) => {
      if (update.tag === "worker_runtime_info" && update.issueId === issue.id) {
        runtimeInfo = update.info;
      }
    };

    await AgentRunner.run(issue, recipient, { maxTurns: 3 });

    if (runtimeInfo === null) {
      throw new Error(`timed out waiting for worker runtime info for ${inspect(issue.id)}`);
    }

    const projectSlug = stringField(project, "slugId");
    expect(readWorkerResult(runtimeInfo, RESULT_FILE)).toBe(
      expectedResult(asString(issue.identifier), projectSlug),
    );

    const issueSnapshot = await fetchIssueDetails(asString(issue.id));
    expect(issueCompleted(issueSnapshot)).toBe(true);
    expect(
      issueHasComment(issueSnapshot, expectedComment(asString(issue.identifier), projectSlug)),
    ).toBe(true);

    expect(
      await completeProject(stringField(project, "id"), stringField(completedProjectStatus, "id")),
    ).toBe("ok");
  } finally {
    workerSetup.cleanup();
    setWorkflowFilePath(originalWorkflowPath);
    fs.rmSync(testRoot, { recursive: true, force: true });
  }
}

// ---- Linear GraphQL provisioning / teardown --------------------------------

async function fetchTeam(teamKey: string): Promise<JsonObject> {
  const data = await graphqlDataBang(TEAM_QUERY, { key: teamKey });
  const nodes = getIn(data, ["teams", "nodes"]);
  if (Array.isArray(nodes) && isObject(nodes[0])) {
    return nodes[0];
  }
  return flunk(`expected Linear team ${inspect(teamKey)} to exist`);
}

function teamStates(team: JsonObject): WorkflowState[] {
  const states = getIn(team, ["states", "nodes"]);
  return Array.isArray(states) ? (states as WorkflowState[]) : [];
}

function activeStateBang(team: JsonObject): WorkflowState {
  const states = teamStates(team);
  const found =
    states.find((s) => s.type === "started") ??
    states.find((s) => s.type === "unstarted") ??
    states.find((s) => s.type !== "completed" && s.type !== "canceled");
  if (found === undefined) {
    return flunk("expected team to expose at least one non-terminal workflow state");
  }
  return found;
}

function terminalStateNames(team: JsonObject): string[] {
  const names = teamStates(team)
    .filter((s) => s.type === "completed" || s.type === "canceled")
    .map((s) => s.name)
    .filter((name): name is string => typeof name === "string");
  return names.length === 0 ? ["Done", "Canceled", "Cancelled"] : names;
}

function activeStateNames(team: JsonObject): string[] {
  const names = teamStates(team)
    .filter((s) => s.type !== "completed" && s.type !== "canceled")
    .map((s) => s.name)
    .filter((name): name is string => typeof name === "string");
  return names.length === 0 ? ["Todo", "In Progress", "In Review"] : names;
}

async function completedProjectStatusBang(): Promise<JsonObject> {
  const data = await graphqlDataBang(PROJECT_STATUSES_QUERY, {});
  const statuses = getIn(data, ["projectStatuses", "nodes"]);
  if (Array.isArray(statuses)) {
    const completed = statuses.find((s) => isObject(s) && s.type === "completed");
    if (isObject(completed)) {
      return completed;
    }
    return flunk("expected workspace to expose a completed project status");
  }
  return flunk(`expected project statuses list, got: ${inspect(statuses)}`);
}

async function createProject(teamId: string, name: string): Promise<JsonObject> {
  const data = await graphqlDataBang(CREATE_PROJECT_MUTATION, { teamIds: [teamId], name });
  return fetchSuccessfulEntityBang(data, "projectCreate", "project");
}

async function createIssue(
  teamId: string,
  projectId: string,
  stateId: string,
  title: string,
): Promise<Issue> {
  const data = await graphqlDataBang(CREATE_ISSUE_MUTATION, {
    teamId,
    projectId,
    title,
    description: title,
    stateId,
  });
  const issue = fetchSuccessfulEntityBang(data, "issueCreate", "issue");
  return newIssue({
    id: stringField(issue, "id"),
    identifier: stringField(issue, "identifier"),
    title: stringField(issue, "title"),
    description: stringField(issue, "description"),
    state: getIn(issue, ["state", "name"]) as string | null,
    url: stringField(issue, "url"),
    labels: [],
    blockedBy: [],
  });
}

async function completeProject(projectId: string, completedStatusId: string): Promise<"ok"> {
  return updateEntity(
    COMPLETE_PROJECT_MUTATION,
    {
      id: projectId,
      statusId: completedStatusId,
      completedAt: nowIso8601Seconds(),
    },
    "projectUpdate",
    "project",
  );
}

async function fetchIssueDetails(issueId: string): Promise<JsonObject> {
  const data = await graphqlDataBang(ISSUE_DETAILS_QUERY, { id: issueId });
  const issue = getIn(data, ["issue"]);
  if (isObject(issue)) {
    return issue;
  }
  return flunk(`expected issue details payload, got: ${inspect(issue)}`);
}

function issueCompleted(issue: JsonObject): boolean {
  const type = getIn(issue, ["state", "type"]);
  return type === "completed" || type === "canceled";
}

function issueHasComment(issue: JsonObject, expectedBody: string): boolean {
  const comments = getIn(issue, ["comments", "nodes"]);
  if (!Array.isArray(comments)) {
    return false;
  }
  return comments.some((comment) => isObject(comment) && comment.body === expectedBody);
}

// Lenient finalization helper (mirrors Elixir's `update_entity/4`): logs a
// warning and resolves "ok" on any failure so teardown never breaks the test.
async function updateEntity(
  mutation: string,
  variables: JsonObject,
  mutationName: string,
  entityName: string,
): Promise<"ok"> {
  const result = await linearGraphql(mutation, variables);
  if (result.ok) {
    const body = result.value;
    if (getIn(body, ["data", mutationName, "success"]) === true) {
      return "ok";
    }
    const errors = getIn(body, ["errors"]);
    if (Array.isArray(errors)) {
      logger.warning(`Live e2e finalization failed for ${entityName}: ${inspect(errors)}`);
      return "ok";
    }
    logger.warning(`Live e2e finalization failed for ${entityName}: ${inspect(body)}`);
    return "ok";
  }
  logger.warning(`Live e2e finalization failed for ${entityName}: ${inspect(result.error)}`);
  return "ok";
}

async function graphqlDataBang(query: string, variables: JsonObject): Promise<JsonObject> {
  const result = await linearGraphql(query, variables);
  if (!result.ok) {
    return flunk(`Linear GraphQL request failed: ${inspect(result.error)}`);
  }
  const body = result.value;
  const data = getIn(body, ["data"]);
  const errors = getIn(body, ["errors"]);
  if (isObject(data) && Array.isArray(errors)) {
    return flunk(`Linear GraphQL returned partial errors: ${inspect(errors)}`);
  }
  if (Array.isArray(errors)) {
    return flunk(`Linear GraphQL failed: ${inspect(errors)}`);
  }
  if (isObject(data)) {
    return data;
  }
  return flunk(`Linear GraphQL returned unexpected payload: ${inspect(body)}`);
}

function fetchSuccessfulEntityBang(
  data: JsonObject,
  mutationName: string,
  entityName: string,
): JsonObject {
  const mutation = getIn(data, [mutationName]);
  if (isObject(mutation) && mutation.success === true && isObject(mutation[entityName])) {
    return mutation[entityName] as JsonObject;
  }
  return flunk(`expected successful ${mutationName} response, got: ${inspect(data)}`);
}

// ---- prompt / expected outputs ---------------------------------------------

function livePrompt(projectSlug: string): string {
  return `You are running a real Symphony end-to-end test.

The current working directory is the workspace root.

Step 1:
Create a file named ${RESULT_FILE} in the current working directory by running exactly:

\`\`\`sh
cat > ${RESULT_FILE} <<'EOF'
identifier={{ issue.identifier }}
project_slug=${projectSlug}
EOF
\`\`\`

Then verify it by running:

\`\`\`sh
cat ${RESULT_FILE}
\`\`\`

The file content must be exactly:
identifier={{ issue.identifier }}
project_slug=${projectSlug}

Step 2:
You must use the \`linear_graphql\` tool to query the current issue by \`{{ issue.id }}\` and read:
- existing comments
- team workflow states

A turn that only creates the file is incomplete. Do not stop after Step 1.

If the exact comment body below is not already present, post exactly one comment on the current issue with this exact body:
${expectedComment("{{ issue.identifier }}", projectSlug)}

Use these exact GraphQL operations:

\`\`\`graphql
query IssueContext($id: String!) {
  issue(id: $id) {
    comments(first: 20) {
      nodes {
        body
      }
    }
    team {
      states(first: 50) {
        nodes {
          id
          name
          type
        }
      }
    }
  }
}
\`\`\`

\`\`\`graphql
mutation AddComment($issueId: String!, $body: String!) {
  commentCreate(input: {issueId: $issueId, body: $body}) {
    success
  }
}
\`\`\`

Step 3:
Use the same issue-context query result to choose a workflow state whose \`type\` is \`completed\`.
Then move the current issue to that state with this exact mutation:

\`\`\`graphql
mutation CompleteIssue($id: String!, $stateId: String!) {
  issueUpdate(id: $id, input: {stateId: $stateId}) {
    success
  }
}
\`\`\`

Step 4:
Verify all outcomes with one final \`linear_graphql\` query against \`{{ issue.id }}\`:
- the exact comment body is present
- the issue state type is \`completed\`

Do not ask for approval.
Stop only after all three conditions are true:
1. the file exists with the exact contents above
2. the Linear comment exists with the exact body above
3. the Linear issue is in a completed terminal state
`;
}

function expectedResult(issueIdentifier: string, projectSlug: string): string {
  return `identifier=${issueIdentifier}\nproject_slug=${projectSlug}\n`;
}

function expectedComment(issueIdentifier: string, projectSlug: string): string {
  return `Symphony live e2e comment\nidentifier=${issueIdentifier}\nproject_slug=${projectSlug}`;
}

// ---- worker result reading -------------------------------------------------

function readWorkerResult(
  runtimeInfo: { workerHost: string | null; workspacePath: string },
  resultFile: string,
): string {
  if (runtimeInfo.workerHost === null) {
    return fs.readFileSync(path.join(runtimeInfo.workspacePath, resultFile), "utf8");
  }
  const remoteResultPath = path.join(runtimeInfo.workspacePath, resultFile);
  const result = SSH.run(runtimeInfo.workerHost, `cat ${shellEscape(remoteResultPath)}`, {
    stderrToStdout: true,
  });
  if (!result.ok) {
    return flunk(
      `failed to read remote result from ${runtimeInfo.workerHost}:${remoteResultPath}: ${inspect(result.error)}`,
    );
  }
  const [output, status] = result.value;
  if (status !== 0) {
    return flunk(
      `failed to read remote result from ${runtimeInfo.workerHost}:${remoteResultPath} (status ${status}): ${inspect(output)}`,
    );
  }
  return output;
}

// ---- worker setup (local / ssh / docker) -----------------------------------

async function liveWorkerSetup(
  backend: Backend,
  runId: string,
  testRoot: string,
): Promise<WorkerSetup> {
  if (backend === "local") {
    return {
      cleanup: () => {},
      codexCommand: "codex app-server",
      sshWorkerHosts: [],
      workspaceRoot: path.join(testRoot, "workspaces"),
    };
  }
  const hosts = liveSshWorkerHosts();
  if (hosts.length === 0) {
    return liveDockerWorkerSetup(runId, testRoot);
  }
  return liveSshWorkerSetup(runId, hosts);
}

function liveSshWorkerHosts(): string[] {
  return (process.env.SYMPHONY_LIVE_SSH_WORKER_HOSTS ?? "")
    .split(",")
    .map((host) => host.trim())
    .filter((host) => host !== "");
}

function liveSshWorkerSetup(runId: string, sshWorkerHosts: string[]): WorkerSetup {
  const remoteTestRoot = path.join(sharedRemoteHomeBang(sshWorkerHosts), `.${runId}`);
  const remoteWorkspaceRoot = `~/.${runId}/workspaces`;

  return {
    cleanup: () => cleanupRemoteTestRoot(remoteTestRoot, sshWorkerHosts),
    codexCommand: "codex app-server",
    sshWorkerHosts,
    workspaceRoot: remoteWorkspaceRoot,
  };
}

function liveDockerWorkerSetup(runId: string, testRoot: string): WorkerSetup {
  const sshRoot = path.join(testRoot, "live-docker-ssh");
  const keyPath = path.join(sshRoot, "id_ed25519");
  const configPath = path.join(sshRoot, "config");
  const authJsonPath = DEFAULT_DOCKER_AUTH_JSON;
  const workerPorts = reserveTcpPorts(DOCKER_WORKER_COUNT);
  const workerHosts = workerPorts.map((port) => `localhost:${port}`);
  const projectName = dockerProjectName(runId);
  const previousSshConfig = process.env.SYMPHONY_SSH_CONFIG;

  const baseCleanup = (): void => {
    restoreEnv("SYMPHONY_SSH_CONFIG", previousSshConfig);
    dockerComposeDown(projectName, dockerComposeEnv(workerPorts, authJsonPath, `${keyPath}.pub`));
  };

  try {
    fs.mkdirSync(sshRoot, { recursive: true });
    generateSshKeypairBang(keyPath);
    writeDockerSshConfigBang(configPath, keyPath);
    process.env.SYMPHONY_SSH_CONFIG = configPath;

    dockerComposeUpBang(projectName, dockerComposeEnv(workerPorts, authJsonPath, `${keyPath}.pub`));
    waitForSshHostsBang(workerHosts);
    const remoteTestRoot = path.join(sharedRemoteHomeBang(workerHosts), `.${runId}`);
    const remoteWorkspaceRoot = `~/.${runId}/workspaces`;

    return {
      cleanup: () => {
        cleanupRemoteTestRoot(remoteTestRoot, workerHosts);
        baseCleanup();
      },
      codexCommand: "codex app-server",
      sshWorkerHosts: workerHosts,
      workspaceRoot: remoteWorkspaceRoot,
    };
  } catch (error) {
    baseCleanup();
    throw error;
  }
}

function cleanupRemoteTestRoot(testRoot: string, sshWorkerHosts: string[]): void {
  for (const workerHost of sshWorkerHosts) {
    SSH.run(workerHost, `rm -rf ${shellEscape(testRoot)}`, { stderrToStdout: true });
  }
}

function sharedRemoteHomeBang(workerHosts: string[]): string {
  if (workerHosts.length === 0) {
    return flunk("expected at least one live SSH worker host");
  }
  const homes = workerHosts.map((workerHost) => remoteHomeBang(workerHost));
  const first = homes[0] as string;
  if (homes.every((home) => home === first)) {
    return first;
  }
  return flunk(
    `expected all live SSH workers to share one home directory, got: ${inspect(
      workerHosts.map((host, index) => [host, homes[index]]),
    )}`,
  );
}

function remoteHomeBang(workerHost: string): string {
  const result = SSH.run(workerHost, `printf '%s\\n' "$HOME"`, { stderrToStdout: true });
  if (!result.ok) {
    return flunk(`failed to resolve remote home for ${workerHost}: ${inspect(result.error)}`);
  }
  const [output, status] = result.value;
  if (status !== 0) {
    return flunk(
      `failed to resolve remote home for ${workerHost} (status ${status}): ${inspect(output)}`,
    );
  }
  const home = output.trim();
  if (home === "") {
    return flunk(`expected non-empty remote home for ${workerHost}`);
  }
  return home;
}

// ---- docker / ssh plumbing -------------------------------------------------

function reserveTcpPorts(count: number): number[] {
  const seen = new Set<number>();
  const ports: number[] = [];
  while (ports.length < count) {
    const port = reserveTcpPortBang();
    if (!seen.has(port)) {
      seen.add(port);
      ports.push(port);
    }
  }
  return ports;
}

// Mirrors Elixir's `:gen_tcp.listen(0, ...)`: bind an ephemeral port, read it
// back, and close. The same inherent bind race exists in both implementations.
function reserveTcpPortBang(): number {
  const server = net.createServer();
  let bound: number | null = null;
  server.listen(0, "127.0.0.1");
  const deadline = Date.now() + 5_000;
  while (bound === null && Date.now() < deadline) {
    const address = server.address();
    if (address !== null && typeof address === "object") {
      bound = address.port;
    } else {
      sleepSyncMs(5);
    }
  }
  server.close();
  if (bound === null) {
    return flunk("failed to reserve an ephemeral TCP port");
  }
  return bound;
}

function generateSshKeypairBang(keyPath: string): void {
  if (Bun.which("ssh-keygen") === null) {
    flunk("docker worker mode requires `ssh-keygen` on PATH");
  }
  fs.mkdirSync(path.dirname(keyPath), { recursive: true });
  fs.rmSync(keyPath, { force: true });
  fs.rmSync(`${keyPath}.pub`, { force: true });

  const proc = Bun.spawnSync(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", keyPath]);
  if (proc.exitCode !== 0) {
    const out = `${proc.stdout?.toString() ?? ""}${proc.stderr?.toString() ?? ""}`;
    flunk(`failed to generate live docker ssh key (status ${proc.exitCode}): ${inspect(out)}`);
  }
}

function writeDockerSshConfigBang(configPath: string, keyPath: string): void {
  const contents = `Host localhost 127.0.0.1
  User root
  IdentityFile ${keyPath}
  IdentitiesOnly yes
  StrictHostKeyChecking no
  UserKnownHostsFile /dev/null
  LogLevel ERROR
`;
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, contents);
}

function dockerProjectName(runId: string): string {
  return runId.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
}

function dockerComposeEnv(
  workerPorts: number[],
  authJsonPath: string,
  authorizedKeyPath: string,
): Record<string, string> {
  return {
    SYMPHONY_LIVE_DOCKER_AUTH_JSON: authJsonPath,
    SYMPHONY_LIVE_DOCKER_AUTHORIZED_KEY: authorizedKeyPath,
    SYMPHONY_LIVE_DOCKER_WORKER_1_PORT: String(workerPorts[0]),
    SYMPHONY_LIVE_DOCKER_WORKER_2_PORT: String(workerPorts[1]),
  };
}

function dockerComposeUpBang(projectName: string, env: Record<string, string>): void {
  const proc = Bun.spawnSync(
    ["docker", "compose", "-f", DOCKER_COMPOSE_FILE, "-p", projectName, "up", "-d", "--build"],
    { cwd: DOCKER_SUPPORT_DIR, env: { ...processEnvStrings(), ...env } },
  );
  if (proc.exitCode !== 0) {
    const out = `${proc.stdout?.toString() ?? ""}${proc.stderr?.toString() ?? ""}`;
    flunk(`failed to start live docker workers (status ${proc.exitCode}): ${inspect(out)}`);
  }
}

function dockerComposeDown(projectName: string, env: Record<string, string>): void {
  Bun.spawnSync(
    [
      "docker",
      "compose",
      "-f",
      DOCKER_COMPOSE_FILE,
      "-p",
      projectName,
      "down",
      "-v",
      "--remove-orphans",
    ],
    { cwd: DOCKER_SUPPORT_DIR, env: { ...processEnvStrings(), ...env } },
  );
}

function waitForSshHostsBang(workerHosts: string[]): void {
  const deadline = Date.now() + 60_000;
  for (const workerHost of workerHosts) {
    waitForSshHostBang(workerHost, deadline);
  }
}

function waitForSshHostBang(workerHost: string, deadlineMs: number): void {
  const result = SSH.run(workerHost, "printf ready", { stderrToStdout: true });
  if (result.ok && result.value[0] === "ready" && result.value[1] === 0) {
    return;
  }
  if (Date.now() < deadlineMs) {
    sleepSyncMs(1_000);
    waitForSshHostBang(workerHost, deadlineMs);
    return;
  }
  flunk(`timed out waiting for SSH worker ${workerHost} to accept connections`);
}

// ---- helpers ---------------------------------------------------------------

function restoreEnv(name: string, previous: string | undefined): void {
  if (previous === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = previous;
  }
}

function processEnvStrings(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") {
      out[key] = value;
    }
  }
  return out;
}

function nowIso8601Seconds(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

// Blocking sleep used only inside the env-gated docker/ssh provisioning, where
// the Elixir source likewise blocks (`Process.sleep`) before retrying.
function sleepSyncMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function stringField(obj: JsonObject, key: string): string {
  const value = obj[key];
  if (typeof value !== "string") {
    return flunk(`expected string field ${inspect(key)}, got: ${inspect(value)}`);
  }
  return value;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getIn(value: unknown, keys: string[]): unknown {
  let current: unknown = value;
  for (const key of keys) {
    if (!isObject(current)) {
      return undefined;
    }
    current = current[key];
  }
  return current;
}

function inspect(value: unknown): string {
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  return JSON.stringify(value) ?? String(value);
}

// ExUnit's `flunk/1`: fail the current test with a message.
function flunk(message: string): never {
  throw new Error(message);
}
