/**
 * @fileoverview Tests for the qa module.
 */

import { jest } from "@jest/globals";

// ── Mock node:child_process and node:fs/promises before importing ─────────────

const mockExec = jest.fn();
const mockReadFile = jest.fn();
const mockAccess = jest.fn();

jest.unstable_mockModule("node:child_process", () => ({ exec: mockExec }));
jest.unstable_mockModule("node:fs/promises", () => ({
  access: mockAccess,
  readFile: mockReadFile,
}));

const { detectTestCommand, parseTestCount, runTestSuite } = await import("../src/qa.js");

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Configures mockExec for a passing test run. */
const mockExecSuccess = (stdout = "", stderr = "") => {
  mockExec.mockImplementation((_cmd, _opts, cb) => cb(null, { stdout, stderr }));
};

/** Configures mockExec for a failing test run (non-zero exit). */
const mockExecFailure = (stdout = "", stderr = "", message = "Command failed") => {
  const err = Object.assign(new Error(message), { stdout, stderr });
  mockExec.mockImplementation((_cmd, _opts, cb) => cb(err));
};

/** Builds a minimal package.json with the given test script. */
const makePackageJson = (testScript) =>
  JSON.stringify({ name: "test-pkg", scripts: { test: testScript } });

beforeEach(() => {
  mockExec.mockReset();
  mockReadFile.mockReset();
  mockAccess.mockReset();
});

// ── parseTestCount ────────────────────────────────────────────────────────────

describe("parseTestCount", () => {
  it("parses Jest verbose format", () => {
    expect(parseTestCount("Tests: 84 passed, 0 failed, 84 total")).toBe(84);
  });

  it("parses Jest compact / pytest format", () => {
    expect(parseTestCount("84 passed in 1.23s")).toBe(84);
  });

  it("parses cargo test format", () => {
    expect(parseTestCount("test result: ok. 12 passed; 0 failed; 0 ignored")).toBe(12);
  });

  it("returns 0 when no recognized pattern matches", () => {
    expect(parseTestCount("Build succeeded")).toBe(0);
  });

  it("returns 0 for empty output", () => {
    expect(parseTestCount("")).toBe(0);
  });

  it("prefers Jest verbose over generic '84 passed' when both match", () => {
    expect(parseTestCount("Tests: 10 passed\n10 passed in 0.5s")).toBe(10);
  });
});

// ── detectTestCommand ─────────────────────────────────────────────────────────

describe("detectTestCommand", () => {
  it("returns 'npm test' when package.json has a non-placeholder test script", async () => {
    mockReadFile.mockResolvedValue(makePackageJson("jest"));
    const cmd = await detectTestCommand("/repo");
    expect(cmd).toBe("npm test");
  });

  it("ignores the default npm placeholder test script", async () => {
    mockReadFile.mockResolvedValue(
      makePackageJson('echo "Error: no test specified" && exit 1')
    );
    mockAccess.mockRejectedValue(new Error("ENOENT")); // no other ecosystem files
    const cmd = await detectTestCommand("/repo");
    expect(cmd).toBeNull();
  });

  it("returns 'python -m pytest' when pytest.ini is present", async () => {
    mockReadFile.mockRejectedValue(new Error("ENOENT")); // no package.json
    mockAccess.mockImplementation((p) =>
      p.endsWith("pytest.ini") ? Promise.resolve() : Promise.reject(new Error("ENOENT"))
    );
    const cmd = await detectTestCommand("/repo");
    expect(cmd).toBe("python -m pytest");
  });

  it("returns 'cargo test' when Cargo.toml is present", async () => {
    mockReadFile.mockRejectedValue(new Error("ENOENT"));
    mockAccess.mockImplementation((p) =>
      p.endsWith("Cargo.toml") ? Promise.resolve() : Promise.reject(new Error("ENOENT"))
    );
    const cmd = await detectTestCommand("/repo");
    expect(cmd).toBe("cargo test");
  });

  it("returns 'go test ./...' when go.mod is present", async () => {
    mockReadFile.mockRejectedValue(new Error("ENOENT"));
    mockAccess.mockImplementation((p) =>
      p.endsWith("go.mod") ? Promise.resolve() : Promise.reject(new Error("ENOENT"))
    );
    const cmd = await detectTestCommand("/repo");
    expect(cmd).toBe("go test ./...");
  });

  it("returns null when no recognized ecosystem is found", async () => {
    mockReadFile.mockRejectedValue(new Error("ENOENT"));
    mockAccess.mockRejectedValue(new Error("ENOENT"));
    const cmd = await detectTestCommand("/repo");
    expect(cmd).toBeNull();
  });

  it("prefers Node.js over Python when both files exist", async () => {
    mockReadFile.mockResolvedValue(makePackageJson("jest"));
    mockAccess.mockResolvedValue(); // all files exist
    const cmd = await detectTestCommand("/repo");
    expect(cmd).toBe("npm test");
  });
});

// ── runTestSuite ──────────────────────────────────────────────────────────────

describe("runTestSuite", () => {
  it("returns passed: true when the command exits with code 0", async () => {
    mockExecSuccess("Tests: 12 passed, 0 failed, 12 total");
    const result = await runTestSuite({ repoPath: "/repo", command: "npm test" });
    expect(result.passed).toBe(true);
    expect(result.testCount).toBe(12);
    expect(result.output).toContain("12 passed");
  });

  it("returns passed: false when the command exits with a non-zero code", async () => {
    mockExecFailure("Tests: 3 passed, 2 failed", "", "Test suite failed");
    const result = await runTestSuite({ repoPath: "/repo", command: "npm test" });
    expect(result.passed).toBe(false);
    expect(result.testCount).toBe(3);
  });

  it("includes the command's cwd in the exec call", async () => {
    mockExecSuccess();
    await runTestSuite({ repoPath: "/my/repo", command: "npm test" });
    const [, opts] = mockExec.mock.calls[0];
    expect(opts.cwd).toBe("/my/repo");
  });

  it("passes a timeout to exec", async () => {
    mockExecSuccess();
    await runTestSuite({ repoPath: "/repo", command: "npm test" });
    const [, opts] = mockExec.mock.calls[0];
    expect(typeof opts.timeout).toBe("number");
    expect(opts.timeout).toBeGreaterThan(0);
  });

  it("returns a duration in milliseconds", async () => {
    mockExecSuccess();
    const result = await runTestSuite({ repoPath: "/repo", command: "npm test" });
    expect(typeof result.duration).toBe("number");
    expect(result.duration).toBeGreaterThanOrEqual(0);
  });

  it("returns testCount: 0 when output has no parseable test count", async () => {
    mockExecSuccess("Build complete");
    const result = await runTestSuite({ repoPath: "/repo", command: "make test" });
    expect(result.testCount).toBe(0);
  });

  it("still captures stdout from a failed run", async () => {
    mockExecFailure("1 passed, 5 failed", "");
    const result = await runTestSuite({ repoPath: "/repo", command: "npm test" });
    expect(result.output).toContain("1 passed, 5 failed");
  });
});
