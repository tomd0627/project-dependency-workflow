/**
 * @fileoverview Tests for the autofixer module.
 */

import { jest } from "@jest/globals";

// ── Mock node:child_process and node:fs/promises before importing ─────────────

const mockExec = jest.fn();
const mockWriteFile = jest.fn();

jest.unstable_mockModule("node:child_process", () => ({ exec: mockExec }));
jest.unstable_mockModule("node:fs/promises", () => ({ writeFile: mockWriteFile }));

const { autofixRegressions } = await import("../src/autofixer.js");

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Configures mockExec to simulate a passing test run. */
const execPass = (stdout = "Tests: 5 passed") => {
  mockExec.mockImplementation((_cmd, _opts, cb) => cb(null, { stdout, stderr: "" }));
};

/** Configures mockExec to simulate a failing test run. */
const execFail = (stdout = "Tests: 1 failed") => {
  const err = Object.assign(new Error("Test suite failed"), { stdout, stderr: "" });
  mockExec.mockImplementation((_cmd, _opts, cb) => cb(err));
};

/**
 * Builds a mock Anthropic client whose messages.create returns the given
 * text responses in sequence.
 */
const makeClient = (...responses) => {
  let call = 0;
  return {
    messages: {
      create: jest.fn().mockImplementation(() => {
        const text = responses[Math.min(call++, responses.length - 1)];
        return Promise.resolve({ content: [{ type: "text", text }] });
      }),
    },
  };
};

/** A minimal JSON response with one file change. */
const ONE_CHANGE = JSON.stringify([{ file: "src/index.js", content: "// fixed" }]);

/** An empty response indicating Claude has no suggestions. */
const NO_CHANGES = "[]";

const BASE = {
  repoPath: "/repo",
  failureOutput: "Error: Cannot find module 'x'",
  patchDiff: "-  \"x\": \"1.0.0\"\n+  \"x\": \"2.0.0\"",
  maxAttempts: 3,
  testCommand: "npm test",
};

beforeEach(() => {
  mockExec.mockReset();
  mockWriteFile.mockReset().mockResolvedValue(undefined);
});

// ── no suggestions ────────────────────────────────────────────────────────────

describe("autofixRegressions — no suggestions", () => {
  it("returns fixed: false when Claude returns an empty array", async () => {
    const client = makeClient(NO_CHANGES);
    const result = await autofixRegressions({ ...BASE, client });
    expect(result.fixed).toBe(false);
  });

  it("does not run tests when Claude returns no changes", async () => {
    const client = makeClient(NO_CHANGES);
    await autofixRegressions({ ...BASE, client });
    expect(mockExec).not.toHaveBeenCalled();
  });

  it("records the empty-suggestion attempt in the trace", async () => {
    const client = makeClient(NO_CHANGES);
    const { trace } = await autofixRegressions({ ...BASE, client });
    expect(trace.some((t) => t.includes("no suggestions"))).toBe(true);
  });

  it("returns fixed: false when Claude response contains no JSON array", async () => {
    const client = makeClient("I cannot determine a fix for this issue.");
    const result = await autofixRegressions({ ...BASE, client });
    expect(result.fixed).toBe(false);
  });
});

// ── first attempt succeeds ────────────────────────────────────────────────────

describe("autofixRegressions — fix on first attempt", () => {
  it("returns fixed: true when tests pass after applying changes", async () => {
    execPass();
    const client = makeClient(ONE_CHANGE);
    const result = await autofixRegressions({ ...BASE, client });
    expect(result.fixed).toBe(true);
  });

  it("returns attempts: 1 when fixed on the first try", async () => {
    execPass();
    const client = makeClient(ONE_CHANGE);
    const result = await autofixRegressions({ ...BASE, client });
    expect(result.attempts).toBe(1);
  });

  it("writes each suggested file to the repo path", async () => {
    execPass();
    const changes = JSON.stringify([
      { file: "src/a.js", content: "// a" },
      { file: "src/b.js", content: "// b" },
    ]);
    const client = makeClient(changes);
    await autofixRegressions({ ...BASE, client });
    expect(mockWriteFile).toHaveBeenCalledTimes(2);
    expect(mockWriteFile).toHaveBeenCalledWith("/repo/src/a.js", "// a", "utf8");
    expect(mockWriteFile).toHaveBeenCalledWith("/repo/src/b.js", "// b", "utf8");
  });

  it("runs the test command with the correct cwd", async () => {
    execPass();
    const client = makeClient(ONE_CHANGE);
    await autofixRegressions({ ...BASE, client, repoPath: "/my/repo" });
    const [, opts] = mockExec.mock.calls[0];
    expect(opts.cwd).toBe("/my/repo");
  });

  it("uses the provided testCommand", async () => {
    execPass();
    const client = makeClient(ONE_CHANGE);
    await autofixRegressions({ ...BASE, client, testCommand: "cargo test" });
    const [cmd] = mockExec.mock.calls[0];
    expect(cmd).toBe("cargo test");
  });

  it("includes 'tests passed' in the trace", async () => {
    execPass();
    const client = makeClient(ONE_CHANGE);
    const { trace } = await autofixRegressions({ ...BASE, client });
    expect(trace.some((t) => t.includes("tests passed"))).toBe(true);
  });
});

// ── retries ───────────────────────────────────────────────────────────────────

describe("autofixRegressions — retries", () => {
  it("retries after a failing test run and fixes on the second attempt", async () => {
    // First exec fails, second exec passes.
    mockExec
      .mockImplementationOnce((_cmd, _opts, cb) =>
        cb(Object.assign(new Error("fail"), { stdout: "1 failed", stderr: "" }))
      )
      .mockImplementationOnce((_cmd, _opts, cb) =>
        cb(null, { stdout: "5 passed", stderr: "" })
      );

    const client = makeClient(ONE_CHANGE, ONE_CHANGE);
    const result = await autofixRegressions({ ...BASE, client });
    expect(result.fixed).toBe(true);
    expect(result.attempts).toBe(2);
  });

  it("returns fixed: false after exhausting all attempts", async () => {
    execFail();
    const client = makeClient(ONE_CHANGE, ONE_CHANGE, ONE_CHANGE);
    const result = await autofixRegressions({ ...BASE, client, maxAttempts: 3 });
    expect(result.fixed).toBe(false);
    expect(result.attempts).toBe(3);
  });

  it("calls Claude once per attempt", async () => {
    execFail();
    const client = makeClient(ONE_CHANGE, ONE_CHANGE, ONE_CHANGE);
    await autofixRegressions({ ...BASE, client, maxAttempts: 3 });
    expect(client.messages.create).toHaveBeenCalledTimes(3);
  });

  it("trace records each failing attempt", async () => {
    execFail();
    const client = makeClient(ONE_CHANGE, ONE_CHANGE);
    const { trace } = await autofixRegressions({ ...BASE, client, maxAttempts: 2 });
    expect(trace.filter((t) => t.includes("still failing"))).toHaveLength(2);
  });
});
