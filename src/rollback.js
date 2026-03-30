/**
 * @fileoverview Post-merge CI monitoring and rollback triggering.
 * Polls CI status checks after a PR merges, and opens a revert PR or
 * posts a revert command comment if checks fail.
 */

import { logger } from "./logger.js";
import { CI_POLL } from "./constants.js";

/**
 * Polls CI status checks for a merged pull request.
 * Resolves when all checks pass, or when the polling window closes.
 *
 * @param {object} params
 * @param {import('@octokit/rest').Octokit} params.octokit
 * @param {string} params.owner
 * @param {string} params.repo
 * @param {string} params.mergeCommitSha
 * @returns {Promise<'success' | 'failure' | 'timeout'>}
 */
export async function pollCiStatus({ octokit, owner, repo, mergeCommitSha }) {
  // TODO: implement CI polling loop
  logger.debug({ owner, repo, mergeCommitSha }, "CI polling — not yet implemented");
  return "timeout";
}

/**
 * Initiates a rollback by opening a revert PR or posting a revert comment.
 *
 * @param {object} params
 * @param {import('@octokit/rest').Octokit} params.octokit
 * @param {string} params.owner
 * @param {string} params.repo
 * @param {number} params.prNumber - PR number that caused the failure
 * @param {string} params.mergeCommitSha
 * @returns {Promise<void>}
 */
export async function initiateRollback({ octokit, owner, repo, prNumber, mergeCommitSha }) {
  // TODO: implement revert PR + comment
  logger.debug({ owner, repo, prNumber }, "Rollback — not yet implemented");
}
