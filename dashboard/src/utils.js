/**
 * @fileoverview Pure utility functions for the Dep Bot dashboard.
 * All functions are side-effect-free and independently testable.
 * Risk thresholds mirror src/constants.js RISK_THRESHOLD.
 */

/** @typedef {'low'|'medium'|'high'|'critical'} RiskLevel */

/** Risk score thresholds — mirrors RISK_THRESHOLD in src/constants.js. */
const THRESHOLD = Object.freeze({ LOW: 30, MEDIUM: 70, HIGH: 90 });

/**
 * Maps a numeric risk score (0–100) to a named severity level.
 * @param {number} score
 * @returns {RiskLevel}
 */
export function getRiskLevel(score) {
  if (score <= THRESHOLD.LOW) return "low";
  if (score <= THRESHOLD.MEDIUM) return "medium";
  if (score <= THRESHOLD.HIGH) return "high";
  return "critical";
}

/**
 * Maps a risk level to its CSS custom property name.
 * @param {RiskLevel} level
 * @returns {string}
 */
export function getRiskColorVar(level) {
  const map = {
    low: "--color-accent-primary",
    medium: "--color-accent-warm",
    high: "--color-accent-danger",
    critical: "--color-accent-danger",
  };
  return map[level] ?? "--color-text-dim";
}

/**
 * Maps an update type slug to a display label.
 * @param {string} type - 'patch' | 'minor' | 'major'
 * @returns {string}
 */
export function formatUpdateType(type) {
  const map = { patch: "Patch", minor: "Minor", major: "Major" };
  return map[type] ?? type;
}

/**
 * Maps an ecosystem key to a human-readable display name.
 * @param {string} ecosystem
 * @returns {string}
 */
export function formatEcosystem(ecosystem) {
  const map = {
    node: "Node.js",
    python: "Python",
    rust: "Rust",
    go: "Go",
    ruby: "Ruby",
  };
  return map[ecosystem] ?? ecosystem;
}

/**
 * Maps a recommendation value to a short display label.
 * @param {string} rec - THUMBS_UP | THUMBS_DOWN | NEEDS_REVIEW
 * @returns {string}
 */
export function formatRecommendation(rec) {
  const map = {
    THUMBS_UP: "Approve",
    THUMBS_DOWN: "Hold",
    NEEDS_REVIEW: "Review",
  };
  return map[rec] ?? rec;
}

/**
 * Formats an ISO date string as a human-readable relative-time string.
 * Falls back to a locale date string for dates older than 30 days.
 * @param {string} isoDate
 * @returns {string}
 */
export function formatRelativeTime(isoDate) {
  const diffMs = Date.now() - new Date(isoDate).getTime();

  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;

  const days = Math.floor(hours / 24);
  if (days <= 30) return `${days} day${days === 1 ? "" : "s"} ago`;

  return new Date(isoDate).toLocaleDateString();
}

/**
 * Returns summary statistics for a single repository.
 * @param {{ updates?: Array<{ riskScore: number, advisories: unknown[] }> }} repo
 * @returns {{ totalUpdates: number, maxRisk: number, cveCount: number }}
 */
export function getRepoStats(repo) {
  const updates = repo.updates ?? [];
  return {
    totalUpdates: updates.length,
    maxRisk: updates.reduce((max, u) => Math.max(max, u.riskScore ?? 0), 0),
    cveCount: updates.reduce((n, u) => n + (u.advisories?.length ?? 0), 0),
  };
}

/**
 * Aggregates top-level statistics across the entire run report.
 * @param {{ repositories?: Array }} report
 * @returns {{ totalRepos: number, totalUpdates: number, totalCves: number, maxRisk: number }}
 */
export function getRunSummary(report) {
  const repos = report.repositories ?? [];
  let totalUpdates = 0;
  let totalCves = 0;
  let maxRisk = 0;

  for (const repo of repos) {
    const stats = getRepoStats(repo);
    totalUpdates += stats.totalUpdates;
    totalCves += stats.cveCount;
    maxRisk = Math.max(maxRisk, stats.maxRisk);
  }

  return { totalRepos: repos.length, totalUpdates, totalCves, maxRisk };
}

/**
 * Returns a copy of the updates array sorted by risk score, highest first.
 * Does not mutate the original array.
 * @param {Array<{ riskScore: number }>} updates
 * @returns {Array<{ riskScore: number }>}
 */
export function sortUpdatesByRisk(updates) {
  return [...updates].sort((a, b) => b.riskScore - a.riskScore);
}

/**
 * Flattens all updates from all repositories into a single array.
 * Each update is annotated with its source `repoName` and `ecosystem`.
 * @param {Array<{ name: string, ecosystem: string, updates?: Array }>} repositories
 * @returns {Array}
 */
export function flattenUpdates(repositories) {
  return repositories.flatMap((repo) =>
    (repo.updates ?? []).map((u) => ({
      ...u,
      repoName: repo.name,
      ecosystem: repo.ecosystem,
    }))
  );
}
