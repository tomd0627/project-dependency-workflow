/**
 * @fileoverview Tests for the gate module.
 */

import { jest } from "@jest/globals";
import { waitForApproval } from "../src/gate.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Deadline already in the past — loop body never executes. */
const EXPIRED = Date.now() - 1;

/** Deadline far in the future — loop will run until a decision is returned. */
const FUTURE = Date.now() + 3_600_000;

/** Builds a mock comment object. */
const makeComment = (body, login = "owner") => ({
  body,
  user: { login },
});

/**
 * Builds a minimal mock Octokit with listComments returning the given pages
 * of comments in sequence.
 * @param {...Array} pages - Each call to listComments returns the next page.
 */
const makeOctokit = (...pages) => {
  let call = 0;
  return {
    rest: {
      issues: {
        listComments: jest.fn().mockImplementation(() => {
          const data = pages[Math.min(call++, pages.length - 1)];
          return Promise.resolve({ data });
        }),
      },
    },
  };
};

const BASE = { owner: "org", repo: "repo", issueNumber: 1, timeoutHours: 48, pollIntervalMs: 0 };

// ── dry-run ───────────────────────────────────────────────────────────────────

describe("waitForApproval — dry-run", () => {
  it("returns 'skipped' immediately without calling the API", async () => {
    const octokit = makeOctokit([]);
    const result = await waitForApproval({ ...BASE, octokit, dryRun: true });
    expect(result).toBe("skipped");
    expect(octokit.rest.issues.listComments).not.toHaveBeenCalled();
  });
});

// ── timeout ───────────────────────────────────────────────────────────────────

describe("waitForApproval — timeout", () => {
  it("returns 'timeout' when deadline is already past", async () => {
    const octokit = makeOctokit([]);
    const result = await waitForApproval({ ...BASE, octokit, _deadlineMs: EXPIRED });
    expect(result).toBe("timeout");
    expect(octokit.rest.issues.listComments).not.toHaveBeenCalled();
  });
});

// ── approve ───────────────────────────────────────────────────────────────────

describe("waitForApproval — approve", () => {
  it("returns 'approved' when a comment contains APPROVE", async () => {
    const octokit = makeOctokit([makeComment("APPROVE")]);
    const result = await waitForApproval({ ...BASE, octokit, _deadlineMs: FUTURE });
    expect(result).toBe("approved");
  });

  it("returns 'approved' when APPROVE appears within a longer comment body", async () => {
    const octokit = makeOctokit([makeComment("Looks good — APPROVE the update.")]);
    const result = await waitForApproval({ ...BASE, octokit, _deadlineMs: FUTURE });
    expect(result).toBe("approved");
  });

  it("returns 'approved' regardless of case in the comment", async () => {
    const octokit = makeOctokit([makeComment("approve")]);
    const result = await waitForApproval({ ...BASE, octokit, _deadlineMs: FUTURE });
    expect(result).toBe("approved");
  });

  it("passes the correct owner, repo, and issue_number to listComments", async () => {
    const octokit = makeOctokit([makeComment("APPROVE")]);
    await waitForApproval({ ...BASE, octokit, _deadlineMs: FUTURE });
    expect(octokit.rest.issues.listComments).toHaveBeenCalledWith({
      owner: "org",
      repo: "repo",
      issue_number: 1,
    });
  });

  it("returns 'approved' after finding the keyword on the second poll", async () => {
    // First call: no decision. Second call: APPROVE.
    const octokit = makeOctokit([], [makeComment("APPROVE")]);
    const result = await waitForApproval({ ...BASE, octokit, _deadlineMs: FUTURE });
    expect(result).toBe("approved");
    expect(octokit.rest.issues.listComments).toHaveBeenCalledTimes(2);
  });
});

// ── skip ──────────────────────────────────────────────────────────────────────

describe("waitForApproval — skip", () => {
  it("returns 'skipped' when a comment contains SKIP", async () => {
    const octokit = makeOctokit([makeComment("SKIP")]);
    const result = await waitForApproval({ ...BASE, octokit, _deadlineMs: FUTURE });
    expect(result).toBe("skipped");
  });

  it("returns 'skipped' when SKIP appears within a longer comment body", async () => {
    const octokit = makeOctokit([makeComment("Please SKIP this update for now.")]);
    const result = await waitForApproval({ ...BASE, octokit, _deadlineMs: FUTURE });
    expect(result).toBe("skipped");
  });

  it("returns 'skipped' regardless of case", async () => {
    const octokit = makeOctokit([makeComment("skip")]);
    const result = await waitForApproval({ ...BASE, octokit, _deadlineMs: FUTURE });
    expect(result).toBe("skipped");
  });
});

// ── GitHub Actions one-shot ───────────────────────────────────────────────────

describe("waitForApproval — GitHub Actions one-shot", () => {
  const originalEnv = process.env.GITHUB_ACTIONS;

  beforeEach(() => {
    process.env.GITHUB_ACTIONS = "true";
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.GITHUB_ACTIONS;
    } else {
      process.env.GITHUB_ACTIONS = originalEnv;
    }
  });

  it("returns 'approved' immediately when an APPROVE comment already exists", async () => {
    const octokit = makeOctokit([makeComment("APPROVE")]);
    const result = await waitForApproval({ ...BASE, octokit });
    expect(result).toBe("approved");
    expect(octokit.rest.issues.listComments).toHaveBeenCalledTimes(1);
  });

  it("returns 'skipped' immediately when a SKIP comment already exists", async () => {
    const octokit = makeOctokit([makeComment("SKIP")]);
    const result = await waitForApproval({ ...BASE, octokit });
    expect(result).toBe("skipped");
  });

  it("returns 'timeout' when no approval comment is found (re-trigger needed)", async () => {
    const octokit = makeOctokit([makeComment("lgtm")]);
    const result = await waitForApproval({ ...BASE, octokit });
    expect(result).toBe("timeout");
    expect(octokit.rest.issues.listComments).toHaveBeenCalledTimes(1);
  });

  it("does not enter the polling loop (only one listComments call)", async () => {
    const octokit = makeOctokit([], [makeComment("APPROVE")]);
    const result = await waitForApproval({ ...BASE, octokit });
    // No second poll — result is timeout because first page had no decision
    expect(result).toBe("timeout");
    expect(octokit.rest.issues.listComments).toHaveBeenCalledTimes(1);
  });

  it("is case-insensitive (approve lowercase)", async () => {
    const octokit = makeOctokit([makeComment("approve")]);
    const result = await waitForApproval({ ...BASE, octokit });
    expect(result).toBe("approved");
  });
});

// ── edge cases ────────────────────────────────────────────────────────────────

describe("waitForApproval — edge cases", () => {
  it("ignores comments with empty body", async () => {
    const octokit = makeOctokit([makeComment(null), makeComment("APPROVE")]);
    const result = await waitForApproval({ ...BASE, octokit, _deadlineMs: FUTURE });
    expect(result).toBe("approved");
  });

  it("prefers APPROVE over SKIP when both appear in the same comment list", async () => {
    // Iteration order: APPROVE comment comes first.
    const octokit = makeOctokit([makeComment("APPROVE"), makeComment("SKIP")]);
    const result = await waitForApproval({ ...BASE, octokit, _deadlineMs: FUTURE });
    expect(result).toBe("approved");
  });
});
