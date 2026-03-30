/**
 * @fileoverview GitHub repository discovery.
 * Enumerates all personal repositories for the configured GitHub user,
 * respecting excluded_repos and surfacing priority_repos first.
 *
 * Rate-limit strategy:
 *  - @octokit/plugin-throttling handles primary and secondary rate limits
 *    automatically, backing off and retrying transparent to callers.
 *  - @octokit/plugin-retry handles transient 5xx errors with exponential backoff.
 *  - Every API response logs the remaining rate-limit budget for observability.
 */

import { retry } from "@octokit/plugin-retry";
import { throttling } from "@octokit/plugin-throttling";
import { Octokit } from "@octokit/rest";
import { API } from "./constants.js";
import { logger } from "./logger.js";

/** @typedef {import('@octokit/rest').RestEndpointMethodTypes['repos']['listForAuthenticatedUser']['response']['data'][number]} GitHubRepo */

const OctokitWithPlugins = Octokit.plugin(throttling, retry);

/**
 * Builds an Octokit client with rate-limit throttling, automatic retry on
 * transient errors, and per-response rate-limit header logging.
 *
 * @param {string} token - GitHub personal access token or Actions GITHUB_TOKEN
 * @returns {InstanceType<typeof OctokitWithPlugins>}
 */
export function createOctokitClient(token) {
  const octokit = new OctokitWithPlugins({
    auth: token,
    throttle: {
      onRateLimit(retryAfter, options, _octokit, retryCount) {
        logger.warn(
          { retryAfter, url: options.url, retryCount },
          "GitHub primary rate limit hit — retrying after backoff"
        );
        return retryCount < API.MAX_RETRIES;
      },
      onSecondaryRateLimit(retryAfter, options, _octokit, retryCount) {
        logger.warn(
          { retryAfter, url: options.url, retryCount },
          "GitHub secondary rate limit hit — retrying after backoff"
        );
        return retryCount < API.MAX_RETRIES;
      },
    },
    retry: {
      doNotRetry: ["429"],
    },
  });

  octokit.hook.after("request", (response, requestOptions) => {
    const remaining = response.headers["x-ratelimit-remaining"];
    const limit = response.headers["x-ratelimit-limit"];
    const resetEpoch = response.headers["x-ratelimit-reset"];

    if (remaining !== undefined) {
      const resetAt = resetEpoch ? new Date(Number(resetEpoch) * 1000).toISOString() : undefined;
      logger.debug(
        { remaining: Number(remaining), limit: Number(limit), resetAt, url: requestOptions.url },
        "GitHub rate limit status"
      );
    }
  });

  return octokit;
}

/**
 * Fetches all repositories owned by the authenticated user.
 * Uses Octokit's built-in paginate helper to transparently handle
 * cursor-based pagination — callers always receive the full list.
 *
 * @param {InstanceType<typeof OctokitWithPlugins>} octokit - Authenticated client
 * @returns {Promise<GitHubRepo[]>}
 */
export async function fetchAllRepositories(octokit) {
  logger.info("Fetching repository list from GitHub");

  const repos = await octokit.paginate(octokit.rest.repos.listForAuthenticatedUser, {
    visibility: "all",
    affiliation: "owner",
    per_page: 100,
  });

  logger.info({ count: repos.length }, "Repository list fetched");
  return repos;
}

/**
 * Filters and orders repositories according to bot configuration.
 *
 * Ordering rules (applied in sequence):
 *  1. Remove any repo in excludedRepos.
 *  2. If targetRepo is set, keep only that repo (matched by name or full_name).
 *  3. Surface priorityRepos at the front; remaining repos follow in their
 *     original API order.
 *
 * @param {GitHubRepo[]} repos - Raw list from GitHub API
 * @param {string[]} excludedRepos - Repo names to skip
 * @param {string[]} priorityRepos - Repo names to process first
 * @param {string | undefined} targetRepo - Optional single-repo override (name or owner/name)
 * @returns {GitHubRepo[]}
 */
export function filterAndOrderRepositories(repos, excludedRepos, priorityRepos, targetRepo) {
  let filtered = repos.filter((repo) => !excludedRepos.includes(repo.name));

  if (targetRepo) {
    filtered = filtered.filter(
      (repo) => repo.name === targetRepo || repo.full_name === targetRepo
    );
  }

  const priority = filtered.filter((repo) => priorityRepos.includes(repo.name));
  const rest = filtered.filter((repo) => !priorityRepos.includes(repo.name));

  return [...priority, ...rest];
}

/**
 * Discovers all eligible repositories for a pipeline run.
 * Composes client creation, API pagination, and filtering into a single call.
 *
 * @param {object} params
 * @param {string} params.token - GitHub token
 * @param {string[]} params.excludedRepos - Repos to skip
 * @param {string[]} params.priorityRepos - Repos to process first
 * @param {string | undefined} params.targetRepo - Single repo override (name or owner/name)
 * @param {InstanceType<typeof OctokitWithPlugins> | undefined} [params._octokitOverride]
 *   - Inject a pre-built client (test use only — omit in production)
 * @returns {Promise<GitHubRepo[]>}
 */
export async function discoverRepositories({
  token,
  excludedRepos,
  priorityRepos,
  targetRepo,
  _octokitOverride,
}) {
  const octokit = _octokitOverride ?? createOctokitClient(token);
  const all = await fetchAllRepositories(octokit);
  const eligible = filterAndOrderRepositories(all, excludedRepos, priorityRepos, targetRepo);

  logger.info(
    { eligible: eligible.length, excluded: all.length - eligible.length },
    "Repository discovery complete"
  );

  return eligible;
}
