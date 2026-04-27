/**
 * @fileoverview Approval watcher — finds dep-bot issues that have been approved
 * and triggers the main bot pipeline for each affected repository.
 *
 * Designed to run on a frequent schedule (e.g. every 30 minutes) so that the
 * user's approve-to-PR flow is automatic:
 *   1. Run bot → issues created
 *   2. Comment APPROVE on issue
 *   3. Watcher detects approval → runs bot for that repo → PR created
 */

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GATE, NOTIFIER, PR } from "./constants.js";
import { createOctokitClient } from "./discovery.js";
import { logger } from "./logger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_SCRIPT = join(__dirname, "index.js");

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Returns true if an open dep-bot PR already exists for this repo, which
 * means the approval has already been processed and we should skip it.
 *
 * @param {import('@octokit/rest').Octokit} octokit
 * @param {string} owner
 * @param {string} repo
 * @returns {Promise<boolean>}
 */
async function hasOpenDepBotPr(octokit, owner, repo) {
  const { data: prs } = await octokit.rest.pulls.list({
    owner,
    repo,
    state: "open",
    per_page: 30,
  });
  return prs.some((pr) => pr.head.ref.startsWith(PR.BRANCH_PREFIX));
}

/**
 * Searches for dep-bot issues that have been approved but not yet turned into
 * a PR. Returns the unique list of "owner/repo" strings to process.
 *
 * @param {import('@octokit/rest').Octokit} octokit
 * @returns {Promise<string[]>}
 */
async function findApprovedRepos(octokit) {
  const {
    data: { login: me },
  } = await octokit.rest.users.getAuthenticated();

  // Omit author: — issues may be created by github-actions[bot] or the PAT
  // user depending on which secret is in use. Scope to the authenticated
  // user's repos with user: instead, then filter by title prefix in code.
  const query = `is:issue label:${PR.LABELS[0]} label:${PR.LABELS[1]} user:${me}`;
  logger.info({ me, query }, "Searching for dep-bot issues");

  const { data: searchResult } = await octokit.rest.search.issuesAndPullRequests({
    q: query,
    sort: "updated",
    order: "desc",
    per_page: 100,
  });

  logger.info({ totalCount: searchResult.total_count, returned: searchResult.items.length }, "Search complete");

  const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  const approved = new Set();

  for (const issue of searchResult.items) {
    // Skip non-dep-bot issues that happen to share the labels.
    if (!issue.title.startsWith(NOTIFIER.ISSUE_TITLE_PREFIX)) continue;

    // Only consider issues updated within the approval window.
    if (issue.updated_at < cutoff) continue;

    // Extract "owner/repo" from the repository_url field.
    const repoMatch = issue.repository_url.match(/repos\/([^/]+\/[^/]+)$/);
    if (!repoMatch) continue;
    const fullName = repoMatch[1];
    const [issueOwner, repo] = fullName.split("/");

    // Check for an APPROVE comment on this issue.
    const { data: comments } = await octokit.rest.issues.listComments({
      owner: issueOwner,
      repo,
      issue_number: issue.number,
    });

    const isApproved = comments.some((c) =>
      (c.body ?? "").trim().toUpperCase().includes(GATE.APPROVE_KEYWORD)
    );

    if (!isApproved) {
      logger.info({ repo: fullName, issue: issue.number, commentCount: comments.length }, "Issue has no APPROVE comment — skipping");
      continue;
    }

    // Skip if a dep-bot PR is already open — approval was already processed.
    const alreadyHasPr = await hasOpenDepBotPr(octokit, issueOwner, repo);
    if (alreadyHasPr) {
      logger.info({ repo: fullName }, "Approved issue found but dep-bot PR already exists — skipping");
      continue;
    }

    approved.add(fullName);
  }

  return [...approved];
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    logger.fatal("GITHUB_TOKEN environment variable is required");
    process.exit(1);
  }

  const octokit = createOctokitClient(token);

  logger.info("Approval watcher starting — scanning for approved dep-bot issues");

  const approvedRepos = await findApprovedRepos(octokit);

  if (approvedRepos.length === 0) {
    logger.info("No approved repos awaiting PRs — nothing to do");
    return;
  }

  logger.info({ repos: approvedRepos, count: approvedRepos.length }, "Approved repos found — triggering pipeline");

  let failures = 0;

  for (const repo of approvedRepos) {
    logger.info({ repo }, "Running pipeline for approved repo");

    const result = spawnSync("node", [INDEX_SCRIPT], {
      env: { ...process.env, TARGET_REPO: repo },
      stdio: "inherit",
    });

    if (result.status !== 0) {
      logger.error({ repo, exitCode: result.status }, "Pipeline run failed for repo");
      failures++;
    } else {
      logger.info({ repo }, "Pipeline run complete");
    }
  }

  if (failures > 0) {
    logger.warn({ failures }, "Some pipeline runs failed — check logs above");
    process.exit(1);
  }
}

main().catch((err) => {
  logger.fatal({ error: err.message, stack: err.stack }, "Approval watcher encountered an unhandled error");
  process.exit(1);
});
