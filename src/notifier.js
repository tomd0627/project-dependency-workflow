/**
 * @fileoverview GitHub Issue creation and webhook delivery for pipeline reports.
 */

import { logger } from "./logger.js";

/**
 * Creates a structured GitHub Issue containing the full dependency report.
 *
 * @param {object} params
 * @param {import('@octokit/rest').Octokit} params.octokit
 * @param {string} params.owner
 * @param {string} params.repo
 * @param {object} params.report - Aggregated pipeline report for this repo
 * @param {boolean} params.dryRun
 * @returns {Promise<{ issueNumber: number; issueUrl: string } | null>}
 */
export async function createReportIssue({ octokit, owner, repo, report, dryRun }) {
  // TODO: implement issue body rendering + Octokit issue creation
  logger.debug({ owner, repo, dryRun }, "Issue creation — not yet implemented");
  return null;
}

/**
 * Delivers a notification payload to a Discord webhook or ntfy.sh topic.
 *
 * @param {object} params
 * @param {string | undefined} params.discordWebhook
 * @param {string | undefined} params.ntfyTopic
 * @param {string} params.message
 * @returns {Promise<void>}
 */
export async function sendWebhookNotification({ discordWebhook, ntfyTopic, message }) {
  // TODO: implement webhook delivery
  logger.debug("Webhook notification — not yet implemented");
}
