import { describe, it, expect, vi } from "vitest";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { buildCopilotSDKPermissionHandler } = require("./copilot_sdk_permissions.cjs");

const APPROVED = { kind: "approve-once" };
const REJECTED = { kind: "reject", feedback: "Tool invocation is not allowed by workflow tool permissions." };
const SCOPED_TOOLS = ["shell(git checkout:*)", "shell(git branch:*)"];
const CHECKOUT = "git checkout -b automation/repro";
const BRANCH = "git branch --show-current";
const SEPARATORS = [" && ", " || ", " | ", "; ", "\n", "\r\n", "\r"];

function makeHandler(allowedTools = SCOPED_TOOLS, logOptions) {
  return buildCopilotSDKPermissionHandler({ allowedTools }, () => APPROVED, logOptions);
}

function shellRequest(fullCommandText, identifiers = []) {
  return { kind: "shell", fullCommandText, commands: identifiers.map(identifier => ({ identifier })) };
}

describe.each([
  { mode: "executable", identifiers: () => ["git"] },
  { mode: "full command", identifiers: command => [command] },
  { mode: "no", identifiers: () => [] },
])("scoped shell permissions with $mode SDK identifiers", ({ identifiers }) => {
  it.each([CHECKOUT, BRANCH])("approves issue #60364 command: %s", command => {
    expect(makeHandler()(shellRequest(command, identifiers(command)))).toEqual(APPROVED);
  });

  it.each([
    "git checkout",
    "git branch",
    "git checkout HEAD~1",
    "git checkout HEAD@{1}",
    "git branch topic HEAD~1",
    "git checkout @{-1}",
    'git checkout {a","b}',
    'git checkout {1.."3"}',
    "git checkout automation/repro -- file.txt",
    "git\tcheckout\t-b\tautomation/repro",
    "'git' \"checkout\" -b automation/repro",
    "g\"it\" ch'eck'out -b automation/repro",
    "git checkout -- 'a;b&c.txt'",
    'git checkout -- "a;b&c.txt"',
    "git checkout -- a\\;b\\&c.txt",
    "git checkout -- '$(git push)'",
    "git checkout -- '`git push`'",
    'git checkout -- "\\$(git push)"',
    `${CHECKOUT} 2>&1`,
    `${CHECKOUT} >out.txt 2>&1`,
    "git checkout \\\n  -b automation/repro",
    "g\\\nit ch\\\neckout",
    `\n${CHECKOUT}\r\n`,
  ])("matches complete literal token prefixes: %s", command => {
    expect(makeHandler()(shellRequest(command, identifiers(command)))).toEqual(APPROVED);
  });

  it.each(["git checkoutish", "git checkout-other", "git branches", "git branch-other", "git push", '"git checkout" -b automation/repro', "git --no-pager checkout", "git\\\ncheckout"])("does not widen a scoped prefix: %s", command => {
    expect(makeHandler()(shellRequest(command, identifiers(command)))).toEqual(REJECTED);
  });

  it.each(SEPARATORS)("allows every granted segment separated by %j", separator => {
    const command = [CHECKOUT, BRANCH, CHECKOUT].join(separator);
    expect(makeHandler()(shellRequest(command, identifiers(command)))).toEqual(APPROVED);
  });

  it.each(
    SEPARATORS.flatMap(separator =>
      [
        ["git checkout", "git push"],
        [CHECKOUT, "git push"],
        ["git push", CHECKOUT],
        [CHECKOUT, BRANCH, "git push"],
        [CHECKOUT, "git push", BRANCH],
      ].map(segments => segments.join(separator))
    )
  )("rejects an ungranted stage without deduplicating git: %j", command => {
    expect(makeHandler()(shellRequest(command, identifiers(command)))).toEqual(REJECTED);
  });

  it.each([
    `${CHECKOUT} & ${BRANCH}`,
    `${CHECKOUT} &`,
    `${CHECKOUT} 2>&1 & ${BRANCH}`,
    "git checkout -- 'unclosed",
    'git checkout -- "unclosed',
    "git checkout -- trailing\\",
    "git checkout &&",
    "git checkout ||",
    "git checkout |",
    "git checkout;",
    "git checkout &&\r\n",
    "git checkout && ; git branch",
    "git checkout ||| git branch",
    "git checkout $(git push)",
    'git checkout "$(git push)"',
    'git checkout "$(echo $(git push))"',
    "git checkout `git push`",
    'git checkout "`git push`"',
    "git checkout <(git push)",
    "git checkout >(git push)",
    "git checkout <<EOF\ngit push\nEOF",
    "git checkout <<-EOF\r\ngit push\r\nEOF",
    'git checkout <<< "literal"',
    "if git checkout; then git branch; fi",
    "{ git checkout; git branch; }",
    "(git checkout)",
    "git checkout && fi",
    "git checkout && NAME=value",
    "NAME=value git checkout",
    "git checkout # comment",
    "git checkout $branch",
    "git checkout ${branch}",
    "git checkout *",
    "git checkout ~",
    "git checkout name=~",
    "git checkout name=x:~",
    "git check{out,-ref}",
    "git checkout {topic,other}",
    "git checkout topic{1..3}",
    "git checkout {a..z}",
    "git checkout {3..1..-1}",
    "git checkout {+1..+3..+1}",
    "git checkout {1.\\\n.3}",
    "git checkout {nested,{topic,other}}",
    "git checkout {nested,{1..3}}",
    "git checkout >",
    "git checkout \0",
    "&&",
  ])("fails closed on unsupported or malformed scoped syntax: %j", command => {
    expect(makeHandler()(shellRequest(command, identifiers(command)))).toEqual(REJECTED);
  });

  it.each([
    { rule: "shell(git status)", command: "git status", result: APPROVED },
    { rule: "shell(git status)", command: "  git status  ", result: APPROVED },
    { rule: "shell(git status)", command: "git status --short", result: REJECTED },
    { rule: "shell(git status)", command: "git\tstatus", result: REJECTED },
    { rule: "shell(git status)", command: "git status && git status", result: REJECTED },
    { rule: "shell(git status)", command: "git status && git push", result: REJECTED },
    { rule: "shell(git)", command: "git push", result: APPROVED },
    { rule: "shell(git:*)", command: `${CHECKOUT} && git push`, result: APPROVED },
    { rule: "shell(git:*)", command: "git checkout $(git push)", result: APPROVED },
    { rule: "shell(git:*)", command: "if git branch; then git checkout; fi", result: APPROVED },
    { rule: "shell", command: `${CHECKOUT} & git push`, result: APPROVED },
  ])("preserves the independent legacy grant $rule for $command", ({ rule, command, result }) => {
    for (const tools of [[rule], [...SCOPED_TOOLS, rule], [rule, ...SCOPED_TOOLS]]) {
      expect(makeHandler(tools)(shellRequest(command, identifiers(command)))).toEqual(result);
    }
  });

  it("preserves an explicit whole-chain exact grant, not a per-stage grant", () => {
    const command = `${CHECKOUT} && echo done`;
    const rule = `shell(${command})`;
    for (const tools of [[rule], [...SCOPED_TOOLS, rule], [rule, ...SCOPED_TOOLS]]) {
      const handler = makeHandler(tools);
      expect(handler(shellRequest(command, identifiers(command)))).toEqual(APPROVED);
      const extended = `${command} && git push`;
      expect(handler(shellRequest(extended, identifiers(extended)))).toEqual(REJECTED);
    }
  });

  it("does not let a scoped parse rejection veto an exact whole-command grant", () => {
    const command = 'git checkout "$(git branch)"';
    const rule = `shell(${command})`;
    for (const tools of [
      [...SCOPED_TOOLS, rule],
      [rule, ...SCOPED_TOOLS],
    ]) {
      expect(makeHandler(tools)(shellRequest(command, identifiers(command)))).toEqual(APPROVED);
    }
  });

  it.each([
    { command: "git status", result: APPROVED },
    { command: "git status --short", result: REJECTED },
    { command: CHECKOUT, result: APPROVED },
    { command: `${CHECKOUT} && echo done`, result: APPROVED },
    { command: `echo done && ${CHECKOUT}`, result: APPROVED },
    { command: `git status && ${CHECKOUT}`, result: REJECTED },
    { command: `${CHECKOUT} && git status`, result: REJECTED },
    { command: `${CHECKOUT} && echo done && git push`, result: REJECTED },
    { command: "echo done && git push", result: REJECTED },
    { command: 'git checkout "$(git push)" && echo done', result: REJECTED },
  ])("keeps mixed exact/scoped/executable rules order-independent: $command", ({ command, result }) => {
    for (const echoRule of ["shell(echo)", "shell(echo:*)"]) {
      const tools = ["shell(git status)", ...SCOPED_TOOLS, echoRule];
      expect(makeHandler(tools)(shellRequest(command, identifiers(command)))).toEqual(result);
      expect(makeHandler([...tools].reverse())(shellRequest(command, identifiers(command)))).toEqual(result);
    }
  });
});

