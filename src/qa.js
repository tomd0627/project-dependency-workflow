/**
 * @fileoverview Test suite detection and execution.
 * Detects which test runner a repository uses, executes the test suite,
 * and parses the output into a structured pass/fail result.
 */

import { exec as cpExec } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { QA } from "./constants.js";
import { logger } from "./logger.js";

const exec = promisify(cpExec);

/** @typedef {{ passed: boolean; output: string; duration: number; testCount: number }} QAResult */

/**
 * Parses a test runner's stdout/stderr to extract the number of passing tests.
 * Handles Jest, pytest, and cargo test output formats.
 * Exported as a pure helper for unit testing.
 *
 * @param {string} output - Combined stdout + stderr from the test run
 * @returns {number} Number of passing tests, or 0 if not parseable
 */
export function parseTestCount(output) {
  // Jest verbose:  "Tests: 84 passed, 0 failed, 84 total"
  const jestVerbose = output.match(/Tests:\s+(\d+) passed/);
  if (jestVerbose) return parseInt(jestVerbose[1], 10);

  // Jest compact / pytest: "84 passed" or "84 passed in 1.23s"
  const genericPassed = output.match(/(\d+) passed/);
  if (genericPassed) return parseInt(genericPassed[1], 10);

  // cargo test: "test result: ok. 5 passed; 0 failed"
  const cargo = output.match(/test result: ok\.\s+(\d+) passed/);
  if (cargo) return parseInt(cargo[1], 10);

  return 0;
}

/**
 * Checks whether a path exists without throwing.
 *
 * @param {string} filePath
 * @returns {Promise<boolean>}
 */
async function pathExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Detects the test runner for a repository and returns the command to run.
 * Checks, in order: Node.js → Python → Rust → Go.
 *
 * @param {string} repoPath - Local path to the repository
 * @returns {Promise<string | null>} The test command, or null if none found
 */
export async function detectTestCommand(repoPath) {
  // Node.js — check package.json for a non-placeholder test script.
  try {
    const raw = await readFile(join(repoPath, "package.json"), "utf8");
    const pkg = JSON.parse(raw);
    const testScript = pkg.scripts?.test ?? "";
    if (testScript && !testScript.includes("no test specified")) {
      logger.debug({ repoPath }, "Detected Node.js test runner");
      return "npm test";
    }
  } catch {
    // No package.json or parse error — continue to next ecosystem.
  }

  // Python — presence of any standard pytest config file.
  for (const file of ["pytest.ini", "pyproject.toml", "setup.cfg", "setup.py"]) {
    if (await pathExists(join(repoPath, file))) {
      logger.debug({ repoPath, file }, "Detected Python/pytest test runner");
      return "python -m pytest";
    }
  }

  // Rust
  if (await pathExists(join(repoPath, "Cargo.toml"))) {
    logger.debug({ repoPath }, "Detected Rust/cargo test runner");
    return "cargo test";
  }

  // Go
  if (await pathExists(join(repoPath, "go.mod"))) {
    logger.debug({ repoPath }, "Detected Go test runner");
    return "go test ./...";
  }

  logger.debug({ repoPath }, "No recognized test runner found");
  return null;
}

/**
 * Checks whether a Node.js repository has a build script and returns the
 * command to run it. Returns null if no build script is defined.
 *
 * @param {string} repoPath - Local path to the repository
 * @returns {Promise<string | null>}
 */
export async function detectBuildCommand(repoPath) {
  try {
    const raw = await readFile(join(repoPath, "package.json"), "utf8");
    const pkg = JSON.parse(raw);
    if (pkg.scripts?.build) {
      logger.debug({ repoPath }, "Detected npm build script");
      return "npm run build";
    }
  } catch {
    // No package.json or parse error — no build step.
  }
  return null;
}

/**
 * Runs the test suite and returns a structured result.
 * Always resolves — a test failure is not a thrown error but a `passed: false` result.
 * A timeout or execution error is also returned as `passed: false`.
 *
 * @param {object} params
 * @param {string} params.repoPath - Working directory for the test command
 * @param {string} params.command - Test command to execute (from detectTestCommand)
 * @returns {Promise<QAResult>}
 */
export async function runTestSuite({ repoPath, command }) {
  const start = Date.now();

  try {
    const { stdout, stderr } = await exec(command, {
      cwd: repoPath,
      timeout: QA.DEFAULT_TIMEOUT_MS,
    });

    const output = [stdout, stderr].filter(Boolean).join("\n").trim();
    const duration = Date.now() - start;
    const testCount = parseTestCount(output);

    logger.info({ repoPath, command, testCount, duration }, "Test suite passed");
    return { passed: true, output, duration, testCount };
  } catch (error) {
    const output = [error.stdout ?? "", error.stderr ?? ""].filter(Boolean).join("\n").trim();
    const duration = Date.now() - start;
    const testCount = parseTestCount(output);

    logger.warn({ repoPath, command, duration, error: error.message }, "Test suite failed");
    return { passed: false, output, duration, testCount };
  }
}
