import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { GATEWAY_OUTPUT_LIMIT, requireGatewayBinary, withTimeout, createGatewayOutput, startMCPGateway } from "./fixtures/copilot_sdk_gateway.fixture.cjs";

const routes = ["/mcp/github", "/mcp/reference", "/mcp/safeoutputs"];
const directories = [];
const gateways = [];
const children = [];

afterEach(async () => {
  vi.useRealTimers();
  const results = await Promise.allSettled(gateways.splice(0).map(gateway => gateway.stop()));
  const failures = results.filter(result => result.status === "rejected").map(result => result.reason);
  for (const { child, closed } of children.splice(0)) {
    try {
      if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await withTimeout(() => closed, 3_000, "Test child cleanup");
    } catch (error) {
      failures.push(error);
    }
  }
  for (const directory of directories.splice(0)) {
    try {
      fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) throw new AggregateError(failures, "Gateway test cleanup failed");
});

function temporaryDirectory() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gh-aw-gateway-helper-test-"));
  directories.push(directory);
  return directory;
}

// This process double tests lifecycle/HTTP bounds only; it never substitutes for the opt-in real-gateway SDK integration.
const fakeGateway = `
const http = require("node:http");
const fs = require("node:fs");
const args = JSON.parse(process.argv[1]);
const scenario = process.argv[2];
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => input += chunk);
process.stdin.on("end", () => {
  if (scenario === "exit") {
    console.error("synthetic startup failure");
    process.exitCode = 7;
    return;
  }
  const config = JSON.parse(input);
  fs.writeFileSync("received-config.json", input);
  if (scenario === "ignore-term") process.on("SIGTERM", () => {});
  const listener = http.createServer((request, response) => {
    if (request.url === "/health") {
      if (scenario === "hang") return;
      if (scenario === "oversized") return response.end("x".repeat(40 * 1024));
      response.setHeader("Content-Type", "application/json");
      return response.end(JSON.stringify({ status: "healthy", gatewayVersion: "process-double", servers: config.mcpServers }));
    }
    if (scenario !== "no-auth" && request.headers.authorization !== config.gateway.agentId) {
      response.writeHead(401);
      return response.end("unauthorized");
    }
    if (request.headers["x-agent-id"] !== config.gateway.agentId) {
      response.writeHead(400);
      return response.end("inconsistent agent identity");
    }
    const name = request.url.split("/").at(-1);
    console.error("server:sdk-frontend >>> SDK Request [routed:" + name + "] session=test mcp-session=test method=POST path=" + request.url + " +0ms");
    response.end("{}");
  });
  const port = Number(args[args.indexOf("--listen") + 1].split(":").at(-1));
  listener.listen(port, "127.0.0.1");
});
`;

function gatewayOptions(scenario = "healthy") {
  const scratch = temporaryDirectory();
  const env = Object.fromEntries(["PATH", "Path", "SystemRoot", "WINDIR", "PATHEXT"].filter(key => process.env[key]).map(key => [key, process.env[key]]));
  const invocations = [];
  return {
    invocations,
    options: {
      binary: process.execPath,
      scratch,
      env,
      mcpServers: Object.fromEntries(routes.map(route => [route.split("/").at(-1), { type: "http", url: `http://127.0.0.1:1${route}`, headers: { Authorization: "synthetic-backend-token" } }])),
      startupTimeoutMs: scenario === "hang" ? 300 : 3_000,
      shutdownTimeoutMs: 3_000,
      spawnImpl(binary, args, options) {
        invocations.push({ binary, args, options });
        const child = scenario === "spawn-error" ? spawn(path.join(scratch, "missing-gateway.exe"), [], options) : spawn(binary, ["-e", fakeGateway, JSON.stringify(args), scenario], options);
        children.push({ child, closed: new Promise(resolve => child.once("close", resolve)) });
        return child;
      },
    },
  };
}

