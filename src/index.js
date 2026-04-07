/**
 * @fileoverview Pipeline orchestrator — sequences all stages end to end.
 * Business logic lives exclusively in the individual stage modules; this file
 * is responsible only for wiring them together and managing per-repo state.
 *
 * Pipeline stages per repository:
 *   DISCOVER → SCAN → AUDIT → ANALYZE → NOTIFY → GATE →
 *   BRANCH → UPDATE → QA → AUTOFIX → PUSH
 *
 * Post-merge monitoring (ROLLBACK) runs asynchronously after a PR merges and
 * is triggered by a separate invocation or webhook — not inline here.
 */

import { exec as cpExec } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import Anthropic from "@anthropic-ai/sdk";
import { analyzePackageUpdate } from "./analyzer.js";
import { fetchAdvisories } from "./auditor.js";
import { autofixRegressions } from "./autofixer.js";
import {
  CACHE,
  DRY_RUN_PREFIX,
  GATE,
  RECOMMENDATION,
  RISK_THRESHOLD,
  STAGE,
} from "./constants.js";
import { createOctokitClient, discoverRepositories } from "./discovery.js";
import { waitForApproval } from "./gate.js";
import { logger } from "./logger.js";
import { createReportIssue, sendWebhookNotification } from "./notifier.js";
import { createUpdateBranch, deleteUpdateBranch, openPullRequest } from "./publisher.js";
import { detectBuildCommand, detectTestCommand, runTestSuite } from "./qa.js";
import { scanRepository } from "./scanner.js";
import { applyUpdates } from "./updater.js";

const exec = promisify(cpExec);

// ── Config ─────────────────────────────────────────────────────────────────────

/**
 * Loads and validates the bot configuration file.
 *
 * @returns {Promise<object>}
 */
async function loadConfig() {
  const configUrl = new URL("../bot.config.json", import.meta.url);
  const exampleUrl = new URL("../bot.config.example.json", import.meta.url);
  try {
    return JSON.parse(await readFile(configUrl, "utf8"));
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
    logger.warn("bot.config.json not found, falling back to bot.config.example.json");
    return JSON.parse(await readFile(exampleUrl, "utf8"));
  }
}

// ── Gate decision ──────────────────────────────────────────────────────────────

/**
 * Returns true if any update in the set requires manual approval before
 * the pipeline proceeds to branch/update/push.
 *
 * Rules (evaluated in order):
 *  1. Any major bump when auto_approve_major is false → gate.
 *  2. Any risk score above the configured threshold → gate.
 *
 * @param {import('./analyzer.js').RiskScore[]} results
 * @param {object} config - bot.config.json values
 * @returns {boolean}
 */
function needsGate(results, config) {
  if (!config.auto_approve_major && results.some((r) => r.updateType === "major")) {
    return true;
  }
  const threshold = config.risk_threshold_auto_approve ?? RISK_THRESHOLD.MINOR_AUTO_APPROVE_MAX;
  return results.some((r) => r.riskScore > threshold);
}

// ── Local clone helpers ────────────────────────────────────────────────────────

/**
 * Shallow-clones a GitHub repository to a temporary directory using a scoped
 * token so no credentials are stored on disk after the run.
 *
 * @param {string} token - GitHub token
 * @param {string} owner
 * @param {string} repo
 * @returns {Promise<string>} Absolute path to the cloned directory
 */
async function cloneRepo(token, owner, repo) {
  const dir = await mkdtemp(join(tmpdir(), "dep-bot-"));
  const url = `https://x-access-token:${token}@github.com/${owner}/${repo}.git`;
  await exec(`git clone --depth 1 "${url}" "${dir}"`);
  logger.debug({ owner, repo, dir }, "Repository cloned to temp directory");
  return dir;
}

/**
 * Checks out the update branch, commits all changes, and pushes to origin.
 * Called after applyUpdates (and optionally after autofixRegressions) so the
 * branch has commits before openPullRequest is called.
 *
 * @param {string} dir - Local clone directory
 * @param {string} branch - Remote branch name to push to
 * @param {string} token - GitHub token (used in the remote URL)
 * @param {string} owner
 * @param {string} repo
 * @param {string[]} packageSpecs - e.g. ["lodash@4.17.21"] for the commit message
 * @param {string} [commitMessage] - Override for the commit message; defaults to "deps: update <specs>"
 * @returns {Promise<void>}
 */
