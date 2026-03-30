/**
 * @fileoverview Pipeline orchestrator — sequences all stages.
 * This file contains ONLY pipeline sequencing logic. All business logic
 * lives in the individual stage modules.
 */

import { readFile } from "node:fs/promises";
import { logger } from "./logger.js";
import { STAGE, DRY_RUN_PREFIX } from "./constants.js";
import { discoverRepositories } from "./discovery.js";

/**
 * Loads and validates the bot configuration file.
 *
 * @returns {Promise<import('../bot.config.json')>}
 */
async function loadConfig() {
  const raw = await readFile(new URL("../bot.config.json", import.meta.url), "utf8");
  return JSON.parse(raw);
}

/**
 * Runs the full dependency management pipeline for all eligible repositories.
 *
 * @returns {Promise<void>}
 */
async function run() {
  const config = await loadConfig();
  const token = process.env.GITHUB_TOKEN;
  const dryRun = process.env.DRY_RUN === "true" || config.dry_run;

  if (!token) {
    logger.fatal("GITHUB_TOKEN environment variable is required");
    process.exit(1);
  }

  if (dryRun) {
    logger.info(DRY_RUN_PREFIX + " Dry run mode enabled — no changes will be applied");
  }

  logger.info({ stage: STAGE.DISCOVER }, "Pipeline starting");

  const repos = await discoverRepositories({
    token,
    excludedRepos: config.excluded_repos,
    priorityRepos: config.priority_repos,
    targetRepo: process.env.TARGET_REPO || undefined,
  });

  logger.info({ repoCount: repos.length, stage: STAGE.DISCOVER }, "Discovery complete");

  // Remaining stages (SCAN → ROLLBACK) will be wired here as each module is implemented.
  // Each stage will be called sequentially per-repo with full error handling.
  for (const repo of repos) {
    logger.info({ repo: repo.full_name }, "Processing repository");
    // TODO: wire remaining pipeline stages
  }

  logger.info("Pipeline complete");
}

run().catch((error) => {
  logger.fatal({ error: error.message, stack: error.stack }, "Pipeline failed with unhandled error");
  process.exit(1);
});