describe("scoped shell permission boundaries", () => {
  it.each([
    { label: "absent", text: undefined },
    { label: "null", text: null },
    { label: "empty", text: "" },
    { label: "blank", text: " \t\r\n " },
    { label: "number", text: 42 },
    { label: "boolean", text: true },
    { label: "array", text: [CHECKOUT] },
    { label: "object without string conversion", text: Object.create(null) },
    { label: "coercible object", text: { toString: () => CHECKOUT } },
  ])("requires string fullCommandText, not $label text or a helpful identifier", ({ text }) => {
    for (const identifiers of [[], ["git"], [CHECKOUT], ["git checkout"]]) {
      expect(makeHandler()(shellRequest(text, identifiers))).toEqual(REJECTED);
    }
  });

  it("does not require the optional SDK commands array for scoped authorization", () => {
    expect(makeHandler()({ kind: "shell", fullCommandText: CHECKOUT })).toEqual(APPROVED);
    expect(makeHandler()({ kind: "shell", commands: [{ identifier: CHECKOUT }] })).toEqual(REJECTED);
  });

  it("does not coerce non-string command text even while logging a rejection", () => {
    const toString = vi.fn(() => {
      throw new Error("Command text must not be coerced");
    });
    const logger = vi.fn();
    const onDenied = vi.fn();
    const handler = makeHandler(SCOPED_TOOLS, { logger, onDenied });

    expect(handler(shellRequest({ toString }, ["git checkout"]))).toEqual(REJECTED);
    expect(toString).not.toHaveBeenCalled();
    expect(logger.mock.calls).toEqual([["permission denied by workflow tool permissions: shell(unknown)"]]);
    expect(onDenied.mock.calls).toEqual([["shell(unknown)"]]);
  });

  it.each([{ identifiers: ["git checkout"] }, { identifiers: ["git branch"] }, { identifiers: [CHECKOUT, BRANCH] }, { identifiers: ["echo"] }, { identifiers: ["git", "echo"] }])(
    "does not trust misleading SDK identifiers $identifiers over command text",
    ({ identifiers }) => {
      const handler = makeHandler([...SCOPED_TOOLS, "shell(echo)"]);
      expect(handler(shellRequest("git push", identifiers))).toEqual(REJECTED);
      expect(handler(shellRequest("echo done && git push", identifiers))).toEqual(REJECTED);
      expect(handler(shellRequest('git checkout "$(git push)" && echo done', identifiers))).toEqual(REJECTED);
    }
  );

  it.each(["shell(git\tcheckout:*)", "shell('git' \"checkout\":*)", "shell(git checkout -b:*)"])("supports a complete token prefix in the rule %s", rule => {
    expect(makeHandler([rule])(shellRequest(CHECKOUT, ["git"]))).toEqual(APPROVED);
    expect(makeHandler([rule])(shellRequest("git checkout-other -b automation/repro", ["git"]))).toEqual(REJECTED);
  });

  it("applies scoped matching to non-git and longer prefixes", () => {
    const handler = makeHandler(["shell(gh issue list:*)"]);
    expect(handler(shellRequest("gh issue list"))).toEqual(APPROVED);
    expect(handler(shellRequest("gh issue list --limit 5"))).toEqual(APPROVED);
    expect(handler(shellRequest("gh issue listing"))).toEqual(REJECTED);
    expect(handler(shellRequest("gh issue list && gh issue close 1"))).toEqual(REJECTED);
  });

  it.each(["git checkout && git push", "git checkout >out.txt", "git checkout $(git push)", "git checkout 'unclosed", '"git checkout"'])("does not turn an unsupported scoped rule into an identifier grant: %s", prefix => {
    const handler = makeHandler([`shell(${prefix}:*)`]);
    expect(handler(shellRequest("git push", [prefix]))).toEqual(REJECTED);
    expect(handler(shellRequest(CHECKOUT, [prefix]))).toEqual(REJECTED);
  });

  it.each(["shell(ls)", "shell(ls:*)"])("preserves single-executable rule %s with each SDK identifier shape", rule => {
    const command = "ls -la";
    for (const identifiers of [[], ["ls"], [command]]) {
      expect(makeHandler([rule])(shellRequest(command, identifiers))).toEqual(APPROVED);
    }
    expect(makeHandler([rule])(shellRequest("", ["ls"]))).toEqual(APPROVED);
    expect(makeHandler([rule])(shellRequest("", []))).toEqual(REJECTED);
    expect(makeHandler([rule])(shellRequest("ls -la && git push", ["ls"]))).toEqual(REJECTED);
  });

  it("keeps the rejection shape and invokes existing denial hooks exactly once", () => {
    const command = `${CHECKOUT} && git push`;
    const summary = `shell(${command})`;
    const logger = vi.fn();
    const coreLogger = { info: vi.fn(), warning: vi.fn() };
    const onDenied = vi.fn();
    const handler = makeHandler(SCOPED_TOOLS, { logger, coreLogger, onDenied });

    expect(handler(shellRequest(command, ["git checkout"]))).toEqual(REJECTED);
    expect(logger.mock.calls).toEqual([[`permission denied by workflow tool permissions: ${summary}`]]);
    expect(coreLogger.info.mock.calls).toEqual([[`Copilot SDK permission denied: ${summary}`]]);
    expect(coreLogger.warning.mock.calls).toEqual([[`Copilot SDK permission denied by workflow tool permissions: ${summary}`]]);
    expect(onDenied.mock.calls).toEqual([[summary]]);
  });

  it("does not report a denial when an independent legacy route approves", () => {
    const logger = vi.fn();
    const onDenied = vi.fn();
    const handler = makeHandler([...SCOPED_TOOLS, "shell(git:*)"], { logger, onDenied });

    expect(handler(shellRequest("git checkout $(git push)", ["git"]))).toEqual(APPROVED);
    expect(logger).not.toHaveBeenCalled();
    expect(onDenied).not.toHaveBeenCalled();
  });

  it("does not let tolerant legacy parsing override an ungranted literal executable", () => {
    const handler = makeHandler([...SCOPED_TOOLS, "shell(git:*)"]);
    expect(handler(shellRequest("git\\\ncheckout", ["git"]))).toEqual(REJECTED);
    expect(handler(shellRequest("git\\\r\ncheckout", ["git"]))).toEqual(REJECTED);
  });
});
