import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

describe("promptless native SDK repository integration", () => {
  it("executes native inspection, fixed Go/Git and MCP declarations without inference", async () => {
    const filename = fileURLToPath(new URL("./fixtures/copilot_sdk_repository.fixture.cjs", import.meta.url));
    const result = await promisify(execFile)(process.execPath, [filename], { encoding: "utf8", timeout: 240_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true });
    const line = result.stdout.split(/\r?\n/).find(value => value.startsWith("SDK_REPOSITORY_RESULT="));
    expect(line, result.stderr).toBeTruthy();
    const evidence = JSON.parse(line.slice("SDK_REPOSITORY_RESULT=".length));
    expect(evidence).toMatchObject({ providerRequests: 0, unexpectedRequests: 0, reads: 1, forbiddenCalls: 0, outputs: ["create_pull_request", "noop"] });
    expect(evidence.actions).toEqual(["status", "prepare_branch", "format", "validate", "commit", "diff"]);
    expect(evidence.nativeTools.length).toBeGreaterThan(30);
    expect(evidence.nativeTools).not.toEqual(expect.arrayContaining(["bash", "write_bash", "task", "github-delete_file"]));
  }, 250_000);
});
