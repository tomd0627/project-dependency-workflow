/**
 * @fileoverview Claude API integration for changelog analysis and risk scoring.
 * Fetches changelogs via GitHub Releases API, then uses Claude to extract
 * breaking changes and produce a structured risk score.
 */

import Anthropic from "@anthropic-ai/sdk";
import { get as cacheGet, set as cacheSet } from "./cache.js";
import { API, NPM, RECOMMENDATION } from "./constants.js";
import { logger } from "./logger.js";

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
  // Step 1 — resolve the package's GitHub repository URL via the npm registry.
  const encoded = packageName.replace("/", "%2F");
  let repoUrl;
  try {
    const registryResp = await fetch(`${NPM.REGISTRY_URL}/${encoded}`);
    if (!registryResp.ok) {
      logger.debug({ packageName }, "Package not found in npm registry — skipping changelog");
      return { text: "", url: null };
    }
    const data = await registryResp.json();
    repoUrl = data?.repository?.url ?? null;
  } catch (error) {
    logger.warn({ packageName, error: error.message }, "npm registry fetch failed — skipping changelog");
    return { text: "", url: null };
  }

  if (!repoUrl) {
    logger.debug({ packageName }, "No repository URL in npm metadata — skipping changelog");
    return { text: "", url: null };
  }

  // Step 2 — extract owner/repo from a GitHub URL.
  const githubMatch = repoUrl.match(/github\.com[/:]([^/]+)\/([^/.]+)/);
  if (!githubMatch) {
    logger.debug({ packageName, repoUrl }, "Repository is not on GitHub — skipping changelog");
    return { text: "", url: null };
  }

  const [, owner, repo] = githubMatch;
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
  };

  // Step 3 — try `v{version}` first, then bare `{version}` as a fallback tag.
  for (const tag of [`v${latestVersion}`, latestVersion]) {
    try {
      const resp = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/releases/tags/${tag}`,
        { headers }
      );
      if (resp.ok) {
        const release = await resp.json();
        logger.debug({ packageName, tag }, "Changelog fetched from GitHub Releases");
        return { text: release.body ?? "", url: release.html_url ?? null };
      }
    } catch (error) {
      logger.debug({ packageName, tag, error: error.message }, "GitHub release tag fetch failed");
    }
  }

  logger.debug({ packageName, latestVersion }, "No GitHub Release found — proceeding without changelog");
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
  let lastError;

  for (let attempt = 0; attempt < API.MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      // Exponential backoff: 1s, 2s, 4s … capped at RETRY_MAX_DELAY_MS.
      const delay = Math.min(
        API.RETRY_BASE_DELAY_MS * 2 ** (attempt - 1),
        API.RETRY_MAX_DELAY_MS
      );
      logger.debug({ cacheKey, attempt, delay }, "Retrying Claude API call after delay");
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    try {
      const message = await client.messages.create(
        {
          model: API.CLAUDE_MODEL,
          max_tokens: API.CLAUDE_MAX_TOKENS,
          system: PROMPTS.SYSTEM,
          messages: [{ role: "user", content: userPrompt }],
        },
        // Disable the SDK's built-in retry — we manage retries ourselves.
        { timeout: API.CLAUDE_TIMEOUT_MS, maxRetries: 0 }
      );

      const raw = message.content[0]?.text ?? "";
      return parseClaudeResponse(raw);
    } catch (error) {
      lastError = error;

      // Parse / validation errors are not retryable.
      if (
        error.message?.includes("not valid JSON") ||
        error.message?.includes("missing required field") ||
        error.message?.includes("Invalid recommendation")
      ) {
        break;
      }

      // 4xx client errors (except 429 rate-limit) are not retryable.
      const status = error.status ?? error.statusCode;
      if (status && status >= 400 && status < 500 && status !== 429) break;

      logger.warn({ cacheKey, attempt, error: error.message }, "Claude API call failed");
    }
  }

  logger.error({ cacheKey, error: lastError?.message }, "Claude API failed after all retries — falling back to NEEDS_REVIEW");
  const atIndex = cacheKey.lastIndexOf("@");
  return {
    packageName: atIndex > 0 ? cacheKey.slice(0, atIndex) : cacheKey,
    currentVersion: "unknown",
    latestVersion: atIndex > 0 ? cacheKey.slice(atIndex + 1) : "unknown",
    updateType: "patch",
    riskScore: 50,
    recommendation: RECOMMENDATION.NEEDS_REVIEW,
    summary: "Analysis unavailable — Claude API failed after retries.",
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
