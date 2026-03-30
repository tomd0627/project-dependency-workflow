/**
 * @fileoverview Tests for the updater module.
 */

import { jest } from "@jest/globals";

// ── Mock node:child_process before importing the module under test ─────────────

const mockExec = jest.fn();

jest.unstable_mockModule("node:child_process", () => ({
  exec: mockExec,
}));

const { applyUpdates, buildNpmInstallArgs, updateNodeDependencies } =
  await import("../src/updater.js");

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Configures mockExec to call back as a successful promisify-compatible exec.
 * node:util/promisify wraps a callback(err, result) function.
 */
const mockExecSuccess = (stdout = "", stderr = "") => {
  mockExec.mockImplementation((_cmd, _opts, cb) => cb(null, { stdout, stderr }));
};

const mockExecFailure = (message = "Command failed", stdout = "", stderr = "") => {
  const err = Object.assign(new Error(message), { stdout, stderr });
  mockExec.mockImplementation((_cmd, _opts, cb) => cb(err));
};

beforeEach(() => mockExec.mockReset());

// ── buildNpmInstallArgs ───────────────────────────────────────────────────────

describe("buildNpmInstallArgs", () => {
  it("formats a single package as name@version", () => {
    expect(buildNpmInstallArgs([{ name: "lodash", version: "4.17.21" }])).toEqual([
      "lodash@4.17.21",
    ]);
  });

  it("formats multiple packages", () => {
    const result = buildNpmInstallArgs([
      { name: "lodash", version: "4.17.21" },
      { name: "axios", version: "1.7.0" },
    ]);
    expect(result).toEqual(["lodash@4.17.21", "axios@1.7.0"]);
  });

  it("handles scoped packages correctly", () => {
    expect(buildNpmInstallArgs([{ name: "@octokit/rest", version: "21.0.2" }])).toEqual([
      "@octokit/rest@21.0.2",
    ]);
  });

  it("returns an empty array when given no packages", () => {
    expect(buildNpmInstallArgs([])).toEqual([]);
  });
});

// ── updateNodeDependencies ────────────────────────────────────────────────────

describe("updateNodeDependencies", () => {
  it("calls npm install with the correct package specifiers", async () => {
    mockExecSuccess("added 1 package");
    await updateNodeDependencies({
      repoPath: "/tmp/repo",
      packages: [{ name: "lodash", version: "4.17.21" }],
    });
    expect(mockExec).toHaveBeenCalledTimes(1);
    const [cmd, opts] = mockExec.mock.calls[0];
    expect(cmd).toContain("npm install");
    expect(cmd).toContain("lodash@4.17.21");
    expect(opts.cwd).toBe("/tmp/repo");
  });

  it("includes all packages in a single install command", async () => {
    mockExecSuccess();
    await updateNodeDependencies({
      repoPath: "/tmp/repo",
      packages: [
        { name: "lodash", version: "4.17.21" },
        { name: "axios", version: "1.7.0" },
      ],
    });
    const [cmd] = mockExec.mock.calls[0];
    expect(cmd).toContain("lodash@4.17.21");
    expect(cmd).toContain("axios@1.7.0");
  });

  it("skips the exec call when packages array is empty", async () => {
    await updateNodeDependencies({ repoPath: "/tmp/repo", packages: [] });
    expect(mockExec).not.toHaveBeenCalled();
  });

  it("propagates exec errors to the caller", async () => {
    mockExecFailure("ENOENT: npm not found");
    await expect(
      updateNodeDependencies({ repoPath: "/tmp/repo", packages: [{ name: "x", version: "1.0.0" }] })
    ).rejects.toThrow("ENOENT: npm not found");
  });
});

// ── applyUpdates ──────────────────────────────────────────────────────────────

describe("applyUpdates", () => {
  it("dispatches to updateNodeDependencies for the node ecosystem", async () => {
    mockExecSuccess();
    await expect(
      applyUpdates({
        ecosystem: "node",
        repoPath: "/tmp/repo",
        packages: [{ name: "lodash", version: "4.17.21" }],
      })
    ).resolves.toBeUndefined();
    expect(mockExec).toHaveBeenCalledTimes(1);
  });

  it("throws for an unsupported ecosystem", async () => {
    await expect(
      applyUpdates({ ecosystem: "ruby", repoPath: "/tmp/repo", packages: [] })
    ).rejects.toThrow(/Unsupported ecosystem/);
  });

  it("throws with the ecosystem name in the error message", async () => {
    await expect(
      applyUpdates({ ecosystem: "rust", repoPath: "/tmp/repo", packages: [] })
    ).rejects.toThrow("rust");
  });
});
