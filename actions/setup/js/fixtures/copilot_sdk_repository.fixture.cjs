"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { createRequire } = require("node:module");

const runtimeDirectory = path.resolve(__dirname, "..");
const load = createRequire(path.join(runtimeDirectory, "copilot_sdk_session.cjs"));
const sdk = load("@github/copilot-sdk");
const { parseCopilotSDKToolConfig, buildCopilotSDKSessionToolConfig } = load("./copilot_sdk_tool_config.cjs");
const { createCopilotSDKRepositoryRuntime } = load("./copilot_sdk_repo_tools.cjs");
const { restrictCopilotSDKRepositoryCatalog } = load("./copilot_sdk_tool_catalog.cjs");
const { buildCopilotSDKPermissionHandler } = load("./copilot_sdk_permissions.cjs");
const { parseCopilotSDKMCPConfig } = load("./copilot_sdk_mcp_config.cjs");
const { getPatchPathForBranch, getPatchPathForBranchInRepo } = load("./git_patch_utils.cjs");

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "gh-aw-sdk-repository-fixture-"));
const root = path.join(scratch, "checkout");
const home = path.join(scratch, "home");
const sdkHome = path.join(scratch, "sdk-home");
for (const directory of [root, home, sdkHome]) fs.mkdirSync(directory);
fs.mkdirSync(path.join(root, "docs"));
const branch = `automation/sdk-${randomUUID()}`;
const artifacts = [getPatchPathForBranch(branch), getPatchPathForBranchInRepo(branch, "fixture/repository")].map(filename => path.resolve(filename));
const goEnv = execFileSync("go", ["env", "GOROOT", "GOCACHE", "GOMODCACHE"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
  .trim()
  .split(/\r?\n/);
const minimalEnv = Object.fromEntries(["PATH", "Path", "SystemRoot", "WINDIR", "PATHEXT", "TEMP", "TMP"].filter(key => process.env[key]).map(key => [key, process.env[key]]));
const gitConfig = path.join(home, "gitconfig");
fs.writeFileSync(gitConfig, "");
Object.assign(minimalEnv, { HOME: home, USERPROFILE: home, GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: "1", GIT_ALLOW_PROTOCOL: "", GIT_TERMINAL_PROMPT: "0" });
function git(args) {
  return execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args], { cwd: root, env: minimalEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 }).trim();
}
git(["init", "-q", "-b", "main"]);
fs.writeFileSync(path.join(root, "go.mod"), "module fixture\n\ngo 1.20\n");
fs.writeFileSync(path.join(root, "main.go"), 'package main\n\nimport "fmt"\n\nfunc greeting() string { return "Hello" }\n\nfunc main() { fmt.Println(greeting()) }\n');
fs.writeFileSync(path.join(root, "main_test.go"), 'package main\n\nimport "testing"\n\nfunc TestGreeting(t *testing.T) {\n\tif greeting() != "Hello" {\n\t\tt.Fatal("unexpected greeting")\n\t}\n}\n');
fs.writeFileSync(path.join(root, "README.md"), "A greeting command.\n");
git(["add", "--all", "--", "."]);
git(["commit", "-q", "-m", "Greeting command\n\nCo-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"]);
const baseline = git(["rev-parse", "HEAD"]);
git(["remote", "add", "origin", "https://github.com/fixture/repository.git"]);
git(["update-ref", "refs/remotes/origin/main", baseline]);
git(["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);

const policy = {
  "target-repo": "fixture/repository",
  base_branch: "main",
  allowed_branches: ["automation/*"],
  allowed_files: ["README.md", "*.go", "docs/**"],
  protected_files: ["go.mod", "go.sum", "CHANGELOG.md"],
  protected_files_policy: "blocked",
};
const toolConfig = parseCopilotSDKToolConfig(
  JSON.stringify({
    version: 2,
    capabilities: { bash: false, edit: true, webFetch: false, webSearch: false, mcp: true, cliProxy: false },
    explicitlyDisabledTools: ["bash", "cli-proxy"],
    permissions: { allowedTools: ["read", "write", "go_repository", "safeoutputs", "github(get_file_contents)", "reference"] },
    profile: { id: "go-repository", repositoryDefaultBranch: "main", policy },
  })
);
const configuration = path.join(scratch, "safeoutputs.json");
const definitions = path.join(scratch, "tools.json");
const output = path.join(scratch, "output.jsonl");
fs.writeFileSync(configuration, JSON.stringify({ noop: { max: 1 }, create_pull_request: { ...policy, max: 1, draft: true, patch_format: "am" } }));
const tools = JSON.parse(fs.readFileSync(path.join(runtimeDirectory, "safe_outputs_tools.json"), "utf8"));
fs.writeFileSync(definitions, JSON.stringify(tools.filter(tool => ["noop", "create_pull_request"].includes(tool.name))));
for (const key of Object.keys(process.env)) delete process.env[key];
Object.assign(process.env, minimalEnv, {
  GITHUB_WORKSPACE: root,
  GITHUB_REPOSITORY: "fixture/repository",
  GITHUB_SHA: baseline,
  GITHUB_REF_NAME: "main",
  GITHUB_REF: "refs/heads/main",
  GITHUB_EVENT_NAME: "workflow_dispatch",
  RUNNER_TEMP: scratch,
  GH_AW_SAFE_OUTPUTS_CONFIG_PATH: configuration,
  GH_AW_SAFE_OUTPUTS_TOOLS_PATH: definitions,
  GH_AW_SAFE_OUTPUTS: output,
  GH_AW_MCP_LOG_DIR: path.join(scratch, "mcp-logs"),
  GOROOT: goEnv[0],
  GOCACHE: goEnv[1],
  GOMODCACHE: goEnv[2],
});

async function main() {
  const { MCPServer, MCPHTTPTransport } = load("./mcp_http_transport.cjs");
  const { createMCPServer } = load("./safe_outputs_mcp_server_http.cjs");
  const safeoutputs = createMCPServer().server;
  const github = new MCPServer({ name: "github", version: "1.0.0" }, { logDir: path.join(scratch, "mcp-logs") });
  let reads = 0;
  let forbiddenCalls = 0;
  github.tool(
    "get_file_contents",
    "Read a synthetic repository file.",
    { type: "object", additionalProperties: false, required: ["owner", "repo", "path"], properties: { owner: { type: "string" }, repo: { type: "string" }, path: { type: "string" } } },
    args => {
      assert.deepEqual(args, { owner: "fixture", repo: "repository", path: "README.md" });
      reads++;
      return { content: [{ type: "text", text: JSON.stringify({ path: args.path, content: "A greeting command.\n" }) }] };
    }
  );
  github.tool("delete_file", "Forbidden synthetic mutation.", { type: "object", properties: {} }, () => {
    forbiddenCalls++;
    throw new Error("An unapproved tool must not execute");
  });
  const reference = new MCPServer({ name: "reference", version: "1.0.0" }, { logDir: path.join(scratch, "mcp-logs") });
  for (let index = 0; index < 35; index++) reference.tool(`lookup_${index}`, "Read a synthetic reference.", { type: "object", properties: {} }, () => ({ content: [{ type: "text", text: "Reference" }] }));
  const transports = new Map();
  for (const [name, server] of [
    ["safeoutputs", safeoutputs],
    ["github", github],
    ["reference", reference],
  ]) {
    const transport = new MCPHTTPTransport({ enableJsonResponse: true, enableDnsRebindingProtection: false });
    await server.connect(transport);
    transports.set(`/mcp/${name}`, transport);
  }
  let providerRequests = 0;
  let unexpectedRequests = 0;
  const listener = http.createServer(async (request, response) => {
    const transport = transports.get(request.url);
    if (!transport) {
      if (request.url.startsWith("/provider")) providerRequests++;
      else unexpectedRequests++;
      response.writeHead(500, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "External API and model requests are forbidden in this fixture" }));
      return;
    }
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
      await transport.handleRequest(request, response, body);
    } catch (error) {
      response.writeHead(500, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: error.message }));
    }
  });
  await new Promise(resolve => listener.listen(0, "127.0.0.1", resolve));
  const address = `http://127.0.0.1:${listener.address().port}`;
  process.env.GITHUB_API_URL = `${address}/github-api`;
  const mcpServers = parseCopilotSDKMCPConfig({ mcpServers: Object.fromEntries([...transports.keys()].map(route => [route.split("/").at(-1), { type: "http", url: `${address}${route}`, tools: ["*"], timeout: 10_000 }])) });
  const repository = createCopilotSDKRepositoryRuntime(sdk.defineTool, toolConfig.profile);
  const client = new sdk.CopilotClient({
    connection: sdk.RuntimeConnection.forStdio(),
    mode: "empty",
    baseDirectory: sdkHome,
    workingDirectory: root,
    env: { ...minimalEnv, HOME: sdkHome, USERPROFILE: sdkHome, APPDATA: sdkHome, LOCALAPPDATA: sdkHome },
    useLoggedInUser: false,
    logLevel: "warning",
    telemetry: { exporterType: "file", filePath: path.join(scratch, "telemetry.jsonl"), captureContent: false },
  });
  let session;
  let verifiedToolMetadata = [];
  const permissionIdentities = [];
  const actions = [];
  try {
    await repository.initialize();
    await client.start();
    const sessionTools = buildCopilotSDKSessionToolConfig(toolConfig, sdk, { repositoryTool: repository.tool });
    const permissionHandler = buildCopilotSDKPermissionHandler(toolConfig.permissions, sdk.approveAll, { workspaceRoot: root, getMCPToolMetadata: () => verifiedToolMetadata });
    session = await client.createSession({
      model: "offline-fixture",
      provider: { type: "openai", baseUrl: `${address}/provider`, wireApi: "completions" },
      onPermissionRequest: (request, invocation) => {
        permissionIdentities.push(Object.fromEntries(["kind", "serverName", "toolName"].filter(key => key in request).map(key => [key, request[key]])));
        return permissionHandler(request, invocation);
      },
      ...sessionTools,
      mcpServers,
    });
    const catalog = await restrictCopilotSDKRepositoryCatalog(session, { ToolSet: sdk.ToolSet, availableTools: sessionTools.availableTools, allowedTools: toolConfig.permissions.allowedTools, mcpServers });
    verifiedToolMetadata = catalog;
    assert.ok(catalog.length > 30, "Deferral threshold must be exercised");
    assert.ok(catalog.every(tool => !tool.deferLoading));
    assert.ok(!catalog.some(tool => /bash|powershell|^task$|agent$|^sql$|delete_file/.test(tool.name)));
    const invoke = async (name, args) => {
      const result = await session.rpc.tools.execute({ name, arguments: args });
      assert.equal(result.resultType, "success", `${name}: ${result.textResultForLlm}`);
      return result;
    };
    await invoke("view", { path: path.join(root, "README.md") });
    await invoke("grep", { pattern: "greeting", paths: root, glob: "*.go", output_mode: "content" });
    await invoke("glob", { pattern: "*.go", paths: root });
    await invoke("github-get_file_contents", { owner: "fixture", repo: "repository", path: "README.md" });
    for (const name of ["bash", "write_bash", "task", "noop", "github-delete_file"]) {
      const result = await session.rpc.tools.execute({ name, arguments: {} });
      assert.equal(result.resultType, "failure", `${name} must be unavailable`);
    }
    const repo = async (action, extra = {}) => {
      const result = await invoke("go_repository", { action, ...extra });
      actions.push(action);
      return JSON.parse(result.textResultForLlm);
    };
    await repo("status");
    await repo("prepare_branch", { branch });
    await invoke("edit", { path: path.join(root, "main.go"), old_str: 'func greeting() string { return "Hello" }', new_str: '// greeting returns the default salutation.\nfunc greeting()string{return "Hello"}' });
    await invoke("create", { path: path.join(root, "docs", "usage.md"), file_text: "Run the command to print Hello.\n" });
    await repo("format");
    await repo("validate");
    const committed = await repo("commit");
    assert.equal(git(["rev-parse", "HEAD"]), committed.commit);
    assert.equal(git(["rev-parse", "main"]), baseline);
    await repo("diff");
    await invoke("safeoutputs-create_pull_request", {
      title: "Clarify greeting documentation",
      body: "Documents the greeting helper and adds the usage example. The existing Go tests, vet, and build completed successfully.",
      branch,
    });
    await invoke("safeoutputs-noop", { message: "COMPLETE: Native reporting was exercised without a model request." });
    const recorded = fs
      .readFileSync(output, "utf8")
      .trim()
      .split("\n")
      .map(line => JSON.parse(line));
    assert.deepEqual(
      recorded.map(item => item.type),
      ["create_pull_request", "noop"]
    );
    assert.equal(recorded[0].branch, branch);
    assert.equal(reads, 1);
    assert.equal(forbiddenCalls, 0);
    assert.equal(providerRequests, 0);
    assert.equal(unexpectedRequests, 0);
    assert.ok(permissionIdentities.some(request => request.kind === "mcp" && request.serverName === "github" && request.toolName === "github-get_file_contents"));
    console.log(`SDK_REPOSITORY_RESULT=${JSON.stringify({ providerRequests, unexpectedRequests, reads, forbiddenCalls, nativeTools: catalog.map(tool => tool.name), actions, outputs: recorded.map(item => item.type) })}`);
  } finally {
    try {
      await repository.close();
    } finally {
      try {
        if (session) await session.disconnect();
      } finally {
        try {
          const errors = await client.stop();
          if (errors.length) throw new AggregateError(errors, "SDK fixture cleanup failed");
        } finally {
          listener.closeAllConnections();
          await new Promise(resolve => listener.close(resolve));
          for (const artifact of artifacts) fs.rmSync(artifact, { force: true });
        }
      }
    }
  }
}

main().then(
  () => fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }),
  error => {
    console.error(error.stack);
    console.error(`Fixture artifacts retained at ${scratch}`);
    process.exitCode = 1;
  }
);
