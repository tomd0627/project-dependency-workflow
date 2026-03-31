/**
 * @fileoverview Approval gate — polls a GitHub Issue for APPROVE/SKIP comments.
 * Major version bumps and high-risk updates require explicit owner approval
 * before the pipeline proceeds.
 */

import { DRY_RUN_PREFIX, GATE } from "./constants.js";
import { logger } from "./logger.js";

/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Polls a GitHub Issue for an approval or skip decision.
 * Resolves when the owner comments "APPROVE" or "SKIP", or when the timeout
 * elapses.
 *
 * @param {object} params
 * @param {import('@octokit/rest').Octokit} params.octokit
 * @param {string} params.owner
 * @param {string} params.repo
 * @param {number} params.issueNumber
 * @param {number} params.timeoutHours
 * @param {number} [params.pollIntervalMs] - Override poll interval (default: GATE.POLL_INTERVAL_MS)
 * @param {boolean} [params.dryRun]
 * @param {number} [params._deadlineMs] - Override deadline epoch ms (for testing only)
 * @returns {Promise<'approved' | 'skipped' | 'timeout'>}
 */
export async function waitForApproval({
  octokit,
  owner,
  repo,
  issueNumber,
  timeoutHours,
  pollIntervalMs = GATE.POLL_INTERVAL_MS,
  dryRun = false,
  _deadlineMs,
}) {
  if (dryRun) {
    logger.info({ issueNumber }, `${DRY_RUN_PREFIX} Skipping approval gate`);
    return "skipped";
  }

  const deadline = _deadlineMs ?? (Date.now() + timeoutHours * 3_600_000);
  logger.info(
    { owner, repo, issueNumber, timeoutHours },
    "Approval gate open — waiting for decision"
  );

  while (Date.now() < deadline) {
    const { data: comments } = await octokit.rest.issues.listComments({
      owner,
      repo,
      issue_number: issueNumber,
    });

    for (const comment of comments) {
      const body = (comment.body ?? "").trim().toUpperCase();
      if (body.includes(GATE.APPROVE_KEYWORD)) {
        logger.info({ issueNumber, author: comment.user?.login }, "Gate approved");
        return "approved";
      }
      if (body.includes(GATE.SKIP_KEYWORD)) {
        logger.info({ issueNumber, author: comment.user?.login }, "Gate skipped");
        return "skipped";
      }
    }

    logger.debug(
      { issueNumber, remainingMs: deadline - Date.now() },
      "No decision yet — polling again"
    );
    await sleep(pollIntervalMs);
  }

  logger.warn({ issueNumber, timeoutHours }, "Approval gate timed out");
  return "timeout";
}
