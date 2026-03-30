/**
 * @fileoverview CVE audit via GitHub Advisory Database (GraphQL API).
 * Queries the GitHub Advisory Database for known vulnerabilities affecting
 * the packages discovered in the scan stage. Batches all packages into a
 * single GraphQL request using field aliases.
 */

import { ADVISORY_ECOSYSTEM, API } from "./constants.js";
import { logger } from "./logger.js";

/** @typedef {{ ghsaId: string; severity: string; summary: string; affectedRange: string; patchedVersion: string | null; packageName: string }} Advisory */

// ── Query building ────────────────────────────────────────────────────────────

/**
 * Builds a batched GraphQL query that fetches advisories for every package in
 * a single round trip, using `pkg0`, `pkg1` … field aliases.
 * Exported as a pure helper for unit testing.
 *
 * @param {string[]} packageNames
 * @param {string} ecosystemEnum - GitHub GraphQL enum value, e.g. "NPM"
 * @returns {string} A valid GraphQL query string
 */
export function buildAdvisoryQuery(packageNames, ecosystemEnum) {
  const fields = packageNames.map(
    (name, i) => `
    pkg${i}: securityVulnerabilities(ecosystem: ${ecosystemEnum}, package: ${JSON.stringify(name)}, first: 20) {
      nodes {
        advisory { ghsaId severity summary }
        vulnerableVersionRange
        firstPatchedVersion { identifier }
        package { name }
      }
    }`
  );

  return `{ ${fields.join("")} }`;
}

// ── Response parsing ──────────────────────────────────────────────────────────

/**
 * Extracts a flat Advisory array from the GraphQL response data object.
 * Exported as a pure helper for unit testing.
 *
 * @param {Record<string, unknown>} data - The `data` field of the GraphQL response
 * @param {string[]} packageNames - Same list used to build the query (for alias lookup)
 * @returns {Advisory[]}
 */
export function parseAdvisoryResponse(data, packageNames) {
  const advisories = [];

  for (let i = 0; i < packageNames.length; i++) {
    const nodes = /** @type {any[]} */ (data[`pkg${i}`]?.nodes ?? []);

    for (const node of nodes) {
      advisories.push({
        ghsaId: node.advisory.ghsaId,
        severity: node.advisory.severity,
        summary: node.advisory.summary,
        affectedRange: node.vulnerableVersionRange,
        patchedVersion: node.firstPatchedVersion?.identifier ?? null,
        packageName: node.package.name,
      });
    }
  }

  return advisories;
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Fetches security advisories from the GitHub Advisory Database for a list
 * of package names. Returns an empty array on any failure so the pipeline
 * can continue — a CVE audit error must never abort an update run.
 *
 * @param {object} params
 * @param {string} params.token - GitHub token (for GraphQL authentication)
 * @param {string[]} params.packageNames - Package names to check
 * @param {string} params.ecosystem - Ecosystem key from ECOSYSTEM constants
 * @returns {Promise<Advisory[]>}
 */
export async function fetchAdvisories({ token, packageNames, ecosystem }) {
  if (packageNames.length === 0) return [];

  const ecosystemEnum = ADVISORY_ECOSYSTEM[ecosystem];
  if (!ecosystemEnum) {
    logger.warn({ ecosystem }, "Unknown ecosystem for CVE audit — skipping");
    return [];
  }

  const query = buildAdvisoryQuery(packageNames, ecosystemEnum);
  logger.debug({ packageCount: packageNames.length, ecosystem }, "Querying GitHub Advisory Database");

  try {
    const resp = await fetch(API.GITHUB_GRAPHQL_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-Github-Next-Global-ID": "1",
      },
      body: JSON.stringify({ query }),
    });

    if (!resp.ok) {
      logger.warn({ status: resp.status }, "GitHub Advisory Database request failed — skipping audit");
      return [];
    }

    const json = await resp.json();

    if (json.errors?.length) {
      logger.warn({ errors: json.errors }, "GitHub Advisory Database returned GraphQL errors");
    }

    const advisories = parseAdvisoryResponse(json.data ?? {}, packageNames);
    logger.info({ count: advisories.length, ecosystem }, "CVE audit complete");
    return advisories;
  } catch (error) {
    logger.error({ error: error.message }, "CVE audit fetch failed — skipping");
    return [];
  }
}
