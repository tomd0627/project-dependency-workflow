/**
 * @fileoverview Tests for the publisher module.
 */

import { jest } from "@jest/globals";
import { createUpdateBranch, openPullRequest, renderPrBody } from "../src/publisher.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

const BASE_SHA = "abc123def456";
const DEFAULT_BRANCH = "main";

/** Minimal RiskScore entry. */
const makeResult = (overrides = {}) => ({
  packageName: "lodash",
  currentVersion: "4.17.20",
  latestVersion: "4.17.21",
  updateType: "patch",
  riskScore: 10,
  recommendation: "THUMBS_UP",
  summary: "Security patch.",
  breakingChanges: [],
  ramifications: [],
  changelogUrl: null,
  ...overrides,
});

/** Minimal DependencyReport. */
const makeReport = (overrides = {}) => ({
  owner: "octokit",
  repo: "rest.js",
  scannedAt: "2026-03-30T12:00:00.000Z",
  results: [makeResult()],
  ...overrides,
});

/**
 * Builds a mock Octokit covering all endpoints used by publisher.js.
 * Individual methods can be overridden via the `overrides` map.
 */
const makeOctokit = (overrides = {}) => ({
  rest: {
    repos: {
      get: jest.fn().mockResolvedValue({ data: { default_branch: DEFAULT_BRANCH } }),
      ...overrides.repos,
    },
    git: {
      getRef: jest.fn().mockResolvedValue({ data: { object: { sha: BASE_SHA } } }),
      createRef: jest.fn().mockResolvedValue({}),
      ...overrides.git,
    },
    pulls: {
      create: jest.fn().mockResolvedValue({
        data: { number: 42, html_url: "https://github.com/octokit/rest.js/pull/42" },
      }),
      ...overrides.pulls,
    },
    issues: {
      addLabels: jest.fn().mockResolvedValue({}),
      ...overrides.issues,
    },
  },
});

// ── renderPrBody ──────────────────────────────────────────────────────────────

describe("renderPrBody", () => {
  it("includes a row for each result", () => {
    const report = makeReport({
      results: [makeResult({ packageName: "lodash" }), makeResult({ packageName: "axios" })],
    });
    const body = renderPrBody(report, false);
    expect(body).toContain("`lodash`");
    expect(body).toContain("`axios`");
  });

  it("shows current and latest versions", () => {
    const body = renderPrBody(makeReport(), false);
    expect(body).toContain("`4.17.20`");
    expect(body).toContain("`4.17.21`");
  });

  it("includes a security warning when hasSecurityFixes is true", () => {
    const body = renderPrBody(makeReport(), true);
    expect(body).toContain("security-relevant");
  });

  it("omits the security warning when hasSecurityFixes is false", () => {
    const body = renderPrBody(makeReport(), false);
    expect(body).not.toContain("security-relevant");
  });

  it("includes a build-failure warning when qaFailed is true", () => {
    const body = renderPrBody(makeReport(), false, true);
    expect(body).toContain("Build failed");
    expect(body).toContain("draft");
  });

  it("omits the build-failure warning when qaFailed is false", () => {
    const body = renderPrBody(makeReport(), false, false);
    expect(body).not.toContain("Build failed");
  });

  it("uses a green indicator for low-risk scores (≤30)", () => {
    const body = renderPrBody(makeReport({ results: [makeResult({ riskScore: 10 })] }), false);
    expect(body).toContain("🟢");
  });

  it("uses a yellow indicator for medium-risk scores (31–70)", () => {
    const body = renderPrBody(makeReport({ results: [makeResult({ riskScore: 50 })] }), false);
    expect(body).toContain("🟡");
  });

  it("uses a red indicator for high-risk scores (>70)", () => {
    const body = renderPrBody(makeReport({ results: [makeResult({ riskScore: 90 })] }), false);
    expect(body).toContain("🔴");
  });
});

// ── createUpdateBranch ────────────────────────────────────────────────────────

