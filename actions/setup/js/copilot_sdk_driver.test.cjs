import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { createRequire } from "module";
import { spawnSync } from "child_process";
import { Writable } from "stream";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const require = createRequire(import.meta.url);
const { runWithCopilotSDK, parsePermissionConfigFromServerArgs } = require("./copilot_sdk_driver.cjs");

describe("copilot_sdk_driver.cjs", () => {
  let testSessionStateDir;
  let prevSessionStateDir;
  beforeAll(() => {
    prevSessionStateDir = process.env.GH_AW_SESSION_STATE_BASE_DIR;
    testSessionStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "gh-aw-test-session-state-"));
    process.env.GH_AW_SESSION_STATE_BASE_DIR = testSessionStateDir;
  });
  afterAll(() => {
    if (prevSessionStateDir === undefined) delete process.env.GH_AW_SESSION_STATE_BASE_DIR;
    else process.env.GH_AW_SESSION_STATE_BASE_DIR = prevSessionStateDir;
    if (testSessionStateDir) fs.rmSync(testSessionStateDir, { recursive: true, force: true });
  });

  describe("runWithCopilotSDK", () => {
    it("disconnects session and stops client on success", async () => {
      const disconnect = vi.fn().mockResolvedValue(undefined);
      const stop = vi.fn().mockResolvedValue(undefined);
      const stderrWriteSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      try {
        let onEvent = () => {};
        const session = {
          sessionId: "session-success",
          on: handler => {
            onEvent = handler;
          },
          sendAndWait: vi.fn().mockImplementation(async () => {
            onEvent({
              type: "assistant.message",
              ephemeral: false,
              timestamp: new Date().toISOString(),
              data: { content: "hello from sdk" },
            });
            return { data: { content: "hello from sdk" } };
          }),
          disconnect,
        };
        class FakeCopilotClient {
          start = vi.fn().mockResolvedValue(undefined);
          createSession = vi.fn().mockResolvedValue(session);
          stop = stop;
        }

        const result = await runWithCopilotSDK({
          sdkUri: "http://127.0.0.1:3002",
          prompt: "test prompt",
          logger: () => {},
          sdkModule: {
            CopilotClient: FakeCopilotClient,
            RuntimeConnection: { forUri: vi.fn(() => ({})) },
            approveAll: () => "allow",
          },
        });

        expect(result.exitCode).toBe(0);
        expect(result.hasOutput).toBe(true);
        expect(result.output).toContain("hello from sdk");
        expect(disconnect).toHaveBeenCalledTimes(1);
        expect(stop).toHaveBeenCalledTimes(1);
        const parsedEvents = stderrWriteSpy.mock.calls
          .map(([message]) => {
            if (typeof message !== "string" || !message.endsWith("\n")) return null;
            try {
              return JSON.parse(message.trimEnd());
            } catch {
              return null;
            }
          })
          .filter(Boolean);
        const parsedEvent = parsedEvents.find(event => event.type === "assistant.message");
        expect(parsedEvent).toMatchObject({
          type: "assistant.message",
          data: { content: "hello from sdk" },
        });
        expect(typeof parsedEvent.timestamp).toBe("string");
      } finally {
        stderrWriteSpy.mockRestore();
      }
    });

    it("clears cleanup timeout deadlines when cleanup settles promptly", async () => {
      const disconnect = vi.fn().mockResolvedValue(undefined);
      const stop = vi.fn().mockResolvedValue(undefined);
      let onEvent = () => {};
      const session = {
        sessionId: "session-cleanup-timeouts-cleared",
        on: handler => {
          onEvent = handler;
        },
        sendAndWait: vi.fn().mockImplementation(async () => {
          onEvent({
            type: "assistant.message",
            ephemeral: false,
            timestamp: new Date().toISOString(),
            data: { content: "done" },
          });
          return { data: { content: "done" } };
        }),
        disconnect,
      };
      class FakeCopilotClient {
        start = vi.fn().mockResolvedValue(undefined);
        createSession = vi.fn().mockResolvedValue(session);
        stop = stop;
      }

      const realSetTimeout = global.setTimeout;
      const realClearTimeout = global.clearTimeout;
      const cleanupTimeoutHandles = new Set();
      const clearedCleanupTimeoutHandles = new Set();
      const referencedCleanupTimeoutHandles = new Set();
      const setTimeoutSpy = vi.spyOn(global, "setTimeout").mockImplementation((fn, delay, ...args) => {
        const handle = realSetTimeout(fn, delay, ...args);
        if (delay === 5_000) cleanupTimeoutHandles.add(handle);
        return handle;
      });
      const clearTimeoutSpy = vi.spyOn(global, "clearTimeout").mockImplementation(handle => {
        if (cleanupTimeoutHandles.has(handle)) {
          clearedCleanupTimeoutHandles.add(handle);
          if (handle.hasRef()) referencedCleanupTimeoutHandles.add(handle);
        }
        return realClearTimeout(handle);
      });

      try {
        const result = await runWithCopilotSDK({
          sdkUri: "http://127.0.0.1:3002",
          prompt: "test prompt",
          logger: () => {},
          sdkModule: {
            CopilotClient: FakeCopilotClient,
            RuntimeConnection: { forUri: vi.fn(() => ({})) },
            approveAll: () => "allow",
          },
        });

        expect(result.exitCode).toBe(0);
        expect(cleanupTimeoutHandles.size).toBe(3);
        expect(clearedCleanupTimeoutHandles.size).toBe(3);
        expect(referencedCleanupTimeoutHandles.size).toBe(3);
      } finally {
        setTimeoutSpy.mockRestore();
        clearTimeoutSpy.mockRestore();
      }
    });

    it("disconnects session and stops client on send failure", async () => {
      const disconnect = vi.fn().mockResolvedValue(undefined);
      const stop = vi.fn().mockResolvedValue(undefined);
      const session = {
        sessionId: "session-failure",
        on: () => {},
        sendAndWait: vi.fn().mockRejectedValue(new Error("send failed")),
        disconnect,
      };
      class FakeCopilotClient {
        start = vi.fn().mockResolvedValue(undefined);
        createSession = vi.fn().mockResolvedValue(session);
        stop = stop;
      }

      const result = await runWithCopilotSDK({
        sdkUri: "http://127.0.0.1:3002",
        prompt: "test prompt",
        logger: () => {},
        sdkModule: {
          CopilotClient: FakeCopilotClient,
          RuntimeConnection: { forUri: vi.fn(() => ({})) },
          approveAll: () => "allow",
        },
      });

      expect(result.exitCode).toBe(1);
      expect(result.output).toContain("send failed");
      expect(disconnect).toHaveBeenCalledTimes(1);
      expect(stop).toHaveBeenCalledTimes(1);
    });

    it("serializes tool.execution_start command details when available", async () => {
      const disconnect = vi.fn().mockResolvedValue(undefined);
      const stop = vi.fn().mockResolvedValue(undefined);
      const stderrWriteSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      try {
        let onEvent = () => {};
        const session = {
          sessionId: "session-tool-start-command",
          on: handler => {
            onEvent = handler;
          },
          sendAndWait: vi.fn().mockImplementation(async () => {
            onEvent({
              type: "tool.execution_start",
              ephemeral: false,
              timestamp: new Date().toISOString(),
              data: {
                toolName: "bash",
                mcpServerName: "terminal",
                input: { command: "git status" },
              },
            });
            onEvent({
              type: "assistant.message",
              ephemeral: false,
              timestamp: new Date().toISOString(),
              data: { content: "ok" },
            });
            return { data: { content: "ok" } };
          }),
          disconnect,
        };
        class FakeCopilotClient {
          start = vi.fn().mockResolvedValue(undefined);
          createSession = vi.fn().mockResolvedValue(session);
          stop = stop;
        }

        const result = await runWithCopilotSDK({
          sdkUri: "http://127.0.0.1:3002",
          prompt: "test prompt",
          logger: () => {},
          sdkModule: {
            CopilotClient: FakeCopilotClient,
            RuntimeConnection: { forUri: vi.fn(() => ({})) },
            approveAll: () => "allow",
          },
        });

        expect(result.exitCode).toBe(0);
        const parsedEvents = stderrWriteSpy.mock.calls
          .map(([message]) => {
            if (typeof message !== "string" || !message.endsWith("\n")) return null;
            try {
              return JSON.parse(message.trimEnd());
            } catch {
              return null;
            }
          })
          .filter(Boolean);
        const startEvent = parsedEvents.find(event => event.type === "tool.execution_start");
        expect(startEvent).toMatchObject({
          type: "tool.execution_start",
          data: { toolName: "bash", mcpServerName: "terminal", command: "git status" },
        });
      } finally {
        stderrWriteSpy.mockRestore();
      }
    });

    it("resolves exitCode 0 on SDK idle-timeout when output collected and all tool calls complete", async () => {
      // Regression test: when sendAndWait throws an idle-timeout error but the agent
      // produced output and all tool calls completed, the driver must return exitCode 0.
      // This covers the case where the SDK drops the session.idle signal on long runs.
      const disconnect = vi.fn().mockResolvedValue(undefined);
      const stop = vi.fn().mockResolvedValue(undefined);
      let onEvent = () => {};
      const session = {
        sessionId: "session-idle-timeout-success",
        on: handler => {
          onEvent = handler;
        },
        sendAndWait: vi.fn().mockImplementation(async () => {
          // Simulate tool execution events before the idle-timeout
          onEvent({
            type: "tool.execution_start",
            ephemeral: false,
            timestamp: new Date().toISOString(),
            data: { toolName: "bash", mcpServerName: "terminal", toolCallId: "call-1" },
          });
          onEvent({
            type: "assistant.message",
            ephemeral: false,
            timestamp: new Date().toISOString(),
            data: { content: "I found the answer" },
          });
          onEvent({
            type: "tool.execution_complete",
            ephemeral: false,
            timestamp: new Date().toISOString(),
            data: { toolCallId: "call-1", success: true },
          });
          throw new Error("Timeout after 870000ms waiting for session.idle");
        }),
        disconnect,
      };
      class FakeCopilotClient {
        start = vi.fn().mockResolvedValue(undefined);
        createSession = vi.fn().mockResolvedValue(session);
        stop = stop;
      }

      const result = await runWithCopilotSDK({
        sdkUri: "http://127.0.0.1:3002",
        prompt: "test prompt",
        logger: () => {},
        sdkModule: {
          CopilotClient: FakeCopilotClient,
          RuntimeConnection: { forUri: vi.fn(() => ({})) },
          approveAll: () => "allow",
        },
      });

      expect(result.exitCode).toBe(0);
      expect(result.hasOutput).toBe(true);
      expect(result.output).toContain("I found the answer");
      expect(disconnect).toHaveBeenCalledTimes(1);
      expect(stop).toHaveBeenCalledTimes(1);
    });

    it("returns exitCode 1 on SDK idle-timeout when tool calls are still pending", async () => {
      // When the idle-timeout fires with in-flight (unmatched) tool calls, the agent did
      // not finish cleanly — the driver must NOT treat it as success.
      const disconnect = vi.fn().mockResolvedValue(undefined);
      const stop = vi.fn().mockResolvedValue(undefined);
      let onEvent = () => {};
      const session = {
        sessionId: "session-idle-timeout-pending-tools",
        on: handler => {
          onEvent = handler;
        },
        sendAndWait: vi.fn().mockImplementation(async () => {
          onEvent({
            type: "tool.execution_start",
            ephemeral: false,
            timestamp: new Date().toISOString(),
            data: { toolName: "bash", mcpServerName: "terminal", toolCallId: "call-pending" },
          });
          onEvent({
            type: "assistant.message",
            ephemeral: false,
            timestamp: new Date().toISOString(),
            data: { content: "working on it" },
          });
          // tool.execution_complete is never emitted — tool call remains pending
          throw new Error("Timeout after 870000ms waiting for session.idle");
        }),
        disconnect,
      };
      class FakeCopilotClient {
        start = vi.fn().mockResolvedValue(undefined);
        createSession = vi.fn().mockResolvedValue(session);
        stop = stop;
      }

      const result = await runWithCopilotSDK({
        sdkUri: "http://127.0.0.1:3002",
        prompt: "test prompt",
        logger: () => {},
        sdkModule: {
          CopilotClient: FakeCopilotClient,
          RuntimeConnection: { forUri: vi.fn(() => ({})) },
          approveAll: () => "allow",
        },
      });

      expect(result.exitCode).toBe(1);
      expect(result.hasOutput).toBe(true);
      expect(result.output).toContain("working on it");
    });

    it("returns exitCode 1 on SDK idle-timeout with no output collected", async () => {
      // When the idle-timeout fires before the agent produces any output, the driver
      // must return exitCode 1 — there is nothing useful to surface.
      const disconnect = vi.fn().mockResolvedValue(undefined);
      const stop = vi.fn().mockResolvedValue(undefined);
      const session = {
        sessionId: "session-idle-timeout-no-output",
        on: () => {},
        sendAndWait: vi.fn().mockRejectedValue(new Error("Timeout after 870000ms waiting for session.idle")),
        disconnect,
      };
      class FakeCopilotClient {
        start = vi.fn().mockResolvedValue(undefined);
        createSession = vi.fn().mockResolvedValue(session);
        stop = stop;
      }

      const result = await runWithCopilotSDK({
        sdkUri: "http://127.0.0.1:3002",
        prompt: "test prompt",
        logger: () => {},
        sdkModule: {
          CopilotClient: FakeCopilotClient,
          RuntimeConnection: { forUri: vi.fn(() => ({})) },
          approveAll: () => "allow",
        },
      });

      expect(result.exitCode).toBe(1);
      expect(result.hasOutput).toBe(false);
    });

    it("post-completion idle watchdog fires and treats session as completed", async () => {
      // Regression test: when sendAndWait hangs after the agent's final tool result
      // (the SDK post-completion hang), the watchdog must force-disconnect and the
      // driver must return exitCode 0 with the collected output.
      const stop = vi.fn().mockResolvedValue(undefined);
      let onEvent = () => {};
      // disconnectCalled resolves when the watchdog calls session.disconnect()
      let resolveDisconnect;
      const disconnectCalled = new Promise(resolve => {
        resolveDisconnect = resolve;
      });
      const disconnectWithSignal = vi.fn().mockImplementation(() => {
        resolveDisconnect();
        return Promise.resolve(undefined);
      });

      const session = {
        sessionId: "session-watchdog-fires",
        on: handler => {
          onEvent = handler;
        },
        // sendAndWait emits events that satisfy completion conditions, then hangs
        // until the watchdog forces a disconnect.
        sendAndWait: vi.fn().mockImplementation(async () => {
          onEvent({
            type: "tool.execution_start",
            ephemeral: false,
            timestamp: new Date().toISOString(),
            data: { toolName: "create_issue", mcpServerName: "safeoutputs", toolCallId: "call-watchdog" },
          });
          onEvent({
            type: "assistant.message",
            ephemeral: false,
            timestamp: new Date().toISOString(),
            data: { content: "Issue filed successfully" },
          });
          onEvent({
            type: "tool.execution_complete",
            ephemeral: false,
            timestamp: new Date().toISOString(),
            data: { toolCallId: "call-watchdog", success: true },
          });
          // Simulate sendAndWait hanging — wait until the watchdog disconnects.
          await disconnectCalled;
          throw new Error("transport disconnected");
        }),
        disconnect: disconnectWithSignal,
      };
      class FakeCopilotClient {
        start = vi.fn().mockResolvedValue(undefined);
        createSession = vi.fn().mockResolvedValue(session);
        stop = stop;
      }

      const prevIdleMs = process.env.GH_AW_SDK_IDLE_MS;
      // Use a very short idle timeout so the watchdog fires quickly in tests.
      process.env.GH_AW_SDK_IDLE_MS = "20";
      try {
        const result = await runWithCopilotSDK({
          sdkUri: "http://127.0.0.1:3002",
          prompt: "test prompt",
          logger: () => {},
          sdkModule: {
            CopilotClient: FakeCopilotClient,
            RuntimeConnection: { forUri: vi.fn(() => ({})) },
            approveAll: () => "allow",
          },
        });

        expect(result.exitCode).toBe(0);
        expect(result.hasOutput).toBe(true);
        expect(result.output).toContain("Issue filed successfully");
        // The watchdog unwinds the send; common cleanup disconnects exactly once.
        expect(disconnectWithSignal).toHaveBeenCalledTimes(1);
        expect(stop).toHaveBeenCalledTimes(1);
      } finally {
        if (prevIdleMs === undefined) delete process.env.GH_AW_SDK_IDLE_MS;
        else process.env.GH_AW_SDK_IDLE_MS = prevIdleMs;
      }
    });

    it("cleanup timeout prevents hang when client.stop() never resolves", async () => {
      // Regression: when the SDK server is unresponsive, client.stop() in the
      // finally block can hang indefinitely, causing the process to be killed by
      // the step timeout instead of exiting cleanly with success.
      // The 5-second cleanup timeout must bound the hang and allow the function
      // to return with exitCode 0 within a reasonable wall-clock budget.
      let onEvent = () => {};
      let resolveDisconnect;
      const disconnectCalled = new Promise(resolve => {
        resolveDisconnect = resolve;
      });
      const disconnectWithSignal = vi.fn().mockImplementation(() => {
        resolveDisconnect();
        return Promise.resolve(undefined);
      });
      // stop() never resolves — simulates a hung SDK server.
      const hangingStop = vi.fn().mockReturnValue(new Promise(() => {}));

      const session = {
        sessionId: "session-cleanup-timeout",
        on: handler => {
          onEvent = handler;
        },
        sendAndWait: vi.fn().mockImplementation(async () => {
          onEvent({
            type: "assistant.message",
            ephemeral: false,
            timestamp: new Date().toISOString(),
            data: { content: "work done" },
          });
          await disconnectCalled;
          throw new Error("transport disconnected");
        }),
        disconnect: disconnectWithSignal,
      };
      class FakeCopilotClient {
        start = vi.fn().mockResolvedValue(undefined);
        createSession = vi.fn().mockResolvedValue(session);
        stop = hangingStop;
      }

      const prevIdleMs = process.env.GH_AW_SDK_IDLE_MS;
      process.env.GH_AW_SDK_IDLE_MS = "20";
      try {
        const start = Date.now();
        const result = await runWithCopilotSDK({
          sdkUri: "http://127.0.0.1:3002",
          prompt: "test prompt",
          logger: () => {},
          sdkModule: {
            CopilotClient: FakeCopilotClient,
            RuntimeConnection: { forUri: vi.fn(() => ({})) },
            approveAll: () => "allow",
          },
        });
        const elapsed = Date.now() - start;

        expect(result.exitCode).toBe(0);
        expect(result.hasOutput).toBe(true);
        expect(result.output).toContain("work done");
        // stop() was called but hung — the cleanup timeout must have unblocked.
        expect(hangingStop).toHaveBeenCalledTimes(1);
        // Should complete well within 10 seconds (5s cleanup timeout + overhead).
        expect(elapsed).toBeLessThan(10_000);
      } finally {
        if (prevIdleMs === undefined) delete process.env.GH_AW_SDK_IDLE_MS;
        else process.env.GH_AW_SDK_IDLE_MS = prevIdleMs;
      }
    });

    it("post-completion watchdog does not fire when tool calls are still pending", async () => {
      // When a new tool call starts after the watchdog would have been armed,
      // the watchdog must be disarmed so it does not fire while work is in progress.
      const disconnect = vi.fn().mockResolvedValue(undefined);
      const stop = vi.fn().mockResolvedValue(undefined);
      let onEvent = () => {};

      const session = {
        sessionId: "session-watchdog-disarmed",
        on: handler => {
          onEvent = handler;
        },
        sendAndWait: vi.fn().mockImplementation(async () => {
          // First, reach the "post-completion" state that would arm the watchdog.
          onEvent({
            type: "assistant.message",
            ephemeral: false,
            timestamp: new Date().toISOString(),
            data: { content: "still working" },
          });
          // Then start a new tool call — this must disarm the watchdog.
          onEvent({
            type: "tool.execution_start",
            ephemeral: false,
            timestamp: new Date().toISOString(),
            data: { toolName: "bash", mcpServerName: "terminal", toolCallId: "call-new" },
          });
          // Complete the new tool call and produce more output.
          onEvent({
            type: "tool.execution_complete",
            ephemeral: false,
            timestamp: new Date().toISOString(),
            data: { toolCallId: "call-new", success: true },
          });
          onEvent({
            type: "assistant.message",
            ephemeral: false,
            timestamp: new Date().toISOString(),
            data: { content: "done now" },
          });
          // sendAndWait resolves normally — no disconnect needed.
          return { data: { content: "done now" } };
        }),
        disconnect,
      };
      class FakeCopilotClient {
        start = vi.fn().mockResolvedValue(undefined);
        createSession = vi.fn().mockResolvedValue(session);
        stop = stop;
      }

      const prevIdleMs = process.env.GH_AW_SDK_IDLE_MS;
      process.env.GH_AW_SDK_IDLE_MS = "20";
      try {
        const result = await runWithCopilotSDK({
          sdkUri: "http://127.0.0.1:3002",
          prompt: "test prompt",
          logger: () => {},
          sdkModule: {
            CopilotClient: FakeCopilotClient,
            RuntimeConnection: { forUri: vi.fn(() => ({})) },
            approveAll: () => "allow",
          },
        });

        expect(result.exitCode).toBe(0);
        expect(result.hasOutput).toBe(true);
        expect(result.output).toContain("done now");
        // Only one disconnect: from the finally block (normal completion path).
        expect(disconnect).toHaveBeenCalledTimes(1);
      } finally {
        if (prevIdleMs === undefined) delete process.env.GH_AW_SDK_IDLE_MS;
        else process.env.GH_AW_SDK_IDLE_MS = prevIdleMs;
      }
    });

    it("post-completion watchdog does not trigger when output not yet collected", async () => {
      // The watchdog must not arm when no output has been collected — only
      // after the agent has produced real work product.
      const disconnect = vi.fn().mockResolvedValue(undefined);
      const stop = vi.fn().mockResolvedValue(undefined);
      let onEvent = () => {};

      const session = {
        sessionId: "session-watchdog-no-output",
        on: handler => {
          onEvent = handler;
        },
        sendAndWait: vi.fn().mockImplementation(async () => {
          // Tool completes but no assistant.message yet — watchdog must not arm.
          onEvent({
            type: "tool.execution_start",
            ephemeral: false,
            timestamp: new Date().toISOString(),
            data: { toolName: "bash", mcpServerName: "terminal", toolCallId: "call-early" },
          });
          onEvent({
            type: "tool.execution_complete",
            ephemeral: false,
            timestamp: new Date().toISOString(),
            data: { toolCallId: "call-early", success: true },
          });
          // Now session produces output and completes normally.
          onEvent({
            type: "assistant.message",
            ephemeral: false,
            timestamp: new Date().toISOString(),
            data: { content: "here is the result" },
          });
          return { data: { content: "here is the result" } };
        }),
        disconnect,
      };
      class FakeCopilotClient {
        start = vi.fn().mockResolvedValue(undefined);
        createSession = vi.fn().mockResolvedValue(session);
        stop = stop;
      }

      const prevIdleMs = process.env.GH_AW_SDK_IDLE_MS;
      process.env.GH_AW_SDK_IDLE_MS = "20";
      try {
        const result = await runWithCopilotSDK({
          sdkUri: "http://127.0.0.1:3002",
          prompt: "test prompt",
          logger: () => {},
          sdkModule: {
            CopilotClient: FakeCopilotClient,
            RuntimeConnection: { forUri: vi.fn(() => ({})) },
            approveAll: () => "allow",
          },
        });

        expect(result.exitCode).toBe(0);
        expect(result.hasOutput).toBe(true);
        expect(result.output).toContain("here is the result");
        // Disconnect only once: from the normal finally-block cleanup.
        expect(disconnect).toHaveBeenCalledTimes(1);
      } finally {
        if (prevIdleMs === undefined) delete process.env.GH_AW_SDK_IDLE_MS;
        else process.env.GH_AW_SDK_IDLE_MS = prevIdleMs;
      }
    });

    it("post-completion watchdog does not treat success as failure when sendAndWait resolves before timer fires", async () => {
      // When sendAndWait resolves normally before the watchdog fires, the session
      // should complete with exitCode 0 and no disconnect from the watchdog.
      const disconnect = vi.fn().mockResolvedValue(undefined);
      const stop = vi.fn().mockResolvedValue(undefined);
      let onEvent = () => {};

      const session = {
        sessionId: "session-watchdog-not-needed",
        on: handler => {
          onEvent = handler;
        },
        sendAndWait: vi.fn().mockImplementation(async () => {
          onEvent({
            type: "assistant.message",
            ephemeral: false,
            timestamp: new Date().toISOString(),
            data: { content: "completed normally" },
          });
          // sendAndWait resolves before watchdog fires (watchdog idle = 500ms in test —
          // large enough that normal completion always wins the race on any CI runner).
          return { data: { content: "completed normally" } };
        }),
        disconnect,
      };
      class FakeCopilotClient {
        start = vi.fn().mockResolvedValue(undefined);
        createSession = vi.fn().mockResolvedValue(session);
        stop = stop;
      }

      const prevIdleMs = process.env.GH_AW_SDK_IDLE_MS;
      process.env.GH_AW_SDK_IDLE_MS = "500";
      try {
        const result = await runWithCopilotSDK({
          sdkUri: "http://127.0.0.1:3002",
          prompt: "test prompt",
          logger: () => {},
          sdkModule: {
            CopilotClient: FakeCopilotClient,
            RuntimeConnection: { forUri: vi.fn(() => ({})) },
            approveAll: () => "allow",
          },
        });

        expect(result.exitCode).toBe(0);
        expect(result.hasOutput).toBe(true);
        expect(result.output).toContain("completed normally");
        // Disconnect called once (finally), not twice.
        expect(disconnect).toHaveBeenCalledTimes(1);
      } finally {
        if (prevIdleMs === undefined) delete process.env.GH_AW_SDK_IDLE_MS;
        else process.env.GH_AW_SDK_IDLE_MS = prevIdleMs;
      }
    });

    it("post-completion watchdog is disarmed during assistant.turn_start → turn_end cycle", async () => {
      // When a new turn starts (assistant.turn_start) after the first output is
      // produced and all tool calls complete, the watchdog must not fire until
      // the turn ends (assistant.turn_end). This prevents a premature
      // force-disconnect while the LLM is still doing inference.
      const disconnect = vi.fn().mockResolvedValue(undefined);
      const stop = vi.fn().mockResolvedValue(undefined);
      let onEvent = () => {};

      const session = {
        sessionId: "session-watchdog-turn-disarm",
        on: handler => {
          onEvent = handler;
        },
        sendAndWait: vi.fn().mockImplementation(async () => {
          // Produce output and complete all tool calls — watchdog would arm here.
          onEvent({
            type: "assistant.message",
            ephemeral: false,
            timestamp: new Date().toISOString(),
            data: { content: "first result" },
          });
          // New turn starts — must disarm watchdog immediately.
          onEvent({
            type: "assistant.turn_start",
            ephemeral: false,
            timestamp: new Date().toISOString(),
            data: { turnId: "turn-2" },
          });
          // Turn ends — watchdog may re-arm now.
          onEvent({
            type: "assistant.turn_end",
            ephemeral: false,
            timestamp: new Date().toISOString(),
            data: { turnId: "turn-2" },
          });
          // Additional output and normal resolution.
          onEvent({
            type: "assistant.message",
            ephemeral: false,
            timestamp: new Date().toISOString(),
            data: { content: " second result" },
          });
          return { data: { content: " second result" } };
        }),
        disconnect,
      };
      class FakeCopilotClient {
        start = vi.fn().mockResolvedValue(undefined);
        createSession = vi.fn().mockResolvedValue(session);
        stop = stop;
      }

      const prevIdleMs = process.env.GH_AW_SDK_IDLE_MS;
      // Short watchdog — if the turn_start guard is missing, the watchdog
      // would fire before sendAndWait resolves. 1000ms gives enough headroom
      // on slow CI while still detecting a missing guard reliably.
      process.env.GH_AW_SDK_IDLE_MS = "1000";
      try {
        const result = await runWithCopilotSDK({
          sdkUri: "http://127.0.0.1:3002",
          prompt: "test prompt",
          logger: () => {},
          sdkModule: {
            CopilotClient: FakeCopilotClient,
            RuntimeConnection: { forUri: vi.fn(() => ({})) },
            approveAll: () => "allow",
          },
        });

        expect(result.exitCode).toBe(0);
        expect(result.hasOutput).toBe(true);
        // Disconnect called once (finally), not twice.
        expect(disconnect).toHaveBeenCalledTimes(1);
      } finally {
        if (prevIdleMs === undefined) delete process.env.GH_AW_SDK_IDLE_MS;
        else process.env.GH_AW_SDK_IDLE_MS = prevIdleMs;
      }
    });

    it("session.task_complete is written to events.jsonl", async () => {
      // session.task_complete must be serialized to the JSONL log so that
      // unified_timeline.cjs can surface the agent's task summary.
      const disconnect = vi.fn().mockResolvedValue(undefined);
      const stop = vi.fn().mockResolvedValue(undefined);
      let onEvent = () => {};
      const sessionId = "session-task-complete-jsonl";

      const session = {
        sessionId,
        on: handler => {
          onEvent = handler;
        },
        sendAndWait: vi.fn().mockImplementation(async () => {
          onEvent({
            type: "assistant.message",
            ephemeral: false,
            timestamp: new Date().toISOString(),
            data: { content: "work done" },
          });
          onEvent({
            type: "session.task_complete",
            ephemeral: false,
            timestamp: new Date().toISOString(),
            data: { success: true, summary: "Created 3 issues successfully" },
          });
          return { data: { content: "work done" } };
        }),
        disconnect,
      };
      class FakeCopilotClient {
        start = vi.fn().mockResolvedValue(undefined);
        createSession = vi.fn().mockResolvedValue(session);
        stop = stop;
      }

      const result = await runWithCopilotSDK({
        sdkUri: "http://127.0.0.1:3002",
        prompt: "test prompt",
        logger: () => {},
        sdkModule: {
          CopilotClient: FakeCopilotClient,
          RuntimeConnection: { forUri: vi.fn(() => ({})) },
          approveAll: () => "allow",
        },
      });

      expect(result.exitCode).toBe(0);

      // Read the JSONL and verify the task_complete entry is present.
      const eventsPath = path.join(testSessionStateDir, sessionId, "events.jsonl");
      const lines = fs
        .readFileSync(eventsPath, "utf8")
        .trim()
        .split("\n")
        .map(l => JSON.parse(l));
      const taskCompleteEvent = lines.find(e => e.type === "session.task_complete");
      expect(taskCompleteEvent).toBeDefined();
      expect(taskCompleteEvent.data.success).toBe(true);
      expect(taskCompleteEvent.data.summary).toBe("Created 3 issues successfully");
    });

    it("passes multi-provider config and model through to SDK createSession", async () => {
      const disconnect = vi.fn().mockResolvedValue(undefined);
      const stop = vi.fn().mockResolvedValue(undefined);
      const forUri = vi.fn(() => ({}));
      const createSession = vi.fn().mockResolvedValue({
        sessionId: "session-provider",
        on: () => {},
        sendAndWait: vi.fn().mockResolvedValue({ data: { content: "ok" } }),
        disconnect,
      });
      class FakeCopilotClient {
        start = vi.fn().mockResolvedValue(undefined);
        createSession = createSession;
        stop = stop;
      }

      const providers = [{ name: "copilot", type: "openai", baseUrl: "http://api-proxy:10002", wireApi: "responses" }];
      const models = [{ id: "gpt-5.4", provider: "copilot" }];
      const result = await runWithCopilotSDK({
        sdkUri: "http://127.0.0.1:3002",
        prompt: "test prompt",
        logger: () => {},
        model: "gpt-5.4",
        providers,
        models,
        sdkModule: {
          CopilotClient: FakeCopilotClient,
          RuntimeConnection: { forUri },
          approveAll: () => "allow",
        },
      });

      expect(result.exitCode).toBe(0);
      expect(createSession).toHaveBeenCalledWith(
        expect.objectContaining({
          model: "gpt-5.4",
          providers,
          models,
        })
      );
      expect(forUri).toHaveBeenCalledWith("http://127.0.0.1:3002", {});
    });

    it("passes COPILOT_CONNECTION_TOKEN to RuntimeConnection.forUri", async () => {
      const disconnect = vi.fn().mockResolvedValue(undefined);
      const stop = vi.fn().mockResolvedValue(undefined);
      const connection = { kind: "uri", url: "http://127.0.0.1:3002", connectionToken: "token-123" };
      const forUri = vi.fn(() => connection);
      const constructorSpy = vi.fn();
      const createSession = vi.fn().mockResolvedValue({
        sessionId: "session-connection-token",
        on: () => {},
        sendAndWait: vi.fn().mockResolvedValue({ data: { content: "ok" } }),
        disconnect,
      });
      class FakeCopilotClient {
        constructor(options) {
          constructorSpy(options);
        }
        start = vi.fn().mockResolvedValue(undefined);
        createSession = createSession;
        stop = stop;
      }

      const result = await runWithCopilotSDK({
        sdkUri: "http://127.0.0.1:3002",
        prompt: "test prompt",
        logger: () => {},
        connectionToken: "token-123",
        sdkModule: {
          CopilotClient: FakeCopilotClient,
          RuntimeConnection: { forUri },
          approveAll: () => "allow",
        },
      });

      expect(result.exitCode).toBe(0);
      expect(forUri).toHaveBeenCalledWith("http://127.0.0.1:3002", { connectionToken: "token-123" });
      expect(constructorSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          connection,
        })
      );
    });

    it("uses scoped permission handler from SDK permission config", async () => {
      const disconnect = vi.fn().mockResolvedValue(undefined);
      const stop = vi.fn().mockResolvedValue(undefined);
      const createSession = vi.fn().mockResolvedValue({
        sessionId: "session-permissions",
        on: () => {},
        sendAndWait: vi.fn().mockResolvedValue({ data: { content: "ok" } }),
        disconnect,
      });
      class FakeCopilotClient {
        start = vi.fn().mockResolvedValue(undefined);
        createSession = createSession;
        stop = stop;
      }

      const result = await runWithCopilotSDK({
        sdkUri: "http://127.0.0.1:3002",
        prompt: "test prompt",
        logger: () => {},
        permissionConfig: {
          allowedTools: ["shell(git:*)", "github(get_file_contents)", "web_fetch", "write"],
        },
        sdkModule: {
          CopilotClient: FakeCopilotClient,
          RuntimeConnection: { forUri: vi.fn(() => ({})) },
          approveAll: () => ({ kind: "approve-once" }),
        },
      });

      expect(result.exitCode).toBe(0);
      const sessionConfig = createSession.mock.calls[0][0];
      const onPermissionRequest = sessionConfig.onPermissionRequest;
      expect(onPermissionRequest({ kind: "shell", commands: [{ identifier: "git" }], fullCommandText: "git status" })).toEqual({ kind: "approve-once" });
      expect(onPermissionRequest({ kind: "mcp", serverName: "github", toolName: "get_file_contents" })).toEqual({ kind: "approve-once" });
      expect(onPermissionRequest({ kind: "url", url: "https://example.com" })).toEqual({ kind: "approve-once" });
      expect(onPermissionRequest({ kind: "write", fileName: "a.txt", diff: "", intention: "" })).toEqual({ kind: "approve-once" });
      // Reads of paths outside the workspace are denied without an explicit read grant.
      expect(onPermissionRequest({ kind: "read", path: "/etc/passwd", intention: "" })).toEqual({
        kind: "reject",
        feedback: "Tool invocation is not allowed by workflow tool permissions.",
      });
      expect(onPermissionRequest({ kind: "shell", commands: [{ identifier: "rm" }], fullCommandText: "rm -rf /tmp/x" })).toEqual({
        kind: "reject",
        feedback: "Tool invocation is not allowed by workflow tool permissions.",
      });
    });

    it("allows read requests when read is explicitly allowlisted", async () => {
      const disconnect = vi.fn().mockResolvedValue(undefined);
      const stop = vi.fn().mockResolvedValue(undefined);
      const createSession = vi.fn().mockResolvedValue({
        sessionId: "session-read-allowed",
        on: () => {},
        sendAndWait: vi.fn().mockResolvedValue({ data: { content: "ok" } }),
        disconnect,
      });
      class FakeCopilotClient {
        start = vi.fn().mockResolvedValue(undefined);
        createSession = createSession;
        stop = stop;
      }

      const result = await runWithCopilotSDK({
        sdkUri: "http://127.0.0.1:3002",
        prompt: "test prompt",
        logger: () => {},
        permissionConfig: {
          allowedTools: ["read"],
        },
        sdkModule: {
          CopilotClient: FakeCopilotClient,
          RuntimeConnection: { forUri: vi.fn(() => ({})) },
          approveAll: () => ({ kind: "approve-once" }),
        },
      });

      expect(result.exitCode).toBe(0);
      const sessionConfig = createSession.mock.calls[0][0];
      const onPermissionRequest = sessionConfig.onPermissionRequest;
      expect(onPermissionRequest({ kind: "read", path: "a.txt", intention: "" })).toEqual({ kind: "approve-once" });
    });

    it("allows read requests when read(path) is explicitly allowlisted", async () => {
      const disconnect = vi.fn().mockResolvedValue(undefined);
      const stop = vi.fn().mockResolvedValue(undefined);
      const createSession = vi.fn().mockResolvedValue({
        sessionId: "session-read-path-allowed",
        on: () => {},
        sendAndWait: vi.fn().mockResolvedValue({ data: { content: "ok" } }),
        disconnect,
      });
      class FakeCopilotClient {
        start = vi.fn().mockResolvedValue(undefined);
        createSession = createSession;
        stop = stop;
      }

      const result = await runWithCopilotSDK({
        sdkUri: "http://127.0.0.1:3002",
        prompt: "test prompt",
        logger: () => {},
        permissionConfig: {
          allowedTools: ["read(/tmp/gh-aw/agent/*)"],
        },
        sdkModule: {
          CopilotClient: FakeCopilotClient,
          RuntimeConnection: { forUri: vi.fn(() => ({})) },
          approveAll: () => ({ kind: "approve-once" }),
        },
      });

      expect(result.exitCode).toBe(0);
      const sessionConfig = createSession.mock.calls[0][0];
      const onPermissionRequest = sessionConfig.onPermissionRequest;
      // Copilot SDK treats any granted read capability as global; read(path) entries are
      // effectively equivalent to read for the onPermissionRequest contract.
      expect(onPermissionRequest({ kind: "read", path: "a.txt", intention: "" })).toEqual({ kind: "approve-once" });
      expect(onPermissionRequest({ kind: "read", path: "/etc/passwd", intention: "" })).toEqual({ kind: "approve-once" });
    });

    it("allows read requests when shell access is allowlisted", async () => {
      const disconnect = vi.fn().mockResolvedValue(undefined);
      const stop = vi.fn().mockResolvedValue(undefined);
      const createSession = vi.fn().mockResolvedValue({
        sessionId: "session-read-via-shell",
        on: () => {},
        sendAndWait: vi.fn().mockResolvedValue({ data: { content: "ok" } }),
        disconnect,
      });
      class FakeCopilotClient {
        start = vi.fn().mockResolvedValue(undefined);
        createSession = createSession;
        stop = stop;
      }

      const result = await runWithCopilotSDK({
        sdkUri: "http://127.0.0.1:3002",
        prompt: "test prompt",
        logger: () => {},
        permissionConfig: {
          allowedTools: ["shell"],
        },
        sdkModule: {
          CopilotClient: FakeCopilotClient,
          RuntimeConnection: { forUri: vi.fn(() => ({})) },
          approveAll: () => ({ kind: "approve-once" }),
        },
      });

      expect(result.exitCode).toBe(0);
      const sessionConfig = createSession.mock.calls[0][0];
      const onPermissionRequest = sessionConfig.onPermissionRequest;
      expect(onPermissionRequest({ kind: "read", path: "a.txt", intention: "" })).toEqual({ kind: "approve-once" });
    });

    it("allows read requests that match read-only shell path rules", async () => {
      const disconnect = vi.fn().mockResolvedValue(undefined);
      const stop = vi.fn().mockResolvedValue(undefined);
      const createSession = vi.fn().mockResolvedValue({
        sessionId: "session-read-via-shell-paths",
        on: () => {},
        sendAndWait: vi.fn().mockResolvedValue({ data: { content: "ok" } }),
        disconnect,
      });
      class FakeCopilotClient {
        start = vi.fn().mockResolvedValue(undefined);
        createSession = createSession;
        stop = stop;
      }

      const result = await runWithCopilotSDK({
        sdkUri: "http://127.0.0.1:3002",
        prompt: "test prompt",
        logger: () => {},
        permissionConfig: {
          allowedTools: ["shell(cat /tmp/gh-aw/agent/*)", "shell(cat /tmp/gh-aw/agent/**/*.txt)", "shell(xargs -a /tmp/gh-aw/agent/doc-samples.txt cat)", "shell(ls /tmp/gh-aw/repo-memory/default/)"],
        },
        sdkModule: {
          CopilotClient: FakeCopilotClient,
          RuntimeConnection: { forUri: vi.fn(() => ({})) },
          approveAll: () => ({ kind: "approve-once" }),
        },
      });

      expect(result.exitCode).toBe(0);
      const sessionConfig = createSession.mock.calls[0][0];
      const onPermissionRequest = sessionConfig.onPermissionRequest;
      expect(onPermissionRequest({ kind: "read", path: "/tmp/gh-aw/agent/doc-samples.txt", intention: "" })).toEqual({ kind: "approve-once" });
      expect(onPermissionRequest({ kind: "read", path: "/tmp/gh-aw/agent/subdir/nested.txt", intention: "" })).toEqual({
        kind: "approve-once",
      });
      expect(onPermissionRequest({ kind: "read", path: "/tmp/gh-aw/agent/previous-findings.json", intention: "" })).toEqual({ kind: "approve-once" });
      expect(onPermissionRequest({ kind: "read", path: "/tmp/gh-aw/repo-memory/default", intention: "" })).toEqual({ kind: "approve-once" });
      expect(onPermissionRequest({ kind: "read", path: "/etc/passwd", intention: "" })).toEqual({
        kind: "reject",
        feedback: "Tool invocation is not allowed by workflow tool permissions.",
      });
    });

    it("allows read requests when absolute path matches a workspace-relative shell pattern", async () => {
      // Simulates the daily-compiler-quality failure where the agent calls view() with
      // an absolute path like /home/runner/work/gh-aw/gh-aw/pkg/workflow/file.go but
      // the workflow only grants shell(cat pkg/**/*.go) (a relative glob pattern).
      const prevWorkspace = process.env.GITHUB_WORKSPACE;
      process.env.GITHUB_WORKSPACE = "/home/runner/work/gh-aw/gh-aw";
      try {
        const disconnect = vi.fn().mockResolvedValue(undefined);
        const stop = vi.fn().mockResolvedValue(undefined);
        const createSession = vi.fn().mockResolvedValue({
          sessionId: "session-workspace-relative-read",
          on: () => {},
          sendAndWait: vi.fn().mockResolvedValue({ data: { content: "ok" } }),
          disconnect,
        });
        class FakeCopilotClient {
          start = vi.fn().mockResolvedValue(undefined);
          createSession = createSession;
          stop = stop;
        }

        await runWithCopilotSDK({
          sdkUri: "http://127.0.0.1:3002",
          prompt: "test prompt",
          logger: () => {},
          permissionConfig: {
            allowedTools: ["shell(cat pkg/**/*.go)", "shell(grep)", "shell(wc)"],
          },
          sdkModule: {
            CopilotClient: FakeCopilotClient,
            RuntimeConnection: { forUri: vi.fn(() => ({})) },
            approveAll: () => ({ kind: "approve-once" }),
          },
        });

        const sessionConfig = createSession.mock.calls[0][0];
        const onPermissionRequest = sessionConfig.onPermissionRequest;

        // Absolute paths within the workspace must be allowed via the relative pattern.
        expect(onPermissionRequest({ kind: "read", path: "/home/runner/work/gh-aw/gh-aw/pkg/workflow/compiler_activation_job_builder.go", intention: "" })).toEqual({ kind: "approve-once" });
        expect(onPermissionRequest({ kind: "read", path: "/home/runner/work/gh-aw/gh-aw/pkg/workflow/compiler_pre_activation_job.go", intention: "" })).toEqual({ kind: "approve-once" });
        expect(onPermissionRequest({ kind: "read", path: "/home/runner/work/gh-aw/gh-aw/pkg/workflow/compiler_types.go", intention: "" })).toEqual({ kind: "approve-once" });

        // Relative paths that match the pattern must still work.
        expect(onPermissionRequest({ kind: "read", path: "pkg/workflow/compiler.go", intention: "" })).toEqual({ kind: "approve-once" });

        // Files within the workspace root are always allowed (workspace-root allowlist).
        // Even files outside pkg/ must be readable since they are part of the checkout.
        expect(onPermissionRequest({ kind: "read", path: "/home/runner/work/gh-aw/gh-aw/AGENTS.md", intention: "" })).toEqual({ kind: "approve-once" });
        expect(onPermissionRequest({ kind: "read", path: "/home/runner/work/gh-aw/gh-aw", intention: "" })).toEqual({ kind: "approve-once" });
        // Files outside the workspace root must be denied.
        expect(onPermissionRequest({ kind: "read", path: "/etc/passwd", intention: "" })).toEqual({
          kind: "reject",
          feedback: "Tool invocation is not allowed by workflow tool permissions.",
        });
        // A path outside the workspace that contains /pkg/ must not be permitted.
        expect(onPermissionRequest({ kind: "read", path: "/other/workspace/pkg/workflow/file.go", intention: "" })).toEqual({
          kind: "reject",
          feedback: "Tool invocation is not allowed by workflow tool permissions.",
        });
      } finally {
        if (prevWorkspace === undefined) {
          delete process.env.GITHUB_WORKSPACE;
        } else {
          process.env.GITHUB_WORKSPACE = prevWorkspace;
        }
      }
    });

    it("always allows read of workspace root and its subdirectories for read-only workflows (regression: #49836)", async () => {
      // Regression test: a workflow with only specific tool restrictions (e.g., github MCP + specific
      // bash commands) must never have read($GITHUB_WORKSPACE) denied. Previously, any workflow with
      // partial tool restrictions and no explicit read grant would deny workspace reads, causing
      // guard.tool_denials_exceeded after 3 attempts and killing the run.
      const prevWorkspace = process.env.GITHUB_WORKSPACE;
      process.env.GITHUB_WORKSPACE = "/home/runner/work/gh-aw/gh-aw";
      try {
        const disconnect = vi.fn().mockResolvedValue(undefined);
        const stop = vi.fn().mockResolvedValue(undefined);
        const createSession = vi.fn().mockResolvedValue({
          sessionId: "session-workspace-root-always-readable",
          on: () => {},
          sendAndWait: vi.fn().mockResolvedValue({ data: { content: "ok" } }),
          disconnect,
        });
        class FakeCopilotClient {
          start = vi.fn().mockResolvedValue(undefined);
          createSession = createSession;
          stop = stop;
        }

        await runWithCopilotSDK({
          sdkUri: "http://127.0.0.1:3002",
          prompt: "test prompt",
          logger: () => {},
          // Read-only workflow: only github MCP + restricted bash, no explicit read grant.
          permissionConfig: {
            allowedTools: ["github", 'shell(find . -name "*_test.go" -type f)', "shell(cat **/*_test.go)", 'shell(grep -r "func Test" . --include="*_test.go")', "shell(go test -v ./...)", "shell(wc -l **/*_test.go)", "shell(gh:*)"],
          },
          sdkModule: {
            CopilotClient: FakeCopilotClient,
            RuntimeConnection: { forUri: vi.fn(() => ({})) },
            approveAll: () => ({ kind: "approve-once" }),
          },
        });

        const sessionConfig = createSession.mock.calls[0][0];
        const onPermissionRequest = sessionConfig.onPermissionRequest;

        // The workspace root itself must always be readable.
        expect(onPermissionRequest({ kind: "read", path: "/home/runner/work/gh-aw/gh-aw", intention: "" })).toEqual({ kind: "approve-once" });
        // Any subdirectory under the workspace must be readable.
        expect(onPermissionRequest({ kind: "read", path: "/home/runner/work/gh-aw/gh-aw/pkg/workflow", intention: "" })).toEqual({ kind: "approve-once" });
        // Any file under the workspace must be readable.
        expect(onPermissionRequest({ kind: "read", path: "/home/runner/work/gh-aw/gh-aw/AGENTS.md", intention: "" })).toEqual({ kind: "approve-once" });
        expect(onPermissionRequest({ kind: "read", path: "/home/runner/work/gh-aw/gh-aw/pkg/workflow/copilot_engine_tools.go", intention: "" })).toEqual({ kind: "approve-once" });

        // Relative paths must be resolved inside the workspace and approved.
        expect(onPermissionRequest({ kind: "read", path: "AGENTS.md", intention: "" })).toEqual({ kind: "approve-once" });
        expect(onPermissionRequest({ kind: "read", path: "pkg/workflow/file.go", intention: "" })).toEqual({ kind: "approve-once" });

        // Path traversal attempts must be rejected even when they start with the workspace prefix.
        expect(onPermissionRequest({ kind: "read", path: "/home/runner/work/gh-aw/gh-aw/../../../../etc/passwd", intention: "" })).toEqual({
          kind: "reject",
          feedback: "Tool invocation is not allowed by workflow tool permissions.",
        });
        expect(onPermissionRequest({ kind: "read", path: "/home/runner/work/gh-aw/gh-aw/../../../other-repo/secret.txt", intention: "" })).toEqual({
          kind: "reject",
          feedback: "Tool invocation is not allowed by workflow tool permissions.",
        });

        // Paths outside the workspace root must still be denied.
        expect(onPermissionRequest({ kind: "read", path: "/etc/passwd", intention: "" })).toEqual({
          kind: "reject",
          feedback: "Tool invocation is not allowed by workflow tool permissions.",
        });
        expect(onPermissionRequest({ kind: "read", path: "/home/runner/work/other-repo/secret.txt", intention: "" })).toEqual({
          kind: "reject",
          feedback: "Tool invocation is not allowed by workflow tool permissions.",
        });
      } finally {
        if (prevWorkspace === undefined) {
          delete process.env.GITHUB_WORKSPACE;
        } else {
          process.env.GITHUB_WORKSPACE = prevWorkspace;
        }
      }
    });

    it("logs permission-denied SDK requests as core warnings", async () => {
      const disconnect = vi.fn().mockResolvedValue(undefined);
      const stop = vi.fn().mockResolvedValue(undefined);
      const createSession = vi.fn().mockResolvedValue({
        sessionId: "session-permission-warnings",
        on: () => {},
        sendAndWait: vi.fn().mockResolvedValue({ data: { content: "ok" } }),
        disconnect,
      });
      class FakeCopilotClient {
        start = vi.fn().mockResolvedValue(undefined);
        createSession = createSession;
        stop = stop;
      }
      const coreLogger = {
        info: vi.fn(),
        warning: vi.fn(),
      };

      const result = await runWithCopilotSDK({
        sdkUri: "http://127.0.0.1:3002",
        prompt: "test prompt",
        logger: () => {},
        permissionConfig: {
          allowedTools: ["shell(git:*)"],
        },
        coreLogger,
        sdkModule: {
          CopilotClient: FakeCopilotClient,
          RuntimeConnection: { forUri: vi.fn(() => ({})) },
          approveAll: () => ({ kind: "approve-once" }),
        },
      });

      expect(result.exitCode).toBe(0);
      const sessionConfig = createSession.mock.calls[0][0];
      const onPermissionRequest = sessionConfig.onPermissionRequest;
      expect(onPermissionRequest({ kind: "shell", commands: [{ identifier: "rm" }], fullCommandText: "rm -rf /tmp/x" })).toEqual({
        kind: "reject",
        feedback: "Tool invocation is not allowed by workflow tool permissions.",
      });
      expect(coreLogger.info).toHaveBeenCalledWith(expect.stringContaining("shell(rm -rf /tmp/x)"));
      expect(coreLogger.warning).toHaveBeenCalledWith(expect.stringContaining("shell(rm -rf /tmp/x)"));
    });

    it("always configures onPermissionRequest and defaults to approveAll when permissionConfig is absent", async () => {
      const disconnect = vi.fn().mockResolvedValue(undefined);
      const stop = vi.fn().mockResolvedValue(undefined);
      const createSession = vi.fn().mockResolvedValue({
        sessionId: "session-default-permissions",
        on: () => {},
        sendAndWait: vi.fn().mockResolvedValue({ data: { content: "ok" } }),
        disconnect,
      });
      const approveAll = vi.fn(() => ({ kind: "approve-once" }));
      class FakeCopilotClient {
        start = vi.fn().mockResolvedValue(undefined);
        createSession = createSession;
        stop = stop;
      }

      const result = await runWithCopilotSDK({
        sdkUri: "http://127.0.0.1:3002",
        prompt: "test prompt",
        logger: () => {},
        sdkModule: {
          CopilotClient: FakeCopilotClient,
          RuntimeConnection: { forUri: vi.fn(() => ({})) },
          approveAll,
        },
      });

      expect(result.exitCode).toBe(0);
      const sessionConfig = createSession.mock.calls[0][0];
      expect(sessionConfig).toHaveProperty("onPermissionRequest");
      const decision = sessionConfig.onPermissionRequest({ kind: "read", path: "a.txt", intention: "" });
      expect(decision).toEqual({ kind: "approve-once" });
      expect(approveAll).toHaveBeenCalledTimes(1);
    });

    it("stops session when permission denials reach max-tool-denials threshold", async () => {
      const disconnect = vi.fn().mockResolvedValue(undefined);
      const stop = vi.fn().mockResolvedValue(undefined);
      const stderrWriteSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      let sessionConfig;
      const session = {
        sessionId: "session-max-tool-denials",
        on: () => {},
        sendAndWait: vi.fn().mockImplementation(async () => {
          const denyRequest = { kind: "shell", commands: [{ identifier: "rm" }], fullCommandText: "rm -rf /tmp/x" };
          sessionConfig.onPermissionRequest(denyRequest);
          sessionConfig.onPermissionRequest(denyRequest);
          sessionConfig.onPermissionRequest(denyRequest);
          return { data: { content: "should-not-complete" } };
        }),
        disconnect,
      };
      class FakeCopilotClient {
        start = vi.fn().mockResolvedValue(undefined);
        createSession = vi.fn().mockImplementation(async config => {
          sessionConfig = config;
          return session;
        });
        stop = stop;
      }

      const oldMaxToolDenials = process.env.GH_AW_MAX_TOOL_DENIALS;
      process.env.GH_AW_MAX_TOOL_DENIALS = "3";
      try {
        const result = await runWithCopilotSDK({
          sdkUri: "http://127.0.0.1:3002",
          prompt: "test prompt",
          logger: () => {},
          permissionConfig: {
            allowedTools: ["shell(git:*)"],
          },
          sdkModule: {
            CopilotClient: FakeCopilotClient,
            RuntimeConnection: { forUri: vi.fn(() => ({})) },
            approveAll: () => ({ kind: "approve-once" }),
          },
        });

        expect(result.exitCode).toBe(1);
        expect(result.output).toContain("max tool denials threshold reached");
        expect(disconnect).toHaveBeenCalled();
        const parsedEvents = stderrWriteSpy.mock.calls
          .map(([message]) => {
            if (typeof message !== "string" || !message.endsWith("\n")) return null;
            try {
              return JSON.parse(message.trimEnd());
            } catch {
              return null;
            }
          })
          .filter(Boolean);
        const toolDenialsEvent = parsedEvents.find(event => event.type === "guard.tool_denials_exceeded");
        expect(toolDenialsEvent).toMatchObject({
          type: "guard.tool_denials_exceeded",
          data: {
            denialCount: 3,
            threshold: 3,
            reason: expect.stringContaining("permission denied"),
          },
        });
      } finally {
        stderrWriteSpy.mockRestore();
        if (oldMaxToolDenials === undefined) {
          delete process.env.GH_AW_MAX_TOOL_DENIALS;
        } else {
          process.env.GH_AW_MAX_TOOL_DENIALS = oldMaxToolDenials;
        }
      }
    });

    it("falls back to default threshold when GH_AW_MAX_TOOL_DENIALS is malformed", async () => {
      const disconnect = vi.fn().mockResolvedValue(undefined);
      const stop = vi.fn().mockResolvedValue(undefined);
      let sessionConfig;
      const session = {
        sessionId: "session-max-tool-denials-malformed-env",
        on: () => {},
        sendAndWait: vi.fn().mockImplementation(async () => {
          const denyRequest = { kind: "shell", commands: [{ identifier: "rm" }], fullCommandText: "rm -rf /tmp/x" };
          sessionConfig.onPermissionRequest(denyRequest);
          sessionConfig.onPermissionRequest(denyRequest);
          sessionConfig.onPermissionRequest(denyRequest);
          return { data: { content: "completed" } };
        }),
        disconnect,
      };
      class FakeCopilotClient {
        start = vi.fn().mockResolvedValue(undefined);
        createSession = vi.fn().mockImplementation(async config => {
          sessionConfig = config;
          return session;
        });
        stop = stop;
      }

      const oldMaxToolDenials = process.env.GH_AW_MAX_TOOL_DENIALS;
      process.env.GH_AW_MAX_TOOL_DENIALS = "3ms";
      try {
        const result = await runWithCopilotSDK({
          sdkUri: "http://127.0.0.1:3002",
          prompt: "test prompt",
          logger: () => {},
          permissionConfig: {
            allowedTools: ["shell(git:*)"],
          },
          sdkModule: {
            CopilotClient: FakeCopilotClient,
            RuntimeConnection: { forUri: vi.fn(() => ({})) },
            approveAll: () => ({ kind: "approve-once" }),
          },
        });

        expect(result.exitCode).toBe(0);
      } finally {
        if (oldMaxToolDenials === undefined) {
          delete process.env.GH_AW_MAX_TOOL_DENIALS;
        } else {
          process.env.GH_AW_MAX_TOOL_DENIALS = oldMaxToolDenials;
        }
      }
    });

    it("returns threshold error when sendAndWait fails in the same turn as catastrophic denials", async () => {
      let sessionConfig;
      const disconnect = vi.fn().mockResolvedValue(undefined);
      const stop = vi.fn().mockResolvedValue(undefined);
      const session = {
        sessionId: "session-max-tool-denials-disconnect",
        on: () => {},
        sendAndWait: vi.fn().mockImplementation(async () => {
          const denyRequest = { kind: "shell", commands: [{ identifier: "rm" }], fullCommandText: "rm -rf /tmp/x" };
          sessionConfig.onPermissionRequest(denyRequest);
          sessionConfig.onPermissionRequest(denyRequest);
          throw new Error("transport disconnected");
        }),
        disconnect,
      };
      class FakeCopilotClient {
        start = vi.fn().mockResolvedValue(undefined);
        createSession = vi.fn().mockImplementation(async config => {
          sessionConfig = config;
          return session;
        });
        stop = stop;
      }

      const oldMaxToolDenials = process.env.GH_AW_MAX_TOOL_DENIALS;
      process.env.GH_AW_MAX_TOOL_DENIALS = "2";
      try {
        const result = await runWithCopilotSDK({
          sdkUri: "http://127.0.0.1:3002",
          prompt: "test prompt",
          logger: () => {},
          permissionConfig: {
            allowedTools: ["shell(git:*)"],
          },
          sdkModule: {
            CopilotClient: FakeCopilotClient,
            RuntimeConnection: { forUri: vi.fn(() => ({})) },
            approveAll: () => ({ kind: "approve-once" }),
          },
        });

        expect(result.exitCode).toBe(1);
        expect(result.output).toContain("max tool denials threshold reached");
      } finally {
        if (oldMaxToolDenials === undefined) {
          delete process.env.GH_AW_MAX_TOOL_DENIALS;
        } else {
          process.env.GH_AW_MAX_TOOL_DENIALS = oldMaxToolDenials;
        }
      }
    });
  });

  describe("denial guard lifecycle", () => {
    let harnesses;
    let events;
    let eventsStream;
    let createStreamSpy;
    let holdStream;
    let finishStream;

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      vi.stubEnv("GH_AW_SDK_IDLE_MS", "30000");
      vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      harnesses = [];
      events = [];
      holdStream = false;
      finishStream = undefined;
      eventsStream = new Writable({
        write(chunk, _encoding, callback) {
          events.push(JSON.parse(chunk.toString()));
          callback();
        },
        final(callback) {
          if (holdStream) finishStream = callback;
          else callback();
        },
      });
      createStreamSpy = vi.spyOn(require("fs"), "createWriteStream").mockReturnValue(eventsStream);
    });

    function releaseStream() {
      holdStream = false;
      const finish = finishStream;
      finishStream = undefined;
      if (finish && !eventsStream.destroyed) finish();
    }

    afterEach(async () => {
      try {
        releaseStream();
        for (const harness of harnesses) {
          harness.send.resolve(undefined);
          harness.disconnectDone.resolve(undefined);
          harness.stopDone.resolve(undefined);
        }
        await vi.runAllTimersAsync();
        await Promise.allSettled(harnesses.map(harness => harness.running).filter(Boolean));
      } finally {
        eventsStream.destroy();
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
        vi.useRealTimers();
      }
    });

    /** @param {string} sessionId */
    function makeGuardHarness(sessionId) {
      const send = Promise.withResolvers();
      const sendStarted = Promise.withResolvers();
      const disconnectDone = Promise.withResolvers();
      const stopDone = Promise.withResolvers();
      let onEvent;
      let onPermissionRequest;
      const unsubscribe = vi.fn();
      const disconnect = vi.fn().mockResolvedValue(undefined);
      const stop = vi.fn().mockResolvedValue(undefined);
      const logger = vi.fn();
      const coreLogger = { info: vi.fn(), warning: vi.fn() };
      const session = {
        sessionId,
        on: vi.fn(handler => {
          onEvent = handler;
          return unsubscribe;
        }),
        sendAndWait: vi.fn(() => {
          sendStarted.resolve(undefined);
          return send.promise;
        }),
        disconnect,
      };
      class FakeCopilotClient {
        start = vi.fn().mockResolvedValue(undefined);
        createSession = vi.fn(async config => {
          onPermissionRequest = config.onPermissionRequest;
          return session;
        });
        stop = stop;
      }
      const harness = {
        send,
        sendStarted,
        disconnectDone,
        stopDone,
        session,
        unsubscribe,
        disconnect,
        stop,
        logger,
        coreLogger,
        completed: vi.fn(),
        rejected: vi.fn(),
        running: null,
        emit(type, data = {}) {
          if (!onEvent) throw new Error("SDK event handler is not installed");
          onEvent({ type, ephemeral: false, timestamp: new Date().toISOString(), data });
        },
        deny() {
          if (!onPermissionRequest) throw new Error("SDK permission handler is not installed");
          return onPermissionRequest({ kind: "shell", commands: [{ identifier: "denied" }], fullCommandText: "denied" });
        },
        run(options = {}) {
          harness.running = runWithCopilotSDK({
            sdkUri: "http://127.0.0.1:3002",
            prompt: "test prompt",
            logger,
            coreLogger,
            maxToolDenials: 5,
            permissionConfig: { allowedTools: ["shell(git:*)"] },
            sdkModule: {
              CopilotClient: FakeCopilotClient,
              RuntimeConnection: { forUri: vi.fn(() => ({})) },
              approveAll: () => ({ kind: "approve-once" }),
            },
            ...options,
          });
          harness.running.then(harness.completed, harness.rejected);
          return harness.running;
        },
      };
      harnesses.push(harness);
      return harness;
    }

    function tripGuard(harness) {
      for (let count = 0; count < 5; count++) {
        expect(harness.deny()).toEqual({ kind: "reject", feedback: "Tool invocation is not allowed by workflow tool permissions." });
      }
    }

    it("returns failure on the fifth denial while send stays pending independently of successful disconnect", async () => {
      const harness = makeGuardHarness("session-guard-independent-send");
      const sendSettled = vi.fn();
      harness.send.promise.then(sendSettled, sendSettled);
      harness.run();
      await harness.sendStarted.promise;

      for (let count = 1; count <= 4; count++) {
        expect(harness.deny().kind).toBe("reject");
        await vi.advanceTimersByTimeAsync(0);
        expect(events.filter(event => event.type === "guard.tool_denials_exceeded")).toHaveLength(0);
        expect(harness.disconnect).not.toHaveBeenCalled();
        expect(harness.completed).not.toHaveBeenCalled();
      }
      for (let count = 5; count <= 7; count++) expect(harness.deny().kind).toBe("reject");
      await vi.advanceTimersByTimeAsync(0);

      // The old runner stays pending here even though disconnect has resolved.
      expect(harness.completed).toHaveBeenCalledTimes(1);
      expect(harness.completed).toHaveBeenCalledWith({
        exitCode: 1,
        output: "max tool denials threshold reached (5/5)",
        hasOutput: false,
        durationMs: 0,
      });
      expect(harness.rejected).not.toHaveBeenCalled();
      expect(sendSettled).not.toHaveBeenCalled();
      expect(harness.disconnect).toHaveBeenCalledTimes(1);
      expect(harness.stop).toHaveBeenCalledTimes(1);
      expect(harness.coreLogger.info).toHaveBeenCalledTimes(7);
      expect(harness.coreLogger.warning).toHaveBeenCalledTimes(7);
      expect(harness.logger).toHaveBeenCalledWith("[sdk-driver] tool denial 7/5: permission denied: shell(denied)");
      expect(events.filter(event => event.type === "guard.tool_denials_exceeded")).toEqual([
        {
          type: "guard.tool_denials_exceeded",
          timestamp: expect.any(String),
          data: { denialCount: 5, threshold: 5, reason: "permission denied: shell(denied)" },
        },
      ]);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("observes a guard fired during event subscription before send begins", async () => {
      const harness = makeGuardHarness("session-guard-before-send");
      const subscribe = harness.session.on.getMockImplementation();
      harness.session.on.mockImplementation(handler => {
        const unsubscribe = subscribe(handler);
        tripGuard(harness);
        return unsubscribe;
      });
      harness.run();
      await harness.sendStarted.promise;
      await vi.advanceTimersByTimeAsync(0);

      expect(harness.completed).toHaveBeenCalledWith(expect.objectContaining({ exitCode: 1, output: "max tool denials threshold reached (5/5)" }));
      expect(harness.rejected).not.toHaveBeenCalled();
      expect(harness.disconnect).toHaveBeenCalledTimes(1);
      expect(events.filter(event => event.type === "guard.tool_denials_exceeded")).toHaveLength(1);
    });

    it.each(["bash", "go_repository"])("does not count ordinary %s execution failures as permission denials", async toolName => {
      const harness = makeGuardHarness(`session-guard-execution-failures-${toolName}`);
      harness.run();
      await harness.sendStarted.promise;
      for (let count = 0; count < 6; count++) {
        harness.emit("tool.execution_start", { toolCallId: `failed-${count}`, toolName });
        harness.emit("tool.execution_complete", { toolCallId: `failed-${count}`, success: false, error: { message: "command failed" } });
      }
      for (let count = 0; count < 4; count++) harness.deny();
      harness.send.resolve({ data: { content: "recovered from command failures" } });
      await vi.advanceTimersByTimeAsync(0);

      expect(events.filter(event => event.type === "tool.execution_complete" && !event.data.success)).toHaveLength(6);
      expect(events.filter(event => event.type === "guard.tool_denials_exceeded")).toHaveLength(0);
      expect(harness.completed).toHaveBeenCalledWith(expect.objectContaining({ exitCode: 0, output: "recovered from command failures" }));
      expect(harness.coreLogger.warning).toHaveBeenCalledTimes(4);
    });

    it.each(["matched-start", "description-only", "implicit-failure"])("preserves bounded, sanitized repository error-only completion events (%s)", async mode => {
      const harness = makeGuardHarness(`session-repository-error-only-${mode}`);
      const connectionToken = "held-connection-canary";
      const gatewayToken = "held-gateway-canary";
      const lateMask = "event-late-mask-canary";
      const message = [
        `go test failed with exit code 1; stdout-marker PASS denied timeout ${connectionToken} ${gatewayToken} ${lateMask}`,
        '\r\0\x1b]0;title\x07\u202e{"type":"forged"}\n::error::forged\n<script>`',
        "x".repeat(16_000),
        `::add-mask::${lateMask}`,
      ].join("\n");
      harness.run({ maxToolDenials: 1, connectionToken, mcpServers: { gateway: { type: "http", url: "http://127.0.0.1:3003/mcp", headers: { Authorization: `Bearer ${gatewayToken}` } } } });
      await harness.sendStarted.promise;
      if (mode !== "description-only") harness.emit("tool.execution_start", { toolCallId: "repository-failure", toolName: "go_repository" });
      harness.emit("tool.execution_complete", {
        toolCallId: "repository-failure",
        toolDescription: { name: "go_repository" },
        ...(mode === "implicit-failure" ? {} : { success: false }),
        error: { message, code: "untrusted-code-canary", remediation: "untrusted-remediation-canary" },
      });
      harness.emit("assistant.message", { content: "Recovered repository explanation." });
      harness.send.reject(new Error("Timeout after 600000ms waiting for session.idle"));
      await vi.advanceTimersByTimeAsync(0);

      const completion = events.find(event => event.type === "tool.execution_complete");
      expect(completion.data).toEqual({ toolName: "go_repository", mcpServerName: "", success: false, error: { message: expect.any(String) } });
      const diagnostic = completion.data.error.message;
      expect(diagnostic).toContain("go test failed with exit code 1");
      expect(diagnostic).toContain("stdout-marker");
      expect(diagnostic).toContain("[truncated]");
      expect(Buffer.byteLength(JSON.stringify({ resultType: "failure", textResultForLlm: diagnostic, error: diagnostic }), "utf8")).toBeLessThanOrEqual(8192);
      expect(diagnostic).not.toMatch(/[\x00-\x1f\u202e]/);
      const serialized = JSON.stringify(events);
      for (const value of [connectionToken, gatewayToken, lateMask, "::error::", "::add-mask::", "<script>", "untrusted-code-canary", "untrusted-remediation-canary"]) expect(serialized).not.toContain(value);
      expect(harness.logger.mock.calls.some(([line]) => line.includes("stdout-marker"))).toBe(false);
      for (const [line] of vi.mocked(process.stderr.write).mock.calls) expect(String(line).split("\n")).toHaveLength(2);
      expect(events.some(event => event.type === "guard.tool_denials_exceeded")).toBe(false);
      expect(harness.coreLogger.warning).not.toHaveBeenCalled();
      expect(harness.completed).toHaveBeenCalledWith(expect.objectContaining({ exitCode: 0, hasOutput: true, output: "Recovered repository explanation." }));
      expect(harness.disconnect).toHaveBeenCalledTimes(1);
    });

    it("preserves both streams when persisting an actual bounded repository failure", async () => {
      const { createRepositoryFailure, repositoryCommandError } = require("./copilot_sdk_repo_diagnostics.cjs");
      const failure = createRepositoryFailure(
        repositoryCommandError("go test", {
          exitCode: 1,
          stdout: "stdout-marker " + "x".repeat(250_000),
          stderr: "stderr-marker",
        })
      );
      const harness = makeGuardHarness("session-repository-bounded-roundtrip");
      harness.run({ maxToolDenials: 1 });
      await harness.sendStarted.promise;
      harness.emit("tool.execution_start", { toolCallId: "bounded-failure", toolName: "go_repository" });
      harness.emit("tool.execution_complete", { toolCallId: "bounded-failure", success: false, error: { message: failure.error } });
      harness.send.resolve({ data: { content: "validation remains blocked" } });
      await vi.advanceTimersByTimeAsync(0);

      const completion = events.find(event => event.type === "tool.execution_complete");
      expect(completion.data.success).toBe(false);
      const diagnostic = completion.data.error.message;
      expect(diagnostic).toContain("stdout: stdout-marker");
      expect(diagnostic).toContain("stderr: stderr-marker");
      expect(Buffer.byteLength(JSON.stringify({ resultType: "failure", textResultForLlm: diagnostic, error: diagnostic }), "utf8")).toBeLessThanOrEqual(8192);
      expect(events.some(event => event.type === "guard.tool_denials_exceeded")).toBe(false);
    });

    it("keeps native result payloads and explicit success values unchanged", async () => {
      const harness = makeGuardHarness("session-repository-result-preservation");
      harness.run();
      await harness.sendStarted.promise;
      const result = { content: '{"action":"status","exitCode":0,"stdout":"ordinary result","stderr":""}' };
      for (const success of [true, false]) {
        harness.emit("tool.execution_start", { toolCallId: String(success), toolName: "go_repository" });
        harness.emit("tool.execution_complete", { toolCallId: String(success), success, result });
      }
      harness.send.resolve({ data: { content: "done" } });
      await vi.advanceTimersByTimeAsync(0);
      expect(events.filter(event => event.type === "tool.execution_complete").map(event => event.data)).toEqual([
        { toolName: "go_repository", mcpServerName: "", success: true, result },
        { toolName: "go_repository", mcpServerName: "", success: false, result },
      ]);
    });

    it("uses the fixed failure diagnostic, not a raw fallback, when event error extraction throws", async () => {
      const harness = makeGuardHarness("session-repository-event-format-failure");
      harness.run();
      await harness.sendStarted.promise;
      harness.emit("tool.execution_complete", {
        toolDescription: { name: "go_repository" },
        success: false,
        error: {
          get message() {
            throw new Error("raw-extraction-canary");
          },
        },
      });
      harness.send.resolve({ data: { content: "done" } });
      await vi.advanceTimersByTimeAsync(0);
      expect(events.find(event => event.type === "tool.execution_complete").data).toMatchObject({
        success: false,
        error: { message: require("./copilot_sdk_repo_diagnostics.cjs").REPOSITORY_DIAGNOSTIC_FALLBACK },
      });
      expect(JSON.stringify(events)).not.toContain("raw-extraction-canary");
      expect(harness.coreLogger.warning).not.toHaveBeenCalled();
    });

    it.each([
      [false, true, false, 5_000],
      [false, false, true, 5_000],
      [false, true, true, 10_000],
      [true, false, false, 5_000],
      [true, true, false, 10_000],
      [true, false, true, 10_000],
      [true, true, true, 15_000],
    ])("bounds cleanup (stream stalled: %s, disconnect stalled: %s, stop stalled: %s) at %dms", async (stallStream, stallDisconnect, stallStop, budgetMs) => {
      const harness = makeGuardHarness(`session-guard-deadlines-${stallStream}-${stallDisconnect}-${stallStop}`);
      holdStream = stallStream;
      if (stallDisconnect) harness.disconnect.mockReturnValue(harness.disconnectDone.promise);
      if (stallStop) harness.stop.mockReturnValue(harness.stopDone.promise);
      harness.run();
      await harness.sendStarted.promise;
      const started = Date.now();
      tripGuard(harness);
      await vi.advanceTimersByTimeAsync(0);

      expect(harness.unsubscribe).toHaveBeenCalledTimes(1);
      expect(eventsStream.writableEnded).toBe(true);
      await vi.advanceTimersByTimeAsync(budgetMs - 1);
      expect(harness.completed).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);

      expect(Date.now() - started).toBe(budgetMs);
      expect(harness.completed).toHaveBeenCalledWith(expect.objectContaining({ exitCode: 1, output: "max tool denials threshold reached (5/5)" }));
      expect(harness.rejected).not.toHaveBeenCalled();
      expect(harness.disconnect).toHaveBeenCalledTimes(1);
      expect(harness.stop).toHaveBeenCalledTimes(1);
      expect(harness.logger.mock.calls.filter(([message]) => message.includes("cleanup operation timed out after 5000ms"))).toHaveLength(Number(stallStream) + Number(stallDisconnect) + Number(stallStop));
      expect(vi.getTimerCount()).toBe(0);
    });

    it("clears each deadline when its stage settles just before five seconds", async () => {
      const harness = makeGuardHarness("session-guard-deadline-boundaries");
      holdStream = true;
      harness.disconnect.mockReturnValue(harness.disconnectDone.promise);
      harness.stop.mockReturnValue(harness.stopDone.promise);
      harness.run();
      await harness.sendStarted.promise;
      tripGuard(harness);
      await vi.advanceTimersByTimeAsync(0);

      await vi.advanceTimersByTimeAsync(4_999);
      expect(harness.disconnect).not.toHaveBeenCalled();
      releaseStream();
      await vi.advanceTimersByTimeAsync(0);
      expect(harness.disconnect).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(4_999);
      expect(harness.stop).not.toHaveBeenCalled();
      harness.disconnectDone.resolve(undefined);
      await vi.advanceTimersByTimeAsync(0);
      expect(harness.stop).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(4_999);
      harness.stopDone.resolve(undefined);
      await vi.advanceTimersByTimeAsync(0);

      expect(harness.completed).toHaveBeenCalledWith(expect.objectContaining({ exitCode: 1 }));
      expect(harness.logger.mock.calls.some(([message]) => message.includes("timed out"))).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    });

    it.each(["throw", "reject"])("logs cleanup failures that %s without replacing the guard or skipping later cleanup", async mode => {
      const harness = makeGuardHarness(`session-guard-cleanup-${mode}`);
      harness.unsubscribe.mockImplementation(() => {
        harness.emit("assistant.message", { content: "late unsubscribe output" });
        throw new Error("listener teardown failed");
      });
      vi.spyOn(eventsStream, "end").mockImplementation(() => {
        if (mode === "throw") throw new Error("stream drain failed");
        queueMicrotask(() => eventsStream.destroy(new Error("stream drain failed")));
        return eventsStream;
      });
      for (const [cleanup, message] of [
        [harness.disconnect, "disconnect failed"],
        [harness.stop, "stop failed"],
      ]) {
        cleanup.mockImplementation(() => {
          if (mode === "throw") throw new Error(message);
          return Promise.reject(new Error(message));
        });
      }
      harness.run();
      await harness.sendStarted.promise;
      tripGuard(harness);
      await vi.advanceTimersByTimeAsync(0);

      expect(harness.completed).toHaveBeenCalledWith(expect.objectContaining({ exitCode: 1, hasOutput: false, output: "max tool denials threshold reached (5/5)" }));
      expect(harness.rejected).not.toHaveBeenCalled();
      expect(harness.unsubscribe).toHaveBeenCalledTimes(1);
      expect(eventsStream.end).toHaveBeenCalledTimes(1);
      expect(harness.disconnect).toHaveBeenCalledTimes(1);
      expect(harness.stop).toHaveBeenCalledTimes(1);
      for (const message of ["listener teardown failed", "stream drain failed", "disconnect failed", "stop failed"]) {
        expect(harness.logger).toHaveBeenCalledWith(expect.stringContaining(message));
      }
      expect(events.filter(event => event.type === "assistant.message")).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(0);
    });

    it.each(["send first", "guard first"])("keeps the guard fatal when send succeeds in the same tick: %s", async order => {
      const harness = makeGuardHarness(`session-guard-simultaneous-${order.replace(" ", "-")}`);
      harness.run();
      await harness.sendStarted.promise;
      if (order === "send first") harness.send.resolve({ data: { content: "must not become success" } });
      tripGuard(harness);
      if (order === "guard first") harness.send.resolve({ data: { content: "must not become success" } });
      await vi.advanceTimersByTimeAsync(0);

      expect(harness.completed).toHaveBeenCalledWith(expect.objectContaining({ exitCode: 1, hasOutput: false, output: "max tool denials threshold reached (5/5)" }));
    });

    it("keeps a same-tick watchdog completion from overriding the fifth denial", async () => {
      const harness = makeGuardHarness("session-guard-watchdog-race");
      harness.run();
      await harness.sendStarted.promise;
      harness.emit("assistant.message", { content: "earlier assistant output" });
      // Fire the watchdog without flushing the completion promise's reactions.
      vi.advanceTimersByTime(30_000);
      expect(harness.logger).toHaveBeenCalledWith(expect.stringContaining("post-completion idle watchdog fired after 30000ms"));
      tripGuard(harness);
      await vi.advanceTimersByTimeAsync(0);

      expect(harness.completed).toHaveBeenCalledWith(expect.objectContaining({ exitCode: 1, hasOutput: true, output: "earlier assistant output" }));
      expect(harness.logger.mock.calls.some(([message]) => message.includes("treating as completed"))).toBe(false);
      expect(harness.disconnect).toHaveBeenCalledTimes(1);
    });

    it.each(["send", "drain", "close"])("does not turn an events stream error during %s into success", async phase => {
      const harness = makeGuardHarness(`session-guard-stream-error-${phase}`);
      const streamError = new Error("Timeout after 123ms waiting for session.idle");
      if (phase === "drain") {
        vi.spyOn(eventsStream, "end").mockImplementation(() => {
          queueMicrotask(() => eventsStream.destroy(streamError));
          return eventsStream;
        });
      } else if (phase === "close") {
        vi.spyOn(eventsStream, "_destroy").mockImplementation((_err, callback) => {
          queueMicrotask(() => callback(streamError));
        });
      }
      harness.run();
      await harness.sendStarted.promise;
      harness.emit("assistant.message", { content: "partial output" });
      if (phase === "send") eventsStream.emit("error", streamError);
      else harness.send.resolve(undefined);
      await vi.advanceTimersByTimeAsync(0);

      expect(harness.completed).toHaveBeenCalledWith(expect.objectContaining({ exitCode: 1, hasOutput: true, output: "partial output" }));
      expect(harness.rejected).not.toHaveBeenCalled();
      expect(harness.logger).toHaveBeenCalledWith(expect.stringContaining(streamError.message));
      expect(harness.disconnect).toHaveBeenCalledTimes(1);
      expect(harness.stop).toHaveBeenCalledTimes(1);
    });

    it("quiesces late SDK events and handles losing send and cleanup rejections", async () => {
      const harness = makeGuardHarness("session-guard-late-sdk-activity");
      const unhandled = vi.fn();
      const streamError = vi.fn();
      const writeSpy = vi.spyOn(eventsStream, "write");
      eventsStream.on("error", streamError);
      process.on("unhandledRejection", unhandled);
      harness.unsubscribe.mockImplementation(() => {
        harness.emit("assistant.turn_end");
        harness.emit("assistant.message", { content: "late unsubscribe output" });
      });
      harness.disconnect.mockImplementation(() => {
        harness.emit("assistant.message", { content: "late disconnect output" });
        return harness.disconnectDone.promise;
      });
      harness.stop.mockReturnValue(harness.stopDone.promise);
      try {
        harness.run();
        await harness.sendStarted.promise;
        harness.emit("assistant.message", { content: "earlier assistant output" });
        tripGuard(harness);
        await vi.advanceTimersByTimeAsync(10_000);
        expect(harness.completed).toHaveBeenCalledWith(expect.objectContaining({ exitCode: 1, hasOutput: true, output: "earlier assistant output" }));
        const writesAtCompletion = writeSpy.mock.calls.length;

        harness.emit("assistant.turn_start");
        harness.emit("assistant.turn_end");
        harness.emit("assistant.message", { content: "late output after return" });
        harness.emit("tool.execution_start", { toolCallId: "late", toolName: "bash" });
        harness.emit("tool.execution_complete", { toolCallId: "late", success: true });
        harness.deny();
        harness.send.reject(new Error("late send rejection"));
        harness.disconnectDone.reject(new Error("late disconnect rejection"));
        harness.stopDone.reject(new Error("late stop rejection"));
        await vi.advanceTimersByTimeAsync(30_000);

        expect(harness.rejected).not.toHaveBeenCalled();
        expect(unhandled).not.toHaveBeenCalled();
        expect(streamError).not.toHaveBeenCalled();
        expect(writeSpy).toHaveBeenCalledTimes(writesAtCompletion);
        expect(harness.logger).toHaveBeenCalledWith(expect.stringContaining("late disconnect rejection"));
        expect(harness.logger).toHaveBeenCalledWith(expect.stringContaining("late stop rejection"));
        expect(harness.disconnect).toHaveBeenCalledTimes(1);
        expect(harness.stop).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        process.removeListener("unhandledRejection", unhandled);
      }
    });

    it("preserves earlier output and flushes the complete fatal event to session JSONL before returning", async () => {
      createStreamSpy.mockRestore();
      const harness = makeGuardHarness("session-guard-persisted-failure");
      const running = harness.run();
      await harness.sendStarted.promise;
      harness.emit("assistant.message", { content: "earlier assistant output" });
      tripGuard(harness);
      harness.send.resolve({ data: { content: "must not replace earlier output" } });
      const result = await running;

      expect(result).toMatchObject({ exitCode: 1, hasOutput: true, output: "earlier assistant output" });
      const jsonl = fs.readFileSync(path.join(testSessionStateDir, harness.session.sessionId, "events.jsonl"), "utf8");
      expect(jsonl.endsWith("\n")).toBe(true);
      const entries = jsonl
        .trimEnd()
        .split("\n")
        .map(line => JSON.parse(line));
      expect(entries).toEqual([
        { type: "assistant.message", timestamp: expect.any(String), data: { content: "earlier assistant output" } },
        { type: "guard.tool_denials_exceeded", timestamp: expect.any(String), data: { denialCount: 5, threshold: 5, reason: "permission denied: shell(denied)" } },
      ]);
    });
  });

  describe("standalone denial guard lifecycle", () => {
    it.each([false, true])(
      "exits 1 with independently stalled SDK operations (retained SDK handle: %s)",
      retainHandle => {
        const childDir = fs.mkdtempSync(path.join(testSessionStateDir, "denial-guard-child-"));
        const preloadPath = path.join(childDir, "copilot-sdk-denial-guard-preload.cjs");
        const promptPath = path.join(childDir, "prompt.txt");
        try {
          fs.writeFileSync(promptPath, "test prompt");
          fs.writeFileSync(
            preloadPath,
            `
"use strict";
const sessionModule = require(${JSON.stringify(require.resolve("./copilot_sdk_session.cjs"))});
const runWithCopilotSDK = sessionModule.runWithCopilotSDK;
const pending = () => new Promise(() => {});
class FakeToolSet {
  addBuiltIn() { return this; }
}
class FakeCopilotClient {
  async start() {}
  async createSession(config) {
    let onEvent;
    return {
      sessionId: "standalone-denial-guard",
      on(handler) { onEvent = handler; return () => {}; },
      sendAndWait() {
        if (${JSON.stringify(retainHandle)}) {
          setInterval(() => {}, 1000);
          onEvent({ type: "assistant.message", data: { content: "earlier assistant output" } });
        }
        for (let count = 0; count < 6; count++) {
          const decision = config.onPermissionRequest({ kind: "shell", commands: [{ identifier: "denied" }], fullCommandText: "denied" });
          if (decision.kind !== "reject") throw new Error("fixture permission was not denied");
        }
        return pending();
      },
      disconnect() {
        process.stderr.write("fixture:disconnect\\n");
        return pending();
      },
    };
  }
  stop() {
    process.stderr.write("fixture:stop\\n");
    return pending();
  }
}
sessionModule.runWithCopilotSDK = options => runWithCopilotSDK({
  ...options,
  sdkModule: {
    CopilotClient: FakeCopilotClient,
    RuntimeConnection: { forUri: () => ({}) },
    approveAll: () => ({ kind: "approve-once" }),
    ToolSet: FakeToolSet,
    BuiltInTools: { Isolated: [] },
  },
});
`
          );
          const started = Date.now();
          const child = spawnSync(process.execPath, ["--require", preloadPath, require.resolve("./copilot_sdk_driver.cjs")], {
            encoding: "utf8",
            timeout: 18_000,
            killSignal: "SIGKILL",
            env: {
              ...process.env,
              NODE_OPTIONS: "",
              GH_AW_PROMPT: promptPath,
              COPILOT_SDK_URI: "http://127.0.0.1:1",
              COPILOT_CONNECTION_TOKEN: "inert-sdk-fixture",
              COPILOT_MODEL: "fixture-model",
              GH_AW_SESSION_STATE_BASE_DIR: childDir,
              GH_AW_MAX_TOOL_DENIALS: "5",
              GH_AW_SDK_IDLE_MS: "30000",
              GH_AW_COPILOT_SDK_MULTI_PROVIDER_JSON: JSON.stringify({
                model: "fixture-model",
                providers: [{ name: "fixture", type: "openai", baseUrl: "http://127.0.0.1:1" }],
                models: [{ id: "fixture-model", provider: "fixture" }],
              }),
              GH_AW_COPILOT_SDK_TOOL_CONFIG: JSON.stringify({
                version: 1,
                capabilities: { bash: true, edit: false, webFetch: false, webSearch: false, mcp: false, cliProxy: false },
                permissions: { allowedTools: ["shell(git:*)"] },
                explicitlyDisabledTools: [],
              }),
            },
          });

          expect(child.error, child.stderr).toBeUndefined();
          expect(child.signal, child.stderr).toBeNull();
          expect(child.status, child.stderr).toBe(1);
          expect(Date.now() - started).toBeLessThan(18_000);
          expect(child.stderr.match(/fixture:disconnect\n/g)).toHaveLength(1);
          expect(child.stderr.match(/fixture:stop\n/g)).toHaveLength(1);
          expect(child.stderr.match(/cleanup operation timed out after 5000ms/g)).toHaveLength(2);
          expect(child.stderr).toContain("max tool denials threshold reached (5/5)");
          expect(child.stderr).not.toContain("unhandled error");
          const jsonl = fs.readFileSync(path.join(childDir, "standalone-denial-guard", "events.jsonl"), "utf8");
          expect(jsonl.endsWith("\n")).toBe(true);
          const entries = jsonl
            .trimEnd()
            .split("\n")
            .map(line => JSON.parse(line));
          expect(entries.filter(event => event.type === "guard.tool_denials_exceeded")).toEqual([
            { type: "guard.tool_denials_exceeded", timestamp: expect.any(String), data: { denialCount: 5, threshold: 5, reason: "permission denied: shell(denied)" } },
          ]);
          if (retainHandle) expect(entries[0]).toMatchObject({ type: "assistant.message", data: { content: "earlier assistant output" } });
        } finally {
          fs.rmSync(childDir, { recursive: true, force: true });
        }
      },
      20_000
    );
  });

  describe("parsePermissionConfigFromServerArgs", () => {
    it("returns undefined when input is undefined", () => {
      expect(parsePermissionConfigFromServerArgs(undefined)).toBeUndefined();
    });

    it("returns undefined when input is empty string", () => {
      expect(parsePermissionConfigFromServerArgs("")).toBeUndefined();
    });

    it("returns undefined when input is invalid JSON", () => {
      expect(parsePermissionConfigFromServerArgs("not-json")).toBeUndefined();
    });

    it("returns undefined when input is not an array", () => {
      expect(parsePermissionConfigFromServerArgs('{"key":"value"}')).toBeUndefined();
    });

    it("returns undefined when args contain no permission flags", () => {
      const args = JSON.stringify(["--headless", "--no-auto-update", "--port", "3002"]);
      expect(parsePermissionConfigFromServerArgs(args)).toBeUndefined();
    });

    it("returns allowAllTools:true when --allow-all-tools is present", () => {
      const args = JSON.stringify(["--headless", "--allow-all-tools", "--port", "3002"]);
      expect(parsePermissionConfigFromServerArgs(args)).toEqual({ allowAllTools: true });
    });

    it("--allow-all-tools takes precedence over --allow-tool entries", () => {
      const args = JSON.stringify(["--allow-tool", "shell(git:*)", "--allow-all-tools", "--allow-tool", "write"]);
      expect(parsePermissionConfigFromServerArgs(args)).toEqual({ allowAllTools: true });
    });

    it("extracts a single --allow-tool entry", () => {
      const args = JSON.stringify(["--allow-tool", "safeoutputs"]);
      expect(parsePermissionConfigFromServerArgs(args)).toEqual({ allowedTools: ["safeoutputs"] });
    });

    it("extracts multiple --allow-tool entries preserving order", () => {
      const args = JSON.stringify(["--headless", "--no-ask-user", "--allow-tool", "github", "--allow-tool", "safeoutputs", "--allow-tool", "shell(safeoutputs:*)", "--allow-tool", "write"]);
      expect(parsePermissionConfigFromServerArgs(args)).toEqual({
        allowedTools: ["github", "safeoutputs", "shell(safeoutputs:*)", "write"],
      });
    });

    it("extracts shell(safeoutputs:*) from a realistic GH_AW_COPILOT_SDK_SERVER_ARGS value", () => {
      const args = JSON.stringify([
        "--headless",
        "--no-auto-update",
        "--port",
        "3002",
        "--no-ask-user",
        "--allow-tool",
        "github",
        "--allow-tool",
        "safeoutputs",
        "--allow-tool",
        "shell(agenticworkflows:*)",
        "--allow-tool",
        "shell(safeoutputs:*)",
        "--allow-tool",
        "shell(git:*)",
        "--allow-tool",
        "write",
        "--allow-all-paths",
      ]);
      const config = parsePermissionConfigFromServerArgs(args);
      expect(config).not.toBeNull();
      expect(config?.allowedTools).toContain("shell(safeoutputs:*)");
      expect(config?.allowedTools).toContain("safeoutputs");
      expect(config?.allowedTools).toContain("write");
    });

    it("ignores non-string array elements", () => {
      // Mixed arrays should not produce an error; only string entries are valid flags.
      const args = JSON.stringify(["--allow-tool", "write", null, 42, "--allow-tool", "safeoutputs"]);
      const config = parsePermissionConfigFromServerArgs(args);
      // null/42 are not the string "--allow-tool", so only the valid pairs are collected.
      expect(config).toEqual({ allowedTools: ["write", "safeoutputs"] });
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Piped / chained shell command permission tests
  //
  // These tests verify the fallback path in the permission handler that parses
  // fullCommandText when the Copilot SDK does not provide command identifiers.
  // This is the scenario that caused the GEO Optimizer daily audit to fail.
  // ─────────────────────────────────────────────────────────────────────────
  describe("buildCopilotSDKPermissionHandler – piped command support", () => {
    /**
     * Helper: build an onPermissionRequest handler with the given allowed tools
     * and return a function that checks a shell request with no command identifiers.
     */
    function makeHandler(allowedTools) {
      // We need access to buildCopilotSDKPermissionHandler via runWithCopilotSDK.
      // The simplest way is to exercise it through the same flow used in production.
      // We recreate the config here and call parsePermissionConfigFromServerArgs.
      const args = allowedTools.map(t => ["--allow-tool", t]).flat();
      const config = parsePermissionConfigFromServerArgs(JSON.stringify(args));
      // Build a minimal handler directly:
      // Import the internal helper used by runWithCopilotSDK via a round-trip
      // through a test-only re-export of buildCopilotSDKPermissionHandler.
      // Since that function is not exported, we exercise it through runWithCopilotSDK
      // in integration tests below.  Here we just verify config parsing is correct.
      return config;
    }

    it("parsePermissionConfigFromServerArgs round-trips piped-command allowed tools", () => {
      const config = makeHandler(["shell(ls)", "shell(cat)", "shell(echo)", "shell(safeoutputs:*)"]);
      expect(config?.allowedTools).toContain("shell(ls)");
      expect(config?.allowedTools).toContain("shell(cat)");
      expect(config?.allowedTools).toContain("shell(echo)");
      expect(config?.allowedTools).toContain("shell(safeoutputs:*)");
    });

    // Integration: drive permission handler through runWithCopilotSDK to verify
    // that piped commands are allowed when all their segments are in the allow-list.
    async function makePermissionHandlerViaSDK(allowedTools) {
      const { runWithCopilotSDK } = require("./copilot_sdk_driver.cjs");
      const { vi } = await import("vitest");
      const disconnect = vi.fn().mockResolvedValue(undefined);
      const stop = vi.fn().mockResolvedValue(undefined);
      let capturedHandler;
      const createSession = vi.fn().mockImplementation(async config => {
        capturedHandler = config.onPermissionRequest;
        return {
          sessionId: "session-pipe-test",
          on: () => {},
          sendAndWait: vi.fn().mockResolvedValue({ data: { content: "ok" } }),
          disconnect,
        };
      });
      class FakeCopilotClient {
        start = vi.fn().mockResolvedValue(undefined);
        createSession = createSession;
        stop = stop;
      }
      await runWithCopilotSDK({
        sdkUri: "http://127.0.0.1:3002",
        prompt: "test prompt",
        logger: () => {},
        permissionConfig: { allowedTools },
        sdkModule: {
          CopilotClient: FakeCopilotClient,
          RuntimeConnection: { forUri: vi.fn(() => ({})) },
          approveAll: () => ({ kind: "approve-once" }),
        },
      });
      return capturedHandler;
    }

    it("allows a piped command when SDK provides no identifiers but all commands are allowed", async () => {
      const handler = await makePermissionHandlerViaSDK(["shell(ls)", "shell(cat)", "shell(echo)"]);
      // Simulate what the Copilot SDK sends for a piped command: commands: [] (empty)
      const result = handler({
        kind: "shell",
        commands: [],
        fullCommandText: 'ls /tmp/dir 2>/dev/null && echo "---" && cat /tmp/file.json 2>/dev/null || echo "not found"',
      });
      expect(result).toEqual({ kind: "approve-once" });
    });

    it("denies a piped command when any stage is not in the allow-list", async () => {
      const handler = await makePermissionHandlerViaSDK(["shell(ls)", "shell(echo)"]);
      // cat is NOT in the allow-list
      const result = handler({
        kind: "shell",
        commands: [],
        fullCommandText: "ls /tmp && cat /tmp/file.json && echo done",
      });
      expect(result).toEqual({ kind: "reject", feedback: "Tool invocation is not allowed by workflow tool permissions." });
    });

    it("allows a safeoutputs || echo pipeline when both are allowed", async () => {
      const handler = await makePermissionHandlerViaSDK(["shell(safeoutputs:*)", "shell(echo)"]);
      const result = handler({
        kind: "shell",
        commands: [],
        fullCommandText: 'safeoutputs missing_data --help 2>/dev/null || echo "unavailable"',
      });
      expect(result).toEqual({ kind: "approve-once" });
    });

    it("allows a pwd && ls && safeoutputs && printf pipeline when all are allowed", async () => {
      const handler = await makePermissionHandlerViaSDK(["shell(pwd)", "shell(ls)", "shell(safeoutputs:*)", "shell(printf)"]);
      const result = handler({
        kind: "shell",
        commands: [],
        fullCommandText: "pwd && ls -la && safeoutputs --help && printf '%s\\n' done",
      });
      expect(result).toEqual({ kind: "approve-once" });
    });

    it("allows a piped grep/wc command when both are in the allow-list", async () => {
      const handler = await makePermissionHandlerViaSDK(["shell(grep)", "shell(wc)"]);
      const result = handler({
        kind: "shell",
        commands: [],
        fullCommandText: "grep -r pattern /tmp | wc -l",
      });
      expect(result).toEqual({ kind: "approve-once" });
    });

    it("preserves original single-command behaviour when SDK provides identifiers", async () => {
      const handler = await makePermissionHandlerViaSDK(["shell(git:*)"]);
      // SDK provides identifiers (non-piped path)
      expect(handler({ kind: "shell", commands: [{ identifier: "git" }], fullCommandText: "git status" })).toEqual({
        kind: "approve-once",
      });
      expect(handler({ kind: "shell", commands: [{ identifier: "rm" }], fullCommandText: "rm -rf /tmp/x" })).toEqual({
        kind: "reject",
        feedback: "Tool invocation is not allowed by workflow tool permissions.",
      });
    });

    it("allows safeoutputs command when SDK identifier includes full command text", async () => {
      const handler = await makePermissionHandlerViaSDK(["shell(safeoutputs:*)"]);
      const result = handler({
        kind: "shell",
        commands: [{ identifier: "safeoutputs --help 2>&1" }],
        fullCommandText: "safeoutputs --help 2>&1",
      });
      expect(result).toEqual({ kind: "approve-once" });
    });

    it("allows mcpscripts command when SDK identifier includes full command text", async () => {
      const handler = await makePermissionHandlerViaSDK(["shell(mcpscripts:*)"]);
      const result = handler({
        kind: "shell",
        commands: [{ identifier: "mcpscripts gh issue list --repo github/gh-aw" }],
        fullCommandText: "mcpscripts gh issue list --repo github/gh-aw",
      });
      expect(result).toEqual({ kind: "approve-once" });
    });

    it("denies when fullCommandText is empty and no identifiers provided", async () => {
      const handler = await makePermissionHandlerViaSDK(["shell(ls)"]);
      const result = handler({
        kind: "shell",
        commands: [],
        fullCommandText: "",
      });
      expect(result).toEqual({ kind: "reject", feedback: "Tool invocation is not allowed by workflow tool permissions." });
    });

    it("allows a :* wildcard rule to match pipeline stages with the given prefix", async () => {
      const handler = await makePermissionHandlerViaSDK(["shell(gh:*)", "shell(echo)"]);
      const result = handler({
        kind: "shell",
        commands: [],
        fullCommandText: "gh issue list && echo done",
      });
      expect(result).toEqual({ kind: "approve-once" });
    });

    it("denies multiline shell command when required tools are missing", async () => {
      const handler = await makePermissionHandlerViaSDK(["shell(mkdir)", "shell(git:*)", "shell(printf)", "shell(cat)", "shell(wc)"]);
      const result = handler({
        kind: "shell",
        commands: [],
        fullCommandText: `set -euo pipefail
CACHE_DIR='cache/gh-aw/cache-memory/compiler-quality'
ANALYSES_DIR="$CACHE_DIR/analyses"
mkdir -p "$ANALYSES_DIR"
FILES='compiler.go compiler_activation_jobs.go compiler_orchestrator.go compiler_jobs.go compiler_safe_outputs.go compiler_safe_outputs_config.go compiler_safe_outputs_job.go compiler_yaml.go compiler_yaml_main_job.go'
for f in $FILES; do git -C /home/runner/work/gh-aw/gh-aw log -1 --format='%H' -- "pkg/workflow/$f" | sed "s|^|$f |"; done
printf '---ROTATION---\n'
if [ -f "$CACHE_DIR/rotation.json" ]; then cat "$CACHE_DIR/rotation.json"; fi
printf '\n---HASHES---\n'
if [ -f "$CACHE_DIR/file-hashes.json" ]; then cat "$CACHE_DIR/file-hashes.json"; fi
printf '\n---FILES---\n'
for f in $FILES; do wc -l "/home/runner/work/gh-aw/gh-aw/pkg/workflow/$f"; done`,
      });
      expect(result).toEqual({ kind: "reject", feedback: "Tool invocation is not allowed by workflow tool permissions." });
    });

    it("approves multiline shell command when all required tools are permitted", async () => {
      const handler = await makePermissionHandlerViaSDK(["shell(set)", "shell(mkdir)", "shell(git:*)", "shell(sed)", "shell(printf)", "shell(cat)", "shell(wc)"]);
      const result = handler({
        kind: "shell",
        commands: [],
        fullCommandText: `set -euo pipefail
CACHE_DIR='cache/gh-aw/cache-memory/compiler-quality'
ANALYSES_DIR="$CACHE_DIR/analyses"
mkdir -p "$ANALYSES_DIR"
FILES='compiler.go compiler_activation_jobs.go compiler_orchestrator.go compiler_jobs.go compiler_safe_outputs.go compiler_safe_outputs_config.go compiler_safe_outputs_job.go compiler_yaml.go compiler_yaml_main_job.go'
for f in $FILES; do git -C /home/runner/work/gh-aw/gh-aw log -1 --format='%H' -- "pkg/workflow/$f" | sed "s|^|$f |"; done
printf '---ROTATION---\n'
if [ -f "$CACHE_DIR/rotation.json" ]; then cat "$CACHE_DIR/rotation.json"; fi
printf '\n---HASHES---\n'
if [ -f "$CACHE_DIR/file-hashes.json" ]; then cat "$CACHE_DIR/file-hashes.json"; fi
printf '\n---FILES---\n'
for f in $FILES; do wc -l "/home/runner/work/gh-aw/gh-aw/pkg/workflow/$f"; done`,
      });
      expect(result).toEqual({ kind: "approve-once" });
    });

    it("workspace files are always readable; only non-workspace paths require explicit read permission", async () => {
      // Regression fix (#49836): workspace root and its contents are always readable regardless
      // of tool restrictions. Only paths outside GITHUB_WORKSPACE require an explicit read grant.
      const prevWorkspace = process.env.GITHUB_WORKSPACE;
      process.env.GITHUB_WORKSPACE = "/home/runner/work/gh-aw/gh-aw";
      try {
        const deniedOutsideWorkspace = await makePermissionHandlerViaSDK(["shell(ls)"]);
        // Files inside the workspace are always readable — no explicit grant needed.
        expect(deniedOutsideWorkspace({ kind: "read", path: "/home/runner/work/gh-aw/gh-aw/AGENTS.md" })).toEqual({
          kind: "approve-once",
        });
        expect(deniedOutsideWorkspace({ kind: "read", path: "/home/runner/work/gh-aw/gh-aw/SKILL.md" })).toEqual({
          kind: "approve-once",
        });
        // Relative paths must be resolved inside the workspace and approved.
        expect(deniedOutsideWorkspace({ kind: "read", path: "AGENTS.md" })).toEqual({
          kind: "approve-once",
        });
        expect(deniedOutsideWorkspace({ kind: "read", path: "pkg/workflow/file.go" })).toEqual({
          kind: "approve-once",
        });
        // Path traversal attempts must be rejected even when they start with the workspace prefix.
        expect(deniedOutsideWorkspace({ kind: "read", path: "/home/runner/work/gh-aw/gh-aw/../../../../etc/passwd" })).toEqual({
          kind: "reject",
          feedback: "Tool invocation is not allowed by workflow tool permissions.",
        });
        // Files outside the workspace still require an explicit read grant.
        expect(deniedOutsideWorkspace({ kind: "read", path: "/etc/passwd" })).toEqual({
          kind: "reject",
          feedback: "Tool invocation is not allowed by workflow tool permissions.",
        });
        expect(deniedOutsideWorkspace({ kind: "read", path: "/home/runner/other-repo/secret.txt" })).toEqual({
          kind: "reject",
          feedback: "Tool invocation is not allowed by workflow tool permissions.",
        });

        const allowed = await makePermissionHandlerViaSDK(["read"]);
        // With an explicit read grant, all paths are readable.
        expect(allowed({ kind: "read", path: "/home/runner/work/gh-aw/gh-aw/AGENTS.md" })).toEqual({
          kind: "approve-once",
        });
        expect(allowed({ kind: "read", path: "/home/runner/work/gh-aw/gh-aw/SKILL.md" })).toEqual({
          kind: "approve-once",
        });
      } finally {
        if (prevWorkspace === undefined) {
          delete process.env.GITHUB_WORKSPACE;
        } else {
          process.env.GITHUB_WORKSPACE = prevWorkspace;
        }
      }
    });

    it("denies issue-37538 commands when workflow only allows jq shell usage", async () => {
      const handler = await makePermissionHandlerViaSDK(["shell(jq:*)"]);
      const deniedCommands = [
        "gh pr list --repo github/gh-aw --state open --draft --json number,title,author,createdAt,updatedAt,labels,headRefName --limit 100 2>&1",
        "safeoutputs --help 2>&1 | head -50",
        "git --no-pager status --short && gh pr list --repo github/gh-aw --state open --draft --json number,title,author,createdAt,updatedAt,labels,headRefName,comments,reviews --limit 100",
        'echo "test"',
      ];

      for (const command of deniedCommands) {
        expect(
          handler({
            kind: "shell",
            // Intentional: exercise fullCommandText fallback when SDK omits identifiers.
            commands: [],
            fullCommandText: command,
          })
        ).toEqual({ kind: "reject", feedback: "Tool invocation is not allowed by workflow tool permissions." });
      }
    });

    it("allows issue-37538 commands when corresponding shell permissions are granted", async () => {
      const handler = await makePermissionHandlerViaSDK(["shell(gh:*)", "shell(safeoutputs:*)", "shell(head)", "shell(git:*)", "shell(echo)"]);
      const allowedCommands = [
        "gh pr list --repo github/gh-aw --state open --draft --json number,title,author,createdAt,updatedAt,labels,headRefName --limit 100 2>&1",
        "safeoutputs --help 2>&1 | head -50",
        "git --no-pager status --short && gh pr list --repo github/gh-aw --state open --draft --json number,title,author,createdAt,updatedAt,labels,headRefName,comments,reviews --limit 100",
        'echo "test"',
      ];

      for (const command of allowedCommands) {
        expect(
          handler({
            kind: "shell",
            // Intentional: exercise fullCommandText fallback when SDK omits identifiers.
            commands: [],
            fullCommandText: command,
          })
        ).toEqual({ kind: "approve-once" });
      }
    });
  });
});