async function commitAndPush(dir, branch, token, owner, repo, packageSpecs, commitMessage) {
  const remote = `https://x-access-token:${token}@github.com/${owner}/${repo}.git`;
  const message = commitMessage ?? `deps: update ${packageSpecs.join(", ")}`;

  await exec(`git -C "${dir}" config user.email "dep-bot@users.noreply.github.com"`);
  await exec(`git -C "${dir}" config user.name "Dep Bot"`);
  await exec(`git -C "${dir}" checkout -b "${branch}"`);
  await exec(`git -C "${dir}" add -A`);
  await exec(`git -C "${dir}" commit -m "${message}"`);
  await exec(`git -C "${dir}" push "${remote}" "${branch}"`);

  logger.info({ owner, repo, branch }, "Changes committed and pushed");
}

/**
 * Removes a temporary directory created by cloneRepo.
 *
 * @param {string} dir
 */
async function removeDir(dir) {
  await rm(dir, { recursive: true, force: true });
  logger.debug({ dir }, "Temporary clone removed");
}

// ── Per-ecosystem processing ───────────────────────────────────────────────────

/**
 * Runs the ANALYZE → AUDIT → NOTIFY → GATE → BRANCH → UPDATE → QA → AUTOFIX → PUSH
 * pipeline for one (repo, ecosystem) pair.
 *
 * Returns a run-report entry regardless of whether a PR was opened, so the
 * dashboard always has a full picture of the run.
 *
 * @param {object} params
 * @param {import('@octokit/rest').Octokit} params.octokit
 * @param {Anthropic} params.client - Anthropic SDK client
 * @param {string} params.token - GitHub token
 * @param {string} params.owner
 * @param {string} params.repo
 * @param {import('./scanner.js').ScanResult} params.scanResult
 * @param {object} params.config - bot.config.json values
 * @param {string | undefined} params.discordWebhook - Discord webhook URL (env var takes precedence over config)
 * @param {string | undefined} params.ntfyTopic - ntfy.sh topic name
 * @param {boolean} params.dryRun
 * @returns {Promise<object>} Run-report entry for this (repo, ecosystem) pair
 */
