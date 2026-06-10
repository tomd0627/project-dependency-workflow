/**
 * @fileoverview All magic strings, numbers, and configuration keys.
 * Never import raw values from bot.config.json — use these constants
 * as the single source of truth for identifiers across the pipeline.
 */

// ── Pipeline stage names ──────────────────────────────────────────────────────
export const STAGE = /** @type {const} */ ({
  DISCOVER: "DISCOVER",
  SCAN: "SCAN",
  AUDIT: "AUDIT",
  ANALYZE: "ANALYZE",
  SCORE: "SCORE",
  NOTIFY: "NOTIFY",
  GATE: "GATE",
  BRANCH: "BRANCH",
  UPDATE: "UPDATE",
  QA: "QA",
  AUTOFIX: "AUTOFIX",
  PUSH: "PUSH",
  ROLLBACK: "ROLLBACK",
});

// ── Recommendation values ─────────────────────────────────────────────────────
export const RECOMMENDATION = /** @type {const} */ ({
  THUMBS_UP: "THUMBS_UP",
  THUMBS_DOWN: "THUMBS_DOWN",
  NEEDS_REVIEW: "NEEDS_REVIEW",
});

// ── Update classification ─────────────────────────────────────────────────────
export const UPDATE_TYPE = /** @type {const} */ ({
  PATCH: "patch",
  MINOR: "minor",
  MAJOR: "major",
});

// ── Ecosystem identifiers ─────────────────────────────────────────────────────
export const ECOSYSTEM = /** @type {const} */ ({
  NODE: "node",
  PYTHON: "python",
  RUST: "rust",
  GO: "go",
  RUBY: "ruby",
});

// ── Manifest filenames used for ecosystem detection ───────────────────────────
export const MANIFEST_FILE = /** @type {const} */ ({
  NODE: "package.json",
  PYTHON_REQUIREMENTS: "requirements.txt",
  PYTHON_PYPROJECT: "pyproject.toml",
  PYTHON_PIPFILE: "Pipfile",
  RUST: "Cargo.toml",
  GO: "go.mod",
  RUBY: "Gemfile",
});

// ── Risk score thresholds ─────────────────────────────────────────────────────
export const RISK_THRESHOLD = /** @type {const} */ ({
  AUTO_APPROVE_MAX: 30,
  MINOR_AUTO_APPROVE_MAX: 50,
  HIGH: 70,
  CRITICAL: 90,
});

// ── API configuration ─────────────────────────────────────────────────────────
export const API = /** @type {const} */ ({
  CLAUDE_MODEL: "claude-sonnet-4-6",
  CLAUDE_MAX_TOKENS: 1000,
  CLAUDE_TIMEOUT_MS: 30_000,
  GITHUB_GRAPHQL_URL: "https://api.github.com/graphql",
  MAX_RETRIES: 3,
  RETRY_BASE_DELAY_MS: 1_000,
  RETRY_MAX_DELAY_MS: 30_000,
});

// ── Gate / approval ───────────────────────────────────────────────────────────
export const GATE = /** @type {const} */ ({
  APPROVE_KEYWORD: "APPROVE",
  SKIP_KEYWORD: "SKIP",
  POLL_INTERVAL_MS: 5 * 60 * 1_000,
  DEFAULT_TIMEOUT_HOURS: 48,
});

// ── CI polling ────────────────────────────────────────────────────────────────
export const CI_POLL = /** @type {const} */ ({
  INTERVAL_MS: 5 * 60 * 1_000,
  MAX_DURATION_MS: 30 * 60 * 1_000,
});

// ── PR / branch naming ────────────────────────────────────────────────────────
export const PR = /** @type {const} */ ({
  BRANCH_PREFIX: "deps/update-",
  TITLE_PREFIX: "deps: automated dependency updates",
  LABELS: ["dependencies", "automated"],
  SECURITY_LABEL: "security",
});

// ── QA ────────────────────────────────────────────────────────────────────────
export const QA = /** @type {const} */ ({
  UNVERIFIABLE_FLAG: "UNVERIFIABLE",
  DEFAULT_TIMEOUT_MS: 5 * 60 * 1_000,
});

// ── Registry URLs ─────────────────────────────────────────────────────────────
export const PYPI = /** @type {const} */ ({
  REGISTRY_URL: "https://pypi.org/pypi",
});

export const CRATES = /** @type {const} */ ({
  REGISTRY_URL: "https://crates.io/api/v1/crates",
  /** crates.io requires a descriptive User-Agent on all API calls. */
  USER_AGENT: "dep-bot/1.0 (https://github.com/tomdeluca/project-dependency-workflow)",
});

export const GO_PROXY = /** @type {const} */ ({
  URL: "https://proxy.golang.org",
});

export const RUBYGEMS = /** @type {const} */ ({
  REGISTRY_URL: "https://rubygems.org/api/v1/gems",
});

// ── npm registry ─────────────────────────────────────────────────────────────
export const NPM = /** @type {const} */ ({
  REGISTRY_URL: "https://registry.npmjs.org",
  /** Max parallel version fetches to avoid hammering the registry */
  CONCURRENT_CHECKS: 5,
  /** Version prefixes to strip before semver comparison */
  VERSION_PREFIX_RE: /^[~^>=<\s]*/,
  /** Version prefixes that indicate non-registry sources — skip these */
  NON_REGISTRY_RE: /^(file:|git[+@]|github:|bitbucket:|gitlab:|workspace:|link:|portal:|https?:\/\/|\*$)/,
});

// ── Cache ─────────────────────────────────────────────────────────────────────
export const CACHE = /** @type {const} */ ({
  DIR: ".cache",
  CHANGELOG_FILE: ".cache/changelogs.json",
  DEFAULT_TTL_HOURS: 24,
});

// ── Logger ────────────────────────────────────────────────────────────────────
export const LOG_LEVEL = /** @type {const} */ ({
  TRACE: "trace",
  DEBUG: "debug",
  INFO: "info",
  WARN: "warn",
  ERROR: "error",
  FATAL: "fatal",
});

// ── GitHub Advisory Database — ecosystem enum values ─────────────────────────
// Maps internal ECOSYSTEM keys to the SecurityAdvisoryEcosystem GraphQL enum.
export const ADVISORY_ECOSYSTEM = /** @type {const} */ ({
  node: "NPM",
  python: "PIP",
  rust: "RUST",
  go: "GO",
  ruby: "RUBYGEMS",
});

// ── Notifier ──────────────────────────────────────────────────────────────────
export const NOTIFIER = /** @type {const} */ ({
  ISSUE_TITLE_PREFIX: "deps: dependency update report",
  /** Discord enforces a 2 000-character limit on message content. */
  DISCORD_CONTENT_LIMIT: 2_000,
  NTFY_BASE_URL: "https://ntfy.sh",
  /** Warn this many days before the GitHub token expires. */
  PAT_EXPIRY_WARN_DAYS: 14,
});

// ── Dry run ───────────────────────────────────────────────────────────────────
export const DRY_RUN_PREFIX = "[DRY RUN]";