describe("createUpdateBranch", () => {
  it("creates a branch and returns its name", async () => {
    const octokit = makeOctokit();
    const branch = await createUpdateBranch({ octokit, owner: "org", repo: "repo", date: "2026-03-30" });
    expect(branch).toBe("deps/update-2026-03-30");
    expect(octokit.rest.git.createRef).toHaveBeenCalledTimes(1);
  });

  it("fetches the default branch SHA and uses it as the base", async () => {
    const octokit = makeOctokit();
    await createUpdateBranch({ octokit, owner: "org", repo: "repo", date: "2026-03-30" });
    const call = octokit.rest.git.createRef.mock.calls[0][0];
    expect(call.sha).toBe(BASE_SHA);
  });

  it("uses refs/heads/ prefix in the createRef call", async () => {
    const octokit = makeOctokit();
    await createUpdateBranch({ octokit, owner: "org", repo: "repo", date: "2026-03-30" });
    const call = octokit.rest.git.createRef.mock.calls[0][0];
    expect(call.ref).toBe("refs/heads/deps/update-2026-03-30");
  });

  it("appends -2 suffix when the first branch already exists", async () => {
    const createRef = jest.fn()
      .mockRejectedValueOnce(Object.assign(new Error("Reference already exists"), { status: 422 }))
      .mockResolvedValueOnce({});
    const octokit = makeOctokit({ git: { createRef } });
    const branch = await createUpdateBranch({ octokit, owner: "org", repo: "repo", date: "2026-03-30" });
    expect(branch).toBe("deps/update-2026-03-30-2");
    expect(createRef).toHaveBeenCalledTimes(2);
  });

  it("appends -3 suffix when the first two branches already exist", async () => {
    const err422 = Object.assign(new Error("Reference already exists"), { status: 422 });
    const createRef = jest.fn()
      .mockRejectedValueOnce(err422)
      .mockRejectedValueOnce(err422)
      .mockResolvedValueOnce({});
    const octokit = makeOctokit({ git: { createRef } });
    const branch = await createUpdateBranch({ octokit, owner: "org", repo: "repo", date: "2026-03-30" });
    expect(branch).toBe("deps/update-2026-03-30-3");
  });

  it("re-throws non-422 errors immediately", async () => {
    const createRef = jest.fn().mockRejectedValue(
      Object.assign(new Error("Forbidden"), { status: 403 })
    );
    const octokit = makeOctokit({ git: { createRef } });
    await expect(
      createUpdateBranch({ octokit, owner: "org", repo: "repo", date: "2026-03-30" })
    ).rejects.toThrow("Forbidden");
    expect(createRef).toHaveBeenCalledTimes(1);
  });

  it("throws after 10 consecutive 422 errors", async () => {
    const err422 = Object.assign(new Error("Reference already exists"), { status: 422 });
    const createRef = jest.fn().mockRejectedValue(err422);
    const octokit = makeOctokit({ git: { createRef } });
    await expect(
      createUpdateBranch({ octokit, owner: "org", repo: "repo", date: "2026-03-30" })
    ).rejects.toThrow(/after 10 attempts/);
  });

  it("skips createRef and returns the base name in dry-run mode", async () => {
    const octokit = makeOctokit();
    const branch = await createUpdateBranch({
      octokit,
      owner: "org",
      repo: "repo",
      date: "2026-03-30",
      dryRun: true,
    });
    expect(branch).toBe("deps/update-2026-03-30");
    expect(octokit.rest.git.createRef).not.toHaveBeenCalled();
  });
});

// ── openPullRequest ───────────────────────────────────────────────────────────

