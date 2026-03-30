/**
 * @fileoverview Approval gate — polls a GitHub Issue for APPROVE/SKIP comments.
 * Major version bumps and high-risk updates require explicit owner approval
 * before the pipeline proceeds.
 */

import { logger } from "./logger.js";

/**
 * Polls a GitHub Issue for an approval or skip decision.
 * Resolves when the owner comments "APPROVE" or "SKIP", or when the timeout
 * elapses (which results in a skip).
 *
 * @param {object} params
 * @param {import('@octokit/rest').Octokit} params.octokit
 * @param {string} params.owner
 * @param {string} params.repo
 * @param {number} params.issueNumber
 * @param {number} params.timeoutHours
 * @returns {Promise<'approved' | 'skipped' | 'timeout'>}
 */
export async function waitForApproval({ octokit, owner, repo, issueNumber, timeoutHours }) {
  // TODO: implement polling loop
  logger.debug({ owner, repo, issueNumber }, "Approval gate — not yet implemented");
  return "skipped";
}
