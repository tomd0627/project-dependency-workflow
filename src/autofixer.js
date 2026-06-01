/**
 * @fileoverview Claude-powered regression fix loop.
 * When a QA pass fails after applying updates, this module sends the failure
 * output to Claude and applies suggested fixes, repeating up to
 * MAX_AUTOFIX_ATTEMPTS times.
 */

import { exec } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { promisify } from "node:util";

import { API } from "./constants.js";
import { logger } from "./logger.js";

const execAsync = promisify(exec);

/** Default maximum number of autofix attempts before giving up. */
const DEFAULT_MAX_ATTEMPTS = 3;

/**
 * Builds the Claude prompt for a given failure context.
 * @param {string} failureOutput
 * @param {string} patchDiff
 * @returns {string}
 */
function buildFixPrompt(failureOutput, patchDiff) {
  return `You are a code repair assistant. A dependency update caused automated check failures.

APPLIED DIFF (the dependency change that broke things):
${patchDiff}

FAILURE OUTPUT:
${failureOutput}

Analyse the failure and return ONLY a JSON array of file changes required to fix it.
Each element must have this shape: { "file": "relative/path/from/repo/root", "content": "full new file content" }

Rules:
- Return ONLY valid JSON — no markdown fences, no commentary.
- If you cannot determine a safe fix, return an empty array: []
- Keep changes minimal; prefer fixing call-sites over rewriting entire files.
- NEVER modify package.json, package-lock.json, yarn.lock, pnpm-lock.yaml, or any other dependency manifest or lockfile. Version management is handled separately. Return [] if the only fix would touch these files.`;
}

/**
 * Asks Claude for file changes that should fix the given failure.
 * Returns a parsed array of { file, content } objects, or [] on any error.
 *
 * @param {import('@anthropic-ai/sdk').default} client
 * @param {string} failureOutput
 * @param {string} patchDiff
 * @returns {Promise<Array<{ file: string, content: string }>>}
 */
async function suggestFixes(client, failureOutput, patchDiff) {
  const msg = await client.messages.create({
    model: API.CLAUDE_MODEL,
    max_tokens: API.CLAUDE_MAX_TOKENS * 2,
    messages: [{ role: "user", content: buildFixPrompt(failureOutput, patchDiff) }],
  });

  const text = msg.content.find((b) => b.type === "text")?.text ?? "";

  // Extract the outermost JSON array from the response.
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) return [];

  try {
    return JSON.parse(match[0]);
  } catch {
    logger.warn("Autofix: Claude returned unparseable JSON — skipping");
    return [];
  }
}

/** Files the autofixer must never overwrite — version management is the updater's job. */
const PROTECTED_FILES = new Set([
  "package.json",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "npm-shrinkwrap.json",
]);

async function applyChanges(repoPath, changes) {
  for (const { file, content } of changes) {
    if (PROTECTED_FILES.has(file.split("/").at(-1))) {
      logger.warn({ file }, "Autofix: skipping protected file");
      continue;
    }
    const fullPath = `${repoPath}/${file}`;
    await writeFile(fullPath, content, "utf8");
    logger.debug({ file }, "Autofix: wrote file");
  }
}

/**
 * Runs the test suite and returns { passed, output }.
 * @param {string} repoPath
 * @param {string} testCommand
 * @returns {Promise<{ passed: boolean, output: string }>}
 */
async function runTests(repoPath, testCommand) {
  try {
    const { stdout, stderr } = await execAsync(testCommand, {
      cwd: repoPath,
      timeout: 5 * 60_000,
    });
    return { passed: true, output: stdout + stderr };
  } catch (err) {
    return {
      passed: false,
      output: (err.stdout ?? "") + (err.stderr ?? "") + err.message,
    };
  }
}

/**
 * Attempts to automatically fix test failures introduced by a dependency update.
 * Retries up to maxAttempts times before giving up.
 *
 * @param {object} params
 * @param {import('@anthropic-ai/sdk').default} params.client - Anthropic client
 * @param {string} params.repoPath
 * @param {string} params.failureOutput - Test failure stdout/stderr
 * @param {string} params.patchDiff - The diff applied by the updater
 * @param {number} [params.maxAttempts]
 * @param {string} [params.testCommand] - Fast static-check command used to verify fixes
 *   (e.g. 'npm run lint'). Prefer detectStaticCheckCommand() from qa.js over a full
 *   test suite — E2E/browser tests cannot pass in a headless bot environment.
 * @returns {Promise<{ fixed: boolean; attempts: number; trace: string[] }>}
 */
export async function autofixRegressions({
  client,
  repoPath,
  failureOutput,
  patchDiff,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  testCommand = "npm run lint",
}) {
  const trace = [];
  let currentFailure = failureOutput;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    logger.info({ repoPath, attempt, maxAttempts }, "Autofix attempt");

    const changes = await suggestFixes(client, currentFailure, patchDiff);

    if (changes.length === 0) {
      trace.push(`Attempt ${attempt}: Claude returned no suggestions`);
      logger.warn({ attempt }, "Autofix: no suggestions from Claude — stopping");
      break;
    }

    await applyChanges(repoPath, changes);
    trace.push(`Attempt ${attempt}: applied ${changes.length} file change(s)`);

    const { passed, output } = await runTests(repoPath, testCommand);

    if (passed) {
      trace.push(`Attempt ${attempt}: tests passed`);
      logger.info({ attempt }, "Autofix succeeded");
      return { fixed: true, attempts: attempt, trace };
    }

    currentFailure = output;
    trace.push(`Attempt ${attempt}: tests still failing`);
    logger.debug({ attempt }, "Autofix: tests still failing — retrying");
  }

  logger.warn({ maxAttempts }, "Autofix: could not fix regressions within attempt limit");
  return { fixed: false, attempts: maxAttempts, trace };
}