describe("openPullRequest", () => {
  it("creates a PR and returns its number and URL", async () => {
    const octokit = makeOctokit();
    const result = await openPullRequest({
      octokit,
      owner: "octokit",
      repo: "rest.js",
      branch: "deps/update-2026-03-30",
      report: makeReport(),
      hasSecurityFixes: false,
    });
    expect(result).toEqual({ prNumber: 42, prUrl: "https://github.com/octokit/rest.js/pull/42" });
  });

  it("targets the repo default branch as the PR base", async () => {
    const octokit = makeOctokit();
    await openPullRequest({
      octokit, owner: "org", repo: "repo",
      branch: "deps/update-2026-03-30",
      report: makeReport(), hasSecurityFixes: false,
    });
    const call = octokit.rest.pulls.create.mock.calls[0][0];
    expect(call.base).toBe(DEFAULT_BRANCH);
  });

  it("uses the update branch as the PR head", async () => {
    const octokit = makeOctokit();
    await openPullRequest({
      octokit, owner: "org", repo: "repo",
      branch: "deps/update-2026-03-30",
      report: makeReport(), hasSecurityFixes: false,
    });
    const call = octokit.rest.pulls.create.mock.calls[0][0];
    expect(call.head).toBe("deps/update-2026-03-30");
  });

  it("appends '(security)' to the PR title when hasSecurityFixes is true", async () => {
    const octokit = makeOctokit();
    await openPullRequest({
      octokit, owner: "org", repo: "repo",
      branch: "deps/update-2026-03-30",
      report: makeReport(), hasSecurityFixes: true,
    });
    const call = octokit.rest.pulls.create.mock.calls[0][0];
    expect(call.title).toContain("security");
  });

  it("adds the security label when hasSecurityFixes is true", async () => {
    const octokit = makeOctokit();
    await openPullRequest({
      octokit, owner: "org", repo: "repo",
      branch: "deps/update-2026-03-30",
      report: makeReport(), hasSecurityFixes: true,
    });
    expect(octokit.rest.issues.addLabels).toHaveBeenCalledTimes(1);
    const call = octokit.rest.issues.addLabels.mock.calls[0][0];
    expect(call.labels).toContain("security");
  });

  it("does not add the security label when hasSecurityFixes is false", async () => {
    const octokit = makeOctokit();
    await openPullRequest({
      octokit, owner: "org", repo: "repo",
      branch: "deps/update-2026-03-30",
      report: makeReport(), hasSecurityFixes: false,
    });
    expect(octokit.rest.issues.addLabels).not.toHaveBeenCalled();
  });

  it("returns null and skips API calls in dry-run mode", async () => {
    const octokit = makeOctokit();
    const result = await openPullRequest({
      octokit, owner: "org", repo: "repo",
      branch: "deps/update-2026-03-30",
      report: makeReport(), hasSecurityFixes: false,
      dryRun: true,
    });
    expect(result).toBeNull();
    expect(octokit.rest.pulls.create).not.toHaveBeenCalled();
  });

  it("passes draft:true to the API when draft is set", async () => {
    const octokit = makeOctokit();
    await openPullRequest({
      octokit, owner: "org", repo: "repo",
      branch: "deps/update-2026-03-30",
      report: makeReport(), hasSecurityFixes: false,
      draft: true,
    });
    const call = octokit.rest.pulls.create.mock.calls[0][0];
    expect(call.draft).toBe(true);
  });

  it("includes 'build failed' in the title when draft is set", async () => {
    const octokit = makeOctokit();
    await openPullRequest({
      octokit, owner: "org", repo: "repo",
      branch: "deps/update-2026-03-30",
      report: makeReport(), hasSecurityFixes: false,
      draft: true,
    });
    const call = octokit.rest.pulls.create.mock.calls[0][0];
    expect(call.title).toContain("build failed");
  });

  it("passes draft:false by default", async () => {
    const octokit = makeOctokit();
    await openPullRequest({
      octokit, owner: "org", repo: "repo",
      branch: "deps/update-2026-03-30",
      report: makeReport(), hasSecurityFixes: false,
    });
    const call = octokit.rest.pulls.create.mock.calls[0][0];
    expect(call.draft).toBe(false);
  });
});
