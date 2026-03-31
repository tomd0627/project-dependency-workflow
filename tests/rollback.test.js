/**
 * @fileoverview Tests for the rollback module.
 */

import { jest } from "@jest/globals";
import { initiateRollback, pollCiStatus } from "../src/rollback.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Deadline already in the past — loop body never executes. */
const EXPIRED = Date.now() - 1;

/** Deadline far in the future — loop will run until a decision is reached. */
const FUTURE = Date.now() + 3_600_000;

const SHA = "abc123def456abc123def456abc123def456abc123";

/** Builds a check run object. */
const makeRun = (name, status, conclusion = null) => ({ name, status, conclusion });

/**
 * Builds a mock Octokit.
 * `checkPages` is an array of arrays; each call to listForRef returns the next page.
 */
const makeOctokit = ({ checkPages = [[]], createComment = jest.fn().mockResolvedValue({}), createIssue = jest.fn().mockResolvedValue({ data: { number: 99 } }) } = {}) => {
  let call = 0;
  return {
    rest: {
      checks: {
        listForRef: jest.fn().mockImplementation(() => {
          const check_runs = checkPages[Math.min(call++, checkPages.length - 1)];
          return Promise.resolve({ data: { check_runs } });
        }),
      },
      issues: {
        createComment,
        create: createIssue,
      },
    },
  };
};

const POLL_BASE = {
  owner: "org",
  repo: "repo",
  mergeCommitSha: SHA,
  pollIntervalMs: 0,
};

// ── pollCiStatus — timeout ────────────────────────────────────────────────────

describe("pollCiStatus — timeout", () => {
  it("returns 'timeout' when deadline is already past", async () => {
    const octokit = makeOctokit();
    const result = await pollCiStatus({ ...POLL_BASE, octokit, _deadlineMs: EXPIRED });
    expect(result).toBe("timeout");
    expect(octokit.rest.checks.listForRef).not.toHaveBeenCalled();
  });
});

// ── pollCiStatus — success ────────────────────────────────────────────────────

describe("pollCiStatus — success", () => {
  it("returns 'success' when all checks have passing conclusions", async () => {
    const octokit = makeOctokit({
      checkPages: [[makeRun("build", "completed", "success")]],
    });
    const result = await pollCiStatus({ ...POLL_BASE, octokit, _deadlineMs: FUTURE });
    expect(result).toBe("success");
  });

  it("treats 'neutral' conclusion as passing", async () => {
    const octokit = makeOctokit({
      checkPages: [[makeRun("lint", "completed", "neutral")]],
    });
    const result = await pollCiStatus({ ...POLL_BASE, octokit, _deadlineMs: FUTURE });
    expect(result).toBe("success");
  });

  it("treats 'skipped' conclusion as passing", async () => {
    const octokit = makeOctokit({
      checkPages: [[makeRun("optional", "completed", "skipped")]],
    });
    const result = await pollCiStatus({ ...POLL_BASE, octokit, _deadlineMs: FUTURE });
    expect(result).toBe("success");
  });

  it("returns 'success' when multiple checks all pass", async () => {
    const octokit = makeOctokit({
      checkPages: [[
        makeRun("build", "completed", "success"),
        makeRun("test", "completed", "success"),
        makeRun("lint", "completed", "neutral"),
      ]],
    });
    const result = await pollCiStatus({ ...POLL_BASE, octokit, _deadlineMs: FUTURE });
    expect(result).toBe("success");
  });

  it("polls again when no check runs are registered yet, then succeeds", async () => {
    const octokit = makeOctokit({
      checkPages: [
        [],
        [makeRun("build", "completed", "success")],
      ],
    });
    const result = await pollCiStatus({ ...POLL_BASE, octokit, _deadlineMs: FUTURE });
    expect(result).toBe("success");
    expect(octokit.rest.checks.listForRef).toHaveBeenCalledTimes(2);
  });

  it("polls again while checks are in progress, then succeeds", async () => {
    const octokit = makeOctokit({
      checkPages: [
        [makeRun("build", "in_progress", null)],
        [makeRun("build", "completed", "success")],
      ],
    });
    const result = await pollCiStatus({ ...POLL_BASE, octokit, _deadlineMs: FUTURE });
    expect(result).toBe("success");
    expect(octokit.rest.checks.listForRef).toHaveBeenCalledTimes(2);
  });

  it("passes the correct owner, repo, and ref to listForRef", async () => {
    const octokit = makeOctokit({
      checkPages: [[makeRun("build", "completed", "success")]],
    });
    await pollCiStatus({ ...POLL_BASE, octokit, _deadlineMs: FUTURE });
    expect(octokit.rest.checks.listForRef).toHaveBeenCalledWith({
      owner: "org",
      repo: "repo",
      ref: SHA,
    });
  });
});

