/**
 * @fileoverview Package manager execution for each supported ecosystem.
 * Applies dependency updates by invoking the correct CLI tool for the
 * detected ecosystem. Operates on a locally cloned repository path.
 */

import { exec as cpExec } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { ECOSYSTEM } from "./constants.js";
import { logger } from "./logger.js";

const exec = promisify(cpExec);

/**
 * @typedef {object} PackageUpdate
 * @property {string} name - Package name, e.g. "lodash" or "@octokit/rest"
 * @property {string} version - Target version, e.g. "4.17.21"
 */

/**
 * Builds the list of `name@version` specifiers for `npm install`.
 * Exported as a pure helper for unit testing.
 *
 * @param {PackageUpdate[]} packages
 * @returns {string[]} e.g. ["lodash@4.17.21", "@octokit/rest@21.0.2"]
 */
export function buildNpmInstallArgs(packages) {
  return packages.map(({ name, version }) => `${name}@${version}`);
}

/**
 * Applies dependency updates for a Node.js repository using npm install.
 * Writes updated versions directly into node_modules and package-lock.json.
 *
 * @param {object} params
 * @param {string} params.repoPath - Local path to the cloned repository
 * @param {PackageUpdate[]} params.packages - Packages to update with target versions
 * @returns {Promise<void>}
 */
export async function updateNodeDependencies({ repoPath, packages }) {
  if (packages.length === 0) {
    logger.debug({ repoPath }, "No packages to update — skipping npm install");
    return;
  }

  const args = buildNpmInstallArgs(packages);
  logger.info({ repoPath, packages: args }, "Installing updated Node.js packages");

  let stdout, stderr;
  try {
    ({ stdout, stderr } = await exec(`npm install ${args.join(" ")}`, { cwd: repoPath }));
  } catch (err) {
    if (!err.message?.includes("ERESOLVE")) throw err;

    logger.warn(
      { repoPath, packages: args },
      "npm install failed with ERESOLVE peer conflict — retrying with --legacy-peer-deps"
    );
    // Write .npmrc so any subsequent fresh install (e.g. Netlify CI) uses the
    // same resolution strategy and doesn't fail on the same peer conflict.
    await writeFile(join(repoPath, ".npmrc"), "legacy-peer-deps=true\n", "utf8");
    ({ stdout, stderr } = await exec(
      `npm install --legacy-peer-deps ${args.join(" ")}`,
      { cwd: repoPath }
    ));
  }

  if (stderr) logger.debug({ stderr }, "npm install stderr");
  logger.debug({ stdout }, "npm install complete");
}

/**
 * Dispatches to the correct updater based on the detected ecosystem.
 * Throws for unsupported ecosystems so the caller can decide how to handle it.
 *
 * @param {object} params
 * @param {string} params.ecosystem - One of the ECOSYSTEM constants
 * @param {string} params.repoPath - Local path to the cloned repository
 * @param {PackageUpdate[]} params.packages - Packages to update with target versions
 * @returns {Promise<void>}
 */
export async function applyUpdates({ ecosystem, repoPath, packages }) {
  switch (ecosystem) {
    case ECOSYSTEM.NODE:
      return updateNodeDependencies({ repoPath, packages });
    default:
      throw new Error(
        `Unsupported ecosystem for automated update: "${ecosystem}". ` +
        `Supported: ${ECOSYSTEM.NODE}`
      );
  }
}