async function processEcosystem({ octokit, client, token, owner, repo, scanResult, config, discordWebhook, ntfyTopic, dryRun }) {
  const { ecosystem, outdated } = scanResult;

  // ── ANALYZE ──────────────────────────────────────────────────────────────────
  logger.info({ owner, repo, ecosystem, stage: STAGE.ANALYZE }, "Analyzing package updates");

  const analysisResults = await Promise.all(
    outdated.map((pkg) =>
      analyzePackageUpdate({
        client,
        token,
        packageName: pkg.name,
        currentVersion: pkg.current,
        latestVersion: pkg.latest,
        updateType: pkg.updateType,
        cacheTtlHours: config.cache_ttl_hours,
      }).catch((err) => {
        logger.error({ package: pkg.name, error: err.message }, "Analysis failed — using fallback score");
        return /** @type {import('./analyzer.js').RiskScore} */ ({
          packageName: pkg.name,
          currentVersion: pkg.current,
          latestVersion: pkg.latest,
          updateType: pkg.updateType,
          riskScore: RISK_THRESHOLD.HIGH,
          recommendation: RECOMMENDATION.NEEDS_REVIEW,
          summary: "Analysis unavailable — manual review required.",
          breakingChanges: [],
          ramifications: [],
          changelogUrl: null,
        });
      })
    )
  );

  // ── AUDIT ─────────────────────────────────────────────────────────────────────
  logger.info({ owner, repo, ecosystem, stage: STAGE.AUDIT }, "Fetching security advisories");

  const advisories = await fetchAdvisories({
    token,
    packageNames: outdated.map((p) => p.name),
    ecosystem,
  });

  const advisoriesByPackage = /** @type {Map<string, object[]>} */ (new Map());
  for (const adv of advisories) {
    if (!advisoriesByPackage.has(adv.packageName)) advisoriesByPackage.set(adv.packageName, []);
    advisoriesByPackage.get(adv.packageName).push(adv);
  }

  const hasSecurityFixes = advisories.length > 0;

  // Enrich results with advisory data — used for the run report and dashboard.
  const enrichedUpdates = analysisResults.map((r) => ({
    ...r,
    advisories: advisoriesByPackage.get(r.packageName) ?? [],
  }));

  // ── NOTIFY ───────────────────────────────────────────────────────────────────
  logger.info({ owner, repo, ecosystem, stage: STAGE.NOTIFY }, "Sending dependency report");

  const report = {
    owner,
    repo,
    scannedAt: new Date().toISOString(),
    results: analysisResults,
    notifyUser: process.env.NOTIFY_USERNAME || config.github_username || undefined,
  };

  const issueResult = await createReportIssue({ octokit, owner, repo, report, dryRun });

  const effectiveDiscord = discordWebhook || config.notification_webhook || undefined;
  if (effectiveDiscord || ntfyTopic) {
    const message =
      `[dep-bot] ${owner}/${repo} (${ecosystem}): ` +
      `${outdated.length} update(s), ${advisories.length} advisory/advisories`;
    await sendWebhookNotification({
      discordWebhook: effectiveDiscord,
      ntfyTopic,
      message,
    });
  }

  // ── GATE ──────────────────────────────────────────────────────────────────────
  if (needsGate(analysisResults, config)) {
    logger.info({ owner, repo, ecosystem, stage: STAGE.GATE }, "High-risk or major update — awaiting approval");

    if (issueResult) {
      const decision = await waitForApproval({
        octokit,
        owner,
        repo,
        issueNumber: issueResult.issueNumber,
        timeoutHours: config.approval_timeout_hours ?? GATE.DEFAULT_TIMEOUT_HOURS,
        dryRun,
      });

      if (decision === "timeout") {
        logger.warn({ owner, repo, ecosystem }, "Approval gate timed out — skipping this cycle");
        return { name: `${owner}/${repo}`, ecosystem, updates: enrichedUpdates, pr: null };
      }

      if (decision === "skipped") {
        logger.info({ owner, repo, ecosystem }, "Update skipped by owner");
        return { name: `${owner}/${repo}`, ecosystem, updates: enrichedUpdates, pr: null };
      }
    }
  }

  // ── BRANCH ───────────────────────────────────────────────────────────────────
  logger.info({ owner, repo, ecosystem, stage: STAGE.BRANCH }, "Creating update branch");

  const date = new Date().toISOString().slice(0, 10);
  const branch = await createUpdateBranch({ octokit, owner, repo, date, dryRun });

  // ── UPDATE → QA → AUTOFIX ────────────────────────────────────────────────────
  // These stages require a locally cloned repository. In dry-run mode they are
  // skipped — the branch creation and PR gate are sufficient to validate pipeline
  // flow without writing to disk or running arbitrary test commands.
  let qaFailed = false;
  // Set to true when autofix is exhausted on a major update — triggers a draft
  // PR instead of silently skipping, giving the developer visibility and a
  // work item to resolve the breaking changes manually.
  let openAsDraft = false;

  if (dryRun) {
    logger.info(
      { owner, repo, ecosystem },
      `${DRY_RUN_PREFIX} Skipping UPDATE / QA / AUTOFIX (require local clone)`
    );
  } else {
    let cloneDir = null;
    try {
      // UPDATE
      logger.info({ owner, repo, ecosystem, stage: STAGE.UPDATE }, "Cloning and applying updates");
      cloneDir = await cloneRepo(token, owner, repo);

      const packages = analysisResults.map((r) => ({
        name: r.packageName,
        version: r.latestVersion,
      }));
      await applyUpdates({ ecosystem, repoPath: cloneDir, packages });

      // QA
      logger.info({ owner, repo, ecosystem, stage: STAGE.QA }, "Running test suite");
      const testCommand = await detectTestCommand(cloneDir);

      if (testCommand) {
        const qaResult = await runTestSuite({ repoPath: cloneDir, command: testCommand });

        if (!qaResult.passed) {
          // AUTOFIX
          logger.info({ owner, repo, ecosystem, stage: STAGE.AUTOFIX }, "Tests failed — attempting autofix");

          const patchDiff = packages.map((p) => `${p.name}@${p.version}`).join(", ");
          const fixResult = await autofixRegressions({
            client,
            repoPath: cloneDir,
            failureOutput: qaResult.output,
            patchDiff,
            maxAttempts: config.max_autofix_attempts ?? 3,
            testCommand,
          });

          if (!fixResult.fixed) {
            const hasMajorUpdate = analysisResults.some((r) => r.updateType === "major");
            if (hasMajorUpdate) {
              logger.warn(
                { owner, repo, ecosystem, attempts: fixResult.attempts },
                "Autofix exhausted on major update — will open draft PR for manual resolution"
              );
              openAsDraft = true;
            } else {
              logger.warn(
                { owner, repo, ecosystem, attempts: fixResult.attempts },
                "Autofix exhausted — skipping PR for this cycle"
              );
              qaFailed = true;
            }
          } else {
            logger.info({ owner, repo, ecosystem, attempts: fixResult.attempts }, "Autofix succeeded");
          }
        }
      } else {
        logger.info({ owner, repo, ecosystem }, "No test runner detected — skipping QA");
      }

      // BUILD — run after tests so a broken build blocks the PR even when
      // there are no tests (e.g. Vite/React repos with only a build step).
      if (!qaFailed) {
        const buildCommand = await detectBuildCommand(cloneDir);
        if (buildCommand) {
          logger.info({ owner, repo, ecosystem, stage: STAGE.QA }, "Running build step");
          const buildResult = await runTestSuite({ repoPath: cloneDir, command: buildCommand });
          if (!buildResult.passed) {
            const hasMajorUpdate = analysisResults.some((r) => r.updateType === "major");
            if (hasMajorUpdate) {
              logger.warn(
                { owner, repo, ecosystem },
                "Build failed after major update — will open draft PR for manual resolution"
              );
              openAsDraft = true;
            } else {
              logger.warn(
                { owner, repo, ecosystem },
                "Build failed after dependency update — skipping PR for this cycle"
              );
              qaFailed = true;
            }
          }
        }
      }

      if (!qaFailed) {
        const packageSpecs = packages.map((p) => `${p.name}@${p.version}`);
        const commitMessage = openAsDraft
          ? `deps: update ${packageSpecs.join(", ")} [build failed — manual fix required]`
          : `deps: update ${packageSpecs.join(", ")}`;
        await commitAndPush(cloneDir, branch, token, owner, repo, packageSpecs, commitMessage);
      }
    } catch (err) {
      logger.error(
        { owner, repo, ecosystem, error: err.message },
        "UPDATE/QA stage error — skipping PR for this cycle"
      );
      qaFailed = true;
    } finally {
      if (cloneDir) await removeDir(cloneDir);
    }
  }

  if (qaFailed) {
    await deleteUpdateBranch({ octokit, owner, repo, branch, dryRun });
    if (issueResult && !dryRun) {
      await octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: issueResult.issueNumber,
        body: "⚠️ **Build/test failed after applying updates — PR skipped for this cycle.**\n\nThe dependency update was applied locally but the build or test suite did not pass. No PR has been opened. Review the [Actions log](../../actions) for details, then re-run the bot once the issue is resolved.",
      }).catch((err) => {
        logger.warn({ owner, repo, error: err.message }, "Failed to post QA failure comment on issue");
      });
    }
    return { name: `${owner}/${repo}`, ecosystem, updates: enrichedUpdates, pr: null };
  }

  if (openAsDraft && issueResult && !dryRun) {
    await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: issueResult.issueNumber,
      body: "🚧 **Build failed after applying major update — opening a draft PR.**\n\nThe dependency version bump has been committed but the build or test suite did not pass (expected for major version upgrades with breaking changes). A draft PR has been opened so you can resolve the breaking changes directly on the branch.",
    }).catch((err) => {
      logger.warn({ owner, repo, error: err.message }, "Failed to post draft PR notice on issue");
    });
  }

  // ── PUSH ──────────────────────────────────────────────────────────────────────
  logger.info({ owner, repo, ecosystem, stage: STAGE.PUSH }, "Opening pull request");

  const prResult = await openPullRequest({
    octokit,
    owner,
    repo,
    branch,
    report,
    hasSecurityFixes,
    draft: openAsDraft,
    qaFailed: openAsDraft,
    dryRun,
  });

  const prEntry = prResult
    ? { number: prResult.prNumber, url: prResult.prUrl, status: openAsDraft ? "draft" : "open" }
    : null;

  logger.info(
    { owner, repo, ecosystem, pr: prEntry?.number ?? null },
    "Ecosystem processing complete"
  );

  return { name: `${owner}/${repo}`, ecosystem, updates: enrichedUpdates, pr: prEntry };
}

