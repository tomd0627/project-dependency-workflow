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
import { createUpdateBranch, openPullRequest } from "./publisher.js";
import { detectTestCommand, runTestSuite } from "./qa.js";
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
  const raw = await readFile(new URL("../bot.config.json", import.meta.url), "utf8");
  return JSON.parse(raw);
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
            logger.warn(
              { owner, repo, ecosystem, attempts: fixResult.attempts },
              "Autofix exhausted — skipping PR for this cycle"
            );
            qaFailed = true;
          } else {
            logger.info({ owner, repo, ecosystem, attempts: fixResult.attempts }, "Autofix succeeded");
          }
        }
      } else {
        logger.info({ owner, repo, ecosystem }, "No test runner detected — skipping QA");
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
    return { name: `${owner}/${repo}`, ecosystem, updates: enrichedUpdates, pr: null };
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
    dryRun,
  });

  const prEntry = prResult
    ? { number: prResult.prNumber, url: prResult.prUrl, status: "open" }
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

  for (const repoMeta of repos) {
    const owner = repoMeta.owner.login;
    const repo = repoMeta.name;

    // ── SCAN ───────────────────────────────────────────────────────────────────
    logger.info({ repo: repoMeta.full_name, stage: STAGE.SCAN }, "Scanning repository");

    let scanResults;
    try {
      scanResults = await scanRepository(octokit, owner, repo);
    } catch (err) {
      logger.error({ repo: repoMeta.full_name, error: err.message }, "Scan failed — skipping");
      continue;
    }

    const ecosystemsWithUpdates = scanResults.filter((r) => r.outdated.length > 0);

    if (ecosystemsWithUpdates.length === 0) {
      logger.info({ repo: repoMeta.full_name }, "All dependencies up to date");
      continue;
    }

    logger.info(
      { repo: repoMeta.full_name, ecosystems: ecosystemsWithUpdates.map((e) => e.ecosystem) },
      "Outdated dependencies found"
    );

    // Process each detected ecosystem independently so a failure in one does
    // not block the others.
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
        runReport.repositories.push(entry);
      } catch (err) {
        logger.error(
          { repo: repoMeta.full_name, ecosystem: scanResult.ecosystem, error: err.message },
          "Ecosystem processing failed — continuing"
        );
      }
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
