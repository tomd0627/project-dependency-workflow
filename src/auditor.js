/**
 * @fileoverview CVE audit via GitHub Advisory Database (GraphQL API).
 * Queries the GitHub Advisory Database for known vulnerabilities affecting
 * the packages discovered in the scan stage.
 */

import { logger } from "./logger.js";

/** @typedef {{ ghsaId: string; severity: string; summary: string; affectedRange: string; patchedVersion: string | null; packageName: string }} Advisory */

/**
 * Fetches security advisories from the GitHub Advisory Database for a list
 * of package names.
 *
 * @param {object} params
 * @param {string} params.token - GitHub token (for GraphQL authentication)
 * @param {string[]} params.packageNames - Package names to check
 * @param {string} params.ecosystem - Ecosystem identifier (e.g. "npm", "pip")
 * @returns {Promise<Advisory[]>}
 */
export async function fetchAdvisories({ token, packageNames, ecosystem }) {
  // TODO: implement GraphQL query against GitHub Advisory Database
  logger.debug({ packageCount: packageNames.length, ecosystem }, "Auditor — not yet implemented");
  return [];
}