// ── Main orchestrator ──────────────────────────────────────────────────────────

/**
 * Runs the full dependency management pipeline for all eligible repositories.
 *
 * @returns {Promise<void>}
 */
async function run() {
  const runStart = Date.now();
  const config = await loadConfig();
  const token = process.env.GITHUB_TOKEN;
  const dryRun = process.env.DRY_RUN === "true" || config.dry_run;

  if (!token) {
    logger.fatal("GITHUB_TOKEN environment variable is required");
    process.exit(1);
  }

  if (dryRun) {
    logger.info(`${DRY_RUN_PREFIX} Dry run mode enabled — no changes will be applied`);
  }

  const octokit = createOctokitClient(token);
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const discordWebhook = process.env.DISCORD_WEBHOOK || undefined;
  const ntfyTopic = process.env.NTFY_TOPIC || undefined;

  // ── DISCOVER ──────────────────────────────────────────────────────────────────
  logger.info({ stage: STAGE.DISCOVER }, "Pipeline starting");

  const repos = await discoverRepositories({
    token,
    excludedRepos: config.excluded_repos,
    priorityRepos: config.priority_repos,
    targetRepo: process.env.TARGET_REPO || undefined,
    _octokitOverride: octokit,
  });

  logger.info({ repoCount: repos.length, stage: STAGE.DISCOVER }, "Discovery complete");

  const runReport = {
    runAt: new Date().toISOString(),
    durationSeconds: 0,
    repositories: [],
  };

  // Concurrency limit for parallel repo processing. Keeps GitHub API usage
  // well within secondary rate limits while still processing repos in parallel.
  const REPO_CONCURRENCY = config.repo_concurrency ?? 3;
  const allowedEcosystems = config.scan_ecosystems ?? null;

  /**
   * Processes a single repository through SCAN → PUSH and returns all
   * run-report entries for it (one per ecosystem with updates).
   *
   * @param {object} repoMeta
   * @returns {Promise<object[]>}
   */
  async function processRepo(repoMeta) {
    const owner = repoMeta.owner.login;
    const repo = repoMeta.name;

    // ── SCAN ─────────────────────────────────────────────────────────────────
    logger.info({ repo: repoMeta.full_name, stage: STAGE.SCAN }, "Scanning repository");

    let scanResults;
    try {
      scanResults = await scanRepository(octokit, owner, repo, allowedEcosystems, config.held_packages ?? {});
    } catch (err) {
      logger.error({ repo: repoMeta.full_name, error: err.message }, "Scan failed — skipping");
      return [];
    }

    const ecosystemsWithUpdates = scanResults.filter((r) => r.outdated.length > 0);

    if (ecosystemsWithUpdates.length === 0) {
      logger.info({ repo: repoMeta.full_name }, "All dependencies up to date");
      return [];
    }

    logger.info(
      { repo: repoMeta.full_name, ecosystems: ecosystemsWithUpdates.map((e) => e.ecosystem) },
      "Outdated dependencies found"
    );

    const entries = [];
    for (const scanResult of ecosystemsWithUpdates) {
      try {
        const entry = await processEcosystem({
          octokit,
          client,
          token,
          owner,
          repo,
          scanResult,
          config,
          discordWebhook,
          ntfyTopic,
          dryRun,
        });
        entries.push(entry);
      } catch (err) {
        logger.error(
          { repo: repoMeta.full_name, ecosystem: scanResult.ecosystem, error: err.message },
          "Ecosystem processing failed — continuing"
        );
      }
    }
    return entries;
  }

  // Process repos in parallel batches to stay within API rate limits.
  for (let i = 0; i < repos.length; i += REPO_CONCURRENCY) {
    const batch = repos.slice(i, i + REPO_CONCURRENCY);
    const batchResults = await Promise.all(batch.map(processRepo));
    for (const entries of batchResults) {
      runReport.repositories.push(...entries);
    }
  }

  runReport.durationSeconds = parseFloat(((Date.now() - runStart) / 1000).toFixed(1));

  // ── Write run report for dashboard ────────────────────────────────────────────
  try {
    const reportPath = new URL(`../${CACHE.DIR}/run-report.json`, import.meta.url);
    await writeFile(reportPath, JSON.stringify(runReport, null, 2), "utf8");
    logger.info({ path: `${CACHE.DIR}/run-report.json` }, "Run report written");
  } catch (err) {
    logger.warn({ error: err.message }, "Failed to write run report — dashboard will show stale data");
  }

  logger.info({ durationSeconds: runReport.durationSeconds }, "Pipeline complete");
}

run().catch((error) => {
  logger.fatal({ error: error.message, stack: error.stack }, "Pipeline failed with unhandled error");
  process.exit(1);
});
