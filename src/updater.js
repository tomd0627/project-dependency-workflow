/**
 * @fileoverview Package manager execution for each supported ecosystem.
 * Applies dependency updates by invoking the correct CLI tool for the
 * detected ecosystem.
 */

import { logger } from "./logger.js";
import { ECOSYSTEM } from "./constants.js";

/**
 * Applies dependency updates for a Node.js repository using npm-check-updates.
 *
 * @param {object} params
 * @param {string} params.repoPath - Local path to the repository
 * @param {string[]} params.packages - Package names to update
 * @returns {Promise<void>}
 */
export async function updateNodeDependencies({ repoPath, packages }) {
  // TODO: implement ncu + npm install
  logger.debug({ repoPath, packageCount: packages.length }, "Node.js updater — not yet implemented");
}

/**
 * Dispatches to the correct updater based on ecosystem.
 *
 * @param {object} params
 * @param {string} params.ecosystem - One of ECOSYSTEM constants
 * @param {string} params.repoPath
 * @param {string[]} params.packages
 * @returns {Promise<void>}
 */
export async function applyUpdates({ ecosystem, repoPath, packages }) {
  // TODO: implement all ecosystems
  logger.debug({ ecosystem, repoPath }, "Updater — not yet implemented");
}