describe("bounded real-gateway fixture helper", () => {
  it("requires an explicit absolute executable and never resolves or falls back to a PATH binary", () => {
    expect(requireGatewayBinary(process.execPath)).toBe(process.execPath);
    for (const value of [undefined, "", " ", "awmg", ".\\awmg.exe"]) {
      expect(() => requireGatewayBinary(value)).toThrow("GH_AW_TEST_MCP_GATEWAY_BINARY");
    }
    const directory = temporaryDirectory();
    expect(() => requireGatewayBinary(directory)).toThrow("regular file");
    expect(() => requireGatewayBinary(path.join(directory, "missing-gateway.exe"))).toThrow();
  });

  it.each([
    [["--gateway"], undefined],
    [["--gateway"], ""],
    [[], "awmg"],
  ])("rejects a requested gateway with missing or relative input before SDK/repository setup (%j)", async (args, binary) => {
    const { options } = gatewayOptions();
    const env = { ...options.env };
    if (binary !== undefined) env.GH_AW_TEST_MCP_GATEWAY_BINARY = binary;
    const filename = fileURLToPath(new URL("./fixtures/copilot_sdk_repository.fixture.cjs", import.meta.url));
    await expect(promisify(execFile)(process.execPath, [filename, ...args], { env, encoding: "utf8", timeout: 5_000, maxBuffer: 32 * 1024, windowsHide: true })).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("GH_AW_TEST_MCP_GATEWAY_BINARY must be an absolute path"),
    });
  });

  it("bounds both output streams while retaining fragmented route and protocol-error evidence", () => {
    const output = createGatewayOutput(routes);
    const lines = [
      "server:sdk-frontend >>> SDK Request [routed:github] session=test mcp-session=none method=POST path=/mcp/github +0ms\n",
      "server:sdk-frontend JSON-RPC Request: method=server/discover id=1\n",
      "server:sdk-frontend JSON-RPC Request: method=tools/list id=2\n",
      'server:sdk-frontend JSON-RPC Error: code=-32022 message="Stateful handler" +0ms\n',
    ].join("");
    for (const character of lines) output.append("stderr", character);
    output.append("stdout", "x".repeat(GATEWAY_OUTPUT_LIMIT * 3));
    output.append("stderr", "z".repeat(GATEWAY_OUTPUT_LIMIT * 3));
    expect(output.evidence()).toEqual({ routesUsed: ["/mcp/github"], methods: ["server/discover", "tools/list"], rpcErrorCodes: [-32022] });
    const diagnostics = output.diagnostics();
    expect(diagnostics.match(/x/g)).toHaveLength(GATEWAY_OUTPUT_LIMIT);
    expect(diagnostics.match(/z/g)).toHaveLength(GATEWAY_OUTPUT_LIMIT);
    expect(Buffer.byteLength(diagnostics)).toBeLessThan(GATEWAY_OUTPUT_LIMIT * 2 + 200);
    expect(() => output.append("stdin", "invalid")).toThrow("Unknown gateway output stream");
  });

  it("does not count route registration, another server, GET requests or mismatched routes as authenticated SDK traffic", () => {
    const output = createGatewayOutput(routes);
    output.append(
      "stderr",
      [
        "Registered route: /mcp/github\n",
        ">>> SDK Request [routed:github] method=GET path=/mcp/github +0ms\n",
        ">>> SDK Request [routed:other] method=POST path=/mcp/other +0ms\n",
        ">>> SDK Request [routed:github] method=POST path=/mcp/safeoutputs +0ms\n",
      ].join("")
    );
    expect(output.evidence().routesUsed).toEqual([]);
  });

  it("clears operation deadlines on success and rejects a hung operation", async () => {
    vi.useFakeTimers();
    await expect(withTimeout(() => Promise.resolve("done"), 100, "Operation")).resolves.toBe("done");
    expect(vi.getTimerCount()).toBe(0);
    const pending = expect(withTimeout(() => new Promise(() => {}), 100, "Operation")).rejects.toThrow("Operation exceeded 100ms");
    await vi.advanceTimersByTimeAsync(100);
    await pending;
    expect(vi.getTimerCount()).toBe(0);
    for (const milliseconds of [0, -1, 0.5, 2_147_483_648]) {
      await expect(withTimeout(() => Promise.resolve(), milliseconds, "Operation")).rejects.toThrow("representable millisecond timeout");
    }
  });

  it("spawns one HTTP-only gateway without a shell, probes raw-token auth, observes routes and removes all scratch data", async () => {
    const { options, invocations } = gatewayOptions();
    const gateway = await startMCPGateway(options);
    gateways.push(gateway);
    expect(gateway.evidence()).toMatchObject({ routesUsed: [], methods: [], rpcErrorCodes: [] });
    expect(invocations).toHaveLength(1);
    const { binary, args, options: spawnOptions } = invocations[0];
    expect(binary).toBe(process.execPath);
    expect(args).toEqual([
      "--config-stdin",
      "--routed",
      "--listen",
      new URL(gateway.address).host,
      "--log-dir",
      path.join(gateway.directory, "logs"),
      "--payload-dir",
      path.join(gateway.directory, "payloads"),
      "--wasm-cache-dir",
      path.join(gateway.directory, "wasm-cache"),
      "--shutdown-timeout",
      "2s",
    ]);
    expect(spawnOptions).toMatchObject({ cwd: gateway.directory, shell: false, detached: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    expect(spawnOptions.env).toEqual({
      ...options.env,
      TEMP: path.join(gateway.directory, "tmp"),
      TMP: path.join(gateway.directory, "tmp"),
      TMPDIR: path.join(gateway.directory, "tmp"),
      DEBUG: "server:sdk-frontend,server:auth",
      DEBUG_COLORS: "0",
    });
    const config = JSON.parse(fs.readFileSync(path.join(gateway.directory, "received-config.json"), "utf8"));
    expect(config).toEqual({ mcpServers: options.mcpServers, gateway: { port: Number(new URL(gateway.address).port), domain: "localhost", agentId: gateway.headers.Authorization } });
    expect(gateway.headers["X-Agent-ID"]).toBe(gateway.headers.Authorization);
    expect(gateway.headers.Authorization).not.toMatch(/^Bearer /);
    expect(gateway.evidence().authRejections).toEqual(Object.fromEntries(routes.map(route => [route, { missing: 401, invalid: 401, bearer: 401 }])));
    await Promise.all(
      routes.map(async route => {
        const response = await fetch(`${gateway.address}${route}`, { method: "POST", headers: gateway.headers, signal: AbortSignal.timeout(2_000) });
        expect(response.status).toBe(200);
        await response.text();
      })
    );
    await vi.waitFor(() => expect(gateway.evidence().routesUsed).toEqual(routes));
    gateway.assertRunning();
    await gateway.stop();
    await gateway.stop();
    expect(gateway.evidence().stopped).toBe(true);
    expect(fs.existsSync(gateway.directory)).toBe(false);
    expect(fs.readdirSync(options.scratch)).toEqual([]);
  });

  it.each([
    ["exit", "synthetic startup failure"],
    ["hang", "Gateway startup exceeded"],
    ["oversized", "Gateway probe response exceeds 32 KiB"],
    ["no-auth", "must reject missing Authorization"],
    ["spawn-error", "ENOENT"],
  ])("cleans up after %s instead of falling back to a direct backend", async (scenario, message) => {
    const { options } = gatewayOptions(scenario);
    await expect(startMCPGateway(options)).rejects.toThrow(message);
    const { child, closed } = children.at(-1);
    await closed;
    expect(child.pid === undefined || child.exitCode !== null || child.signalCode !== null).toBe(true);
    expect(fs.readdirSync(options.scratch)).toEqual([]);
  });

  it("uses only the owned child PID when termination needs escalation", async () => {
    const { options } = gatewayOptions("ignore-term");
    const gateway = await startMCPGateway(options);
    gateways.push(gateway);
    const { child } = children.at(-1);
    const kill = vi.spyOn(child, "kill");
    await gateway.stop();
    expect(kill.mock.calls.map(([signal]) => signal)).toEqual(process.platform === "win32" ? ["SIGTERM"] : ["SIGTERM", "SIGKILL"]);
    expect(gateway.evidence()).toMatchObject({ stopped: true, forcedStop: process.platform !== "win32" });
    expect(fs.existsSync(gateway.directory)).toBe(false);
  });

  it("reports a process that exits after readiness instead of returning success-shaped evidence", async () => {
    const { options } = gatewayOptions();
    const gateway = await startMCPGateway(options);
    gateways.push(gateway);
    const { child, closed } = children.at(-1);
    child.kill("SIGTERM");
    await withTimeout(() => closed, 3_000, "Unexpected child exit");
    expect(() => gateway.assertRunning()).toThrow("Gateway exited before fixture completion");
    await gateway.stop();
    expect(fs.readdirSync(options.scratch)).toEqual([]);
  });

  it("rejects non-HTTP and non-loopback upstreams before creating a process", async () => {
    for (const server of [
      { type: "stdio", url: "http://127.0.0.1:1/mcp" },
      { type: "http", url: "https://example.invalid/mcp" },
      { type: "http", url: "http://127.0.0.1:1/mcp", args: ["ignored"] },
    ]) {
      const { options, invocations } = gatewayOptions();
      await expect(startMCPGateway({ ...options, mcpServers: { github: server } })).rejects.toThrow(/HTTP|loopback/);
      expect(invocations).toEqual([]);
      expect(fs.readdirSync(options.scratch)).toEqual([]);
    }
  });

  it("rejects unbounded startup and shutdown budgets before creating a process", async () => {
    for (const budget of [{ startupTimeoutMs: 0 }, { startupTimeoutMs: 30_001 }, { shutdownTimeoutMs: 0 }, { shutdownTimeoutMs: 3_001 }]) {
      const { options, invocations } = gatewayOptions();
      await expect(startMCPGateway({ ...options, ...budget })).rejects.toThrow("timeout must be between");
      expect(invocations).toEqual([]);
      expect(fs.readdirSync(options.scratch)).toEqual([]);
    }
  });
});
