import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const gatewayBinary = process.env.GH_AW_TEST_MCP_GATEWAY_BINARY;
const routes = ["/mcp/github", "/mcp/reference", "/mcp/safeoutputs"];

async function runFixture(mode) {
  const filename = fileURLToPath(new URL("./fixtures/copilot_sdk_repository.fixture.cjs", import.meta.url));
  const env = { ...process.env };
  delete env.GH_AW_TEST_MCP_GATEWAY_BINARY;
  if (mode === "gateway") env.GH_AW_TEST_MCP_GATEWAY_BINARY = gatewayBinary;
  const result = await promisify(execFile)(process.execPath, [filename, `--${mode}`], { env, encoding: "utf8", timeout: 240_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true });
  const lines = result.stdout.split(/\r?\n/).filter(value => value.startsWith("SDK_REPOSITORY_RESULT="));
  expect(lines, result.stderr).toHaveLength(1);
  const evidence = JSON.parse(lines[0].slice("SDK_REPOSITORY_RESULT=".length));
  expect(evidence).toMatchObject({ mode, catalogVerified: true, authChecked: true, providerRequests: 0, unexpectedRequests: 0, backendAuthFailures: 0, backendErrors: [], reads: 1, forbiddenCalls: 0 });
  expect(evidence.outputs).toEqual(["create_pull_request", "noop"]);
  expect(evidence.actions).toEqual(["status", "prepare_branch", "format", "validate", "commit", "diff"]);
  expect(evidence.nativeTools.length).toBeGreaterThan(30);
  for (const name of ["bash", "write_bash", "task", "noop", "github-delete_file"]) expect(evidence.nativeTools).not.toContain(name);
  expect(Object.keys(evidence.backendRequests).sort()).toEqual(routes);
  for (const route of routes) {
    expect(evidence.backendRequests[route].authenticatedRequests).toBeGreaterThan(0);
    expect(evidence.backendRequests[route].catalogRequests).toBeGreaterThan(0);
  }
  expect(evidence.backendRequests["/mcp/github"].calls).toEqual(["get_file_contents"]);
  expect(evidence.backendRequests["/mcp/safeoutputs"].calls).toEqual(["create_pull_request", "noop"]);
  expect(evidence.backendRequests["/mcp/reference"].calls).toEqual([]);
  for (const [serverName, toolName] of [
    ["github", "get_file_contents"],
    ["safeoutputs", "create_pull_request"],
    ["safeoutputs", "noop"],
  ]) {
    expect(evidence.permissionIdentities).toContainEqual({ kind: "mcp", serverName, toolName: `${serverName}-${toolName}` });
  }
  return evidence;
}

describe("promptless native SDK repository integration", () => {
  it("executes native inspection, fixed Go/Git and MCP declarations without inference (direct backend)", async () => {
    const evidence = await runFixture("direct");
    expect(evidence.gateway).toBeNull();
  }, 250_000);

  it("executes the same native catalog, permissions and repository sequence through the real MCP gateway without inference", async context => {
    if (gatewayBinary === undefined) {
      return context.skip("Set GH_AW_TEST_MCP_GATEWAY_BINARY to an absolute gateway executable path; the direct-backend fixture does not cover gateway negotiation.");
    }
    const evidence = await runFixture("gateway");
    expect(evidence.gateway).toMatchObject({ binary: gatewayBinary, version: expect.any(String), routesUsed: routes, stopped: true });
    expect(evidence.gateway.methods).toEqual(expect.arrayContaining(["server/discover", "initialize", "notifications/initialized", "tools/list", "tools/call"]));
    expect(evidence.gateway.authRejections).toEqual(Object.fromEntries(routes.map(route => [route, { missing: 401, invalid: 401, bearer: 401 }])));
  }, 250_000);
});