// ── pollCiStatus — failure ────────────────────────────────────────────────────

describe("pollCiStatus — failure", () => {
  it("returns 'failure' when any check has a failing conclusion", async () => {
    const octokit = makeOctokit({
      checkPages: [[makeRun("test", "completed", "failure")]],
    });
    const result = await pollCiStatus({ ...POLL_BASE, octokit, _deadlineMs: FUTURE });
    expect(result).toBe("failure");
  });

  it("returns 'failure' for 'timed_out' conclusion", async () => {
    const octokit = makeOctokit({
      checkPages: [[makeRun("test", "completed", "timed_out")]],
    });
    const result = await pollCiStatus({ ...POLL_BASE, octokit, _deadlineMs: FUTURE });
    expect(result).toBe("failure");
  });

  it("returns 'failure' even when some checks pass", async () => {
    const octokit = makeOctokit({
      checkPages: [[
        makeRun("build", "completed", "success"),
        makeRun("test", "completed", "failure"),
      ]],
    });
    const result = await pollCiStatus({ ...POLL_BASE, octokit, _deadlineMs: FUTURE });
    expect(result).toBe("failure");
  });
});

// ── initiateRollback — dry-run ────────────────────────────────────────────────

describe("initiateRollback — dry-run", () => {
  it("returns without calling any API in dry-run mode", async () => {
    const createComment = jest.fn();
    const createIssue = jest.fn();
    const octokit = makeOctokit({ createComment, createIssue });

    await initiateRollback({
      octokit, owner: "org", repo: "repo",
      prNumber: 42, mergeCommitSha: SHA, dryRun: true,
    });

    expect(createComment).not.toHaveBeenCalled();
    expect(createIssue).not.toHaveBeenCalled();
  });
});

// ── initiateRollback — live ───────────────────────────────────────────────────

describe("initiateRollback — live", () => {
  const PARAMS = {
    owner: "org", repo: "repo", prNumber: 42, mergeCommitSha: SHA,
  };

  it("posts a comment on the failing PR", async () => {
    const createComment = jest.fn().mockResolvedValue({});
    const octokit = makeOctokit({ createComment });

    await initiateRollback({ ...PARAMS, octokit });

    expect(createComment).toHaveBeenCalledTimes(1);
    expect(createComment.mock.calls[0][0]).toMatchObject({
      owner: "org",
      repo: "repo",
      issue_number: 42,
    });
  });

  it("comment body contains the git revert command", async () => {
    const createComment = jest.fn().mockResolvedValue({});
    const octokit = makeOctokit({ createComment });

    await initiateRollback({ ...PARAMS, octokit });

    const { body } = createComment.mock.calls[0][0];
    expect(body).toContain("git revert");
    expect(body).toContain(SHA);
  });

  it("comment body references the failing PR number", async () => {
    const createComment = jest.fn().mockResolvedValue({});
    const octokit = makeOctokit({ createComment });

    await initiateRollback({ ...PARAMS, octokit });

    const { body } = createComment.mock.calls[0][0];
    expect(body).toContain("#42");
  });

  it("opens a tracking issue after posting the comment", async () => {
    const createIssue = jest.fn().mockResolvedValue({ data: { number: 99 } });
    const octokit = makeOctokit({ createIssue });

    await initiateRollback({ ...PARAMS, octokit });

    expect(createIssue).toHaveBeenCalledTimes(1);
    expect(createIssue.mock.calls[0][0]).toMatchObject({
      owner: "org",
      repo: "repo",
    });
  });

  it("tracking issue title references the failing PR number", async () => {
    const createIssue = jest.fn().mockResolvedValue({ data: { number: 99 } });
    const octokit = makeOctokit({ createIssue });

    await initiateRollback({ ...PARAMS, octokit });

    const { title } = createIssue.mock.calls[0][0];
    expect(title).toContain("42");
  });

  it("tracking issue includes the 'automated' label", async () => {
    const createIssue = jest.fn().mockResolvedValue({ data: { number: 99 } });
    const octokit = makeOctokit({ createIssue });

    await initiateRollback({ ...PARAMS, octokit });

    const { labels } = createIssue.mock.calls[0][0];
    expect(labels).toContain("automated");
  });
});
