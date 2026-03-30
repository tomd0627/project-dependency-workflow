/**
 * @fileoverview Claude API integration for changelog analysis and risk scoring.
 * Fetches changelogs via GitHub Releases API, then uses Claude to extract
 * breaking changes and produce a structured risk score.
 */

import Anthropic from "@anthropic-ai/sdk";
import { logger } from "./logger.js";
import { get as cacheGet, set as cacheSet } from "./cache.js";
import { API, RECOMMENDATION } from "./constants.js";

/** @typedef {import('./constants.js').RECOMMENDATION[keyof import('./constants.js').RECOMMENDATION]} RecommendationValue */

/**
 * @typedef {object} RiskScore
 * @property {string} packageName
 * @property {string} currentVersion
 * @property {string} latestVersion
 * @property {'patch'|'minor'|'major'} updateType
 * @property {number} riskScore
 * @property {RecommendationValue} recommendation
 * @property {string} summary
 * @property {string[]} breakingChanges
 * @property {string[]} ramifications
 * @property {string | null} changelogUrl
 */

/**
 * Prompts sent to Claude for changelog analysis.
 * All prompts are defined as named constants — no inline strings.
 */
const PROMPTS = {
  SYSTEM: `You are a dependency risk analyst. Your job is to analyze package changelogs and assess the risk of upgrading. You MUST respond with valid JSON only — no markdown fences, no preamble, no explanation outside the JSON object. The JSON must conform exactly to the schema provided.`,

  /**
   * @param {object} p
   * @param {string} p.packageName
   * @param {string} p.currentVersion
   * @param {string} p.latestVersion
   * @param {string} p.updateType
   * @param {string} p.changelogText
   * @returns {string}
   */
  analysis: ({ packageName, currentVersion, latestVersion, updateType, changelogText }) => `
Analyze this dependency upgrade and return a JSON risk assessment.

Package: ${packageName}
Current version: ${currentVersion}
Latest version: ${latestVersion}
Update type: ${updateType}
Changelog:
${changelogText}

Return JSON with this exact schema:
{
  "packageName": "string",
  "currentVersion": "string",
  "latestVersion": "string",
  "updateType": "patch" | "minor" | "major",
  "riskScore": number (0-100),
  "recommendation": "THUMBS_UP" | "THUMBS_DOWN" | "NEEDS_REVIEW",
  "summary": "string (2-3 sentences)",
  "breakingChanges": ["string"],
  "ramifications": ["string"],
  "changelogUrl": "string | null"
}
`.trim(),
};

/**
 * Fetches the release changelog for a package version from GitHub Releases API.
 * Falls back to an empty string if no release is found.
 *
 * @param {object} params
 * @param {string} params.token - GitHub token
 * @param {string} params.packageName - npm package or crate name
 * @param {string} params.latestVersion - Target version to fetch notes for
 * @returns {Promise<{ text: string; url: string | null }>}
 */
export async function fetchChangelog({ token, packageName, latestVersion }) {
  // TODO: implement GitHub Releases API lookup
  logger.debug({ packageName, latestVersion }, "Changelog fetch — not yet implemented");
  return { text: "", url: null };
}

/**
 * Parses and validates a raw JSON string from the Claude API.
 * Throws a typed error if the response is malformed.
 *
 * @param {string} raw - Raw JSON string from Claude
 * @returns {RiskScore}
 */
export function parseClaudeResponse(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Claude response is not valid JSON. Raw: ${raw.slice(0, 200)}`);
  }

  const required = ["packageName", "currentVersion", "latestVersion", "updateType", "riskScore", "recommendation"];
  for (const field of required) {
    if (parsed[field] === undefined) {
      throw new Error(`Claude response missing required field: "${field}". Raw: ${raw.slice(0, 200)}`);
    }
  }

  const validRecommendations = Object.values(RECOMMENDATION);
  if (!validRecommendations.includes(parsed.recommendation)) {
    throw new Error(`Invalid recommendation value: "${parsed.recommendation}". Expected one of: ${validRecommendations.join(", ")}`);
  }

  return parsed;
}

/**
 * Calls the Claude API with retry and exponential backoff.
 * Falls back to a NEEDS_REVIEW result if the API is unavailable.
 *
 * @param {Anthropic} client - Authenticated Anthropic client
 * @param {string} userPrompt - Rendered analysis prompt
 * @param {string} cacheKey - Cache key for this request
 * @returns {Promise<RiskScore>}
 */
export async function callClaudeWithRetry(client, userPrompt, cacheKey) {
  // TODO: implement with retry + exponential backoff + cache
  logger.debug({ cacheKey }, "Claude API call — not yet implemented");
  return {
    packageName: "unknown",
    currentVersion: "unknown",
    latestVersion: "unknown",
    updateType: "patch",
    riskScore: 50,
    recommendation: RECOMMENDATION.NEEDS_REVIEW,
    summary: "Analysis unavailable — Claude API not yet implemented.",
    breakingChanges: [],
    ramifications: [],
    changelogUrl: null,
  };
}

/**
 * Analyzes a single package update using the Claude API.
 * Results are cached by {packageName}@{latestVersion}.
 *
 * @param {object} params
 * @param {Anthropic} params.client - Anthropic client
 * @param {string} params.token - GitHub token for changelog fetching
 * @param {string} params.packageName
 * @param {string} params.currentVersion
 * @param {string} params.latestVersion
 * @param {'patch'|'minor'|'major'} params.updateType
 * @param {number} params.cacheTtlHours
 * @returns {Promise<RiskScore>}
 */
export async function analyzePackageUpdate({
  client,
  token,
  packageName,
  currentVersion,
  latestVersion,
  updateType,
  cacheTtlHours,
}) {
  const cacheKey = `${packageName}@${latestVersion}`;
  const cached = await cacheGet(cacheKey);
  if (cached) {
    logger.debug({ cacheKey }, "Cache hit — skipping Claude API call");
    return /** @type {RiskScore} */ (cached);
  }

  const { text: changelogText, url: changelogUrl } = await fetchChangelog({ token, packageName, latestVersion });

  const userPrompt = PROMPTS.analysis({ packageName, currentVersion, latestVersion, updateType, changelogText });
  const result = await callClaudeWithRetry(client, userPrompt, cacheKey);

  if (changelogUrl && !result.changelogUrl) result.changelogUrl = changelogUrl;

  await cacheSet(cacheKey, result, cacheTtlHours);
  return result;
}
