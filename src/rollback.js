/**
 * @fileoverview Post-merge CI monitoring and rollback triggering.
 * Polls CI status checks after a PR merges, and posts a revert comment
 * plus opens a tracking issue if checks fail.
 */

import { CI_POLL, DRY_RUN_PREFIX } from "./constants.js";
import { logger } from "./logger.js";

/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** CI conclusions that are considered passing. */
const PASSING_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);

/**
 * Polls CI check-runs for a merged commit until all complete, the deadline
 * passes, or a failure is detected.
 *
 * @param {object} params
 * @param {import('@octokit/rest').Octokit} params.octokit
 * @param {string} params.owner
 * @param {string} params.repo
 * @param {string} params.mergeCommitSha
 * @param {number} [params.pollIntervalMs] - Override poll interval (default: CI_POLL.INTERVAL_MS)
 * @param {number} [params.maxDurationMs] - Override max duration (default: CI_POLL.MAX_DURATION_MS)
 * @param {number} [params._deadlineMs] - Override deadline epoch ms (for testing only)
 * @returns {Promise<'success' | 'failure' | 'timeout'>}
 */
export async function pollCiStatus({
  octokit,
  owner,
  repo,
  mergeCommitSha,
  pollIntervalMs = CI_POLL.INTERVAL_MS,
  maxDurationMs = CI_POLL.MAX_DURATION_MS,
  _deadlineMs,
}) {
  const deadline = _deadlineMs ?? (Date.now() + maxDurationMs);
  logger.info({ owner, repo, mergeCommitSha }, "CI polling started");

  while (Date.now() < deadline) {
    const { data } = await octokit.rest.checks.listForRef({
      owner,
      repo,
      ref: mergeCommitSha,
    });

    const runs = data.check_runs ?? [];

    if (runs.length === 0) {
      logger.debug({ mergeCommitSha }, "No check runs registered yet");
      await sleep(pollIntervalMs);
      continue;
    }

    const pending = runs.filter((r) => r.status !== "completed");
    if (pending.length > 0) {
      logger.debug({ pending: pending.map((r) => r.name) }, "Checks still in progress");
      await sleep(pollIntervalMs);
      continue;
    }

    // All runs completed — evaluate conclusions.
    const failed = runs.filter((r) => !PASSING_CONCLUSIONS.has(r.conclusion));
    if (failed.length > 0) {
      logger.warn({ failed: failed.map((r) => r.name) }, "CI checks failed");
      return "failure";
    }

    logger.info({ mergeCommitSha }, "All CI checks passed");
    return "success";
  }

  logger.warn({ mergeCommitSha, maxDurationMs }, "CI polling timed out");
  return "timeout";
}

/**
 * Initiates a rollback by posting a revert comment on the original PR
 * and opening a tracking issue.
 *
 * @param {object} params
 * @param {import('@octokit/rest').Octokit} params.octokit
 * @param {string} params.owner
 * @param {string} params.repo
 * @param {number} params.prNumber - PR number that caused the failure
 * @param {string} params.mergeCommitSha
 * @param {boolean} [params.dryRun]
 * @returns {Promise<void>}
 */
export async function initiateRollback({
  octokit,
  owner,
  repo,
  prNumber,
  mergeCommitSha,
  dryRun = false,
}) {
  const shortSha = mergeCommitSha.slice(0, 7);

  const revertComment =
    `## ⚠️ Automated Rollback Request\n\n` +
    `CI checks failed after merging PR #${prNumber} (commit \`${shortSha}\`).\n\n` +
    `**Recommended action:** revert this merge.\n\n` +
    `\`\`\`bash\n` +
    `git revert -m 1 ${mergeCommitSha}\n` +
    `git push origin HEAD\n` +
    `\`\`\`\n\n` +
    `_This comment was posted automatically by Dep Bot._`;

  if (dryRun) {
    logger.info(
      { prNumber },
      `${DRY_RUN_PREFIX} Would post rollback comment on PR #${prNumber}`
    );
    return;
  }

  // 1. Comment on the failing PR with revert instructions.
  await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: prNumber,
    body: revertComment,
  });
  logger.info({ prNumber }, "Rollback comment posted");

  // 2. Open a tracking issue so the failure is visible on the board.
  const issueTitle = `[Dep Bot] Rollback required — PR #${prNumber} broke CI`;
  const issueBody =
    `Automated dependency update PR #${prNumber} caused CI failures after merging.\n\n` +
    `**Merge commit:** \`${mergeCommitSha}\`\n\n` +
    `See PR #${prNumber} for revert instructions.`;

  const { data: issue } = await octokit.rest.issues.create({
    owner,
    repo,
    title: issueTitle,
    body: issueBody,
    labels: ["bug", "automated"],
  });

  logger.info({ prNumber, issueNumber: issue.number }, "Rollback tracking issue created");
}
