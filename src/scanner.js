/**
 * @fileoverview Ecosystem detection and outdated dependency scanning.
 *
 * Scan strategy (Node.js MVP):
 *  1. Use the GitHub Contents API to read manifest files — no local clone required
 *     at scan time. Cloning is deferred to the UPDATE stage where changes are needed.
 *  2. Compare declared versions against the npm registry for latest releases.
 *  3. Version checks run in concurrent batches to balance speed against registry
 *     politeness (NPM.CONCURRENT_CHECKS at a time).
 *
 * Non-registry version specifiers (file:, git+, workspace:, *) are silently
 * skipped — they cannot be compared against a registry.
 */

import { CRATES, ECOSYSTEM, GO_PROXY, MANIFEST_FILE, NPM, PYPI, RUBYGEMS, UPDATE_TYPE } from "./constants.js";
import { logger } from "./logger.js";

/** @typedef {{ name: string; current: string; latest: string; updateType: string; ecosystem: string }} OutdatedPackage */
/** @typedef {{ ecosystem: string; manifest: string; outdated: OutdatedPackage[] }} ScanResult */

// ── Pure helpers ──────────────────────────────────────────────────────────────

/**
 * Removes range prefixes (^, ~, >=, etc.) from a version string so it can be
 * passed to semver comparison logic.
 *
 * @param {string} version - Raw version string from a manifest file
 * @returns {string} Clean version number, e.g. "1.2.3"
 */
export function stripVersionPrefix(version) {
  return version.replace(NPM.VERSION_PREFIX_RE, "").split("-")[0].trim();
}

/**
 * Classifies the magnitude of an upgrade by comparing major, minor, and patch
 * segments of two clean (prefix-free) semver strings.
 *
 * @param {string} current - Current version without prefix, e.g. "1.2.3"
 * @param {string} latest  - Latest version without prefix, e.g. "2.0.0"
 * @returns {'patch' | 'minor' | 'major'}
 */
export function classifyUpdateType(current, latest) {
  const parse = (v) => v.split(".").map((n) => parseInt(n, 10) || 0);
  const [cMaj, cMin] = parse(current);
  const [lMaj, lMin] = parse(latest);

  if (lMaj !== cMaj) return UPDATE_TYPE.MAJOR;
  if (lMin !== cMin) return UPDATE_TYPE.MINOR;
  return UPDATE_TYPE.PATCH;
}

/**
 * Returns true when `latest` is a strictly newer release than `current`.
 * Both inputs must be prefix-free semver strings.
 *
 * @param {string} current - e.g. "1.2.3"
 * @param {string} latest  - e.g. "1.3.0"
 * @returns {boolean}
 */
export function isNewer(current, latest) {
  const parse = (v) => v.split(".").map((n) => parseInt(n, 10) || 0);
  const [cMaj, cMin, cPatch] = parse(current);
  const [lMaj, lMin, lPatch] = parse(latest);

  if (lMaj !== cMaj) return lMaj > cMaj;
  if (lMin !== cMin) return lMin > cMin;
  return lPatch > cPatch;
}

/**
 * Merges `dependencies` and `devDependencies` from a parsed package.json object
 * into a flat map, stripping version prefixes and filtering out non-registry
 * specifiers (file:, git+, workspace:, etc.).
 *
 * @param {string} rawJson - Raw package.json file contents
 * @returns {Map<string, string>} packageName → clean current version
 */
export function parsePackageJsonDependencies(rawJson) {
  /** @type {{ dependencies?: Record<string,string>; devDependencies?: Record<string,string> }} */
  const pkg = JSON.parse(rawJson);
  const merged = { ...pkg.dependencies, ...pkg.devDependencies };
  const result = new Map();

  for (const [name, rawVersion] of Object.entries(merged)) {
    if (NPM.NON_REGISTRY_RE.test(rawVersion)) {
      logger.debug({ name, rawVersion }, "Skipping non-registry dependency");
      continue;
    }
    result.set(name, stripVersionPrefix(rawVersion));
  }

  return result;
}

// ── GitHub Contents API ───────────────────────────────────────────────────────

/**
 * Fetches the decoded text content of a single file from a GitHub repository.
 * Returns null if the file does not exist (404) rather than throwing.
 *
 * @param {import('@octokit/rest').Octokit} octokit
 * @param {string} owner
 * @param {string} repo
 * @param {string} filePath - Path relative to repo root, e.g. "package.json"
 * @returns {Promise<string | null>}
 */
export async function fetchManifestContent(octokit, owner, repo, filePath) {
  try {
    const { data } = await octokit.rest.repos.getContent({ owner, repo, path: filePath });

    if (Array.isArray(data) || data.type !== "file") {
      logger.warn({ owner, repo, filePath }, "Expected a file but received a directory entry");
      return null;
    }

    return Buffer.from(data.content, "base64").toString("utf8");
  } catch (error) {
    if (error.status === 404) return null;
    throw new Error(
      `Failed to fetch ${filePath} from ${owner}/${repo}: ${error.message}`
    );
  }
}

// ── npm registry ──────────────────────────────────────────────────────────────

/**
 * Fetches the latest published version of an npm package from the registry.
 * Returns null for scoped-private or unlisted packages rather than throwing.
 *
 * @param {string} packageName - e.g. "lodash" or "@octokit/rest"
 * @returns {Promise<string | null>}
 */
export async function fetchLatestNpmVersion(packageName) {
  const encoded = packageName.replace("/", "%2F");
  const url = `${NPM.REGISTRY_URL}/${encoded}/latest`;

  const response = await fetch(url);

  if (response.status === 404) {
    logger.debug({ packageName }, "Package not found in npm registry — skipping");
    return null;
  }

  if (!response.ok) {
    throw new Error(
      `npm registry returned ${response.status} for package "${packageName}"`
    );
  }

  const data = await response.json();
  return data.version ?? null;
}

// ── Concurrency helper ────────────────────────────────────────────────────────

/**
 * Processes an array of async tasks in fixed-size sequential batches.
 * Within each batch, tasks run concurrently. Batches run one at a time.
 *
 * @template T
 * @param {Array<() => Promise<T>>} tasks
 * @param {number} batchSize
 * @returns {Promise<Array<PromiseSettledResult<T>>>}
 */
async function runInBatches(tasks, batchSize) {
  const results = [];
  for (let i = 0; i < tasks.length; i += batchSize) {
    const batch = tasks.slice(i, i + batchSize).map((fn) => fn());
    const settled = await Promise.allSettled(batch);
    results.push(...settled);
  }
  return results;
}

// ── Python manifest parsers ───────────────────────────────────────────────────

/**
 * Parses a requirements.txt file into a name → version map.
 * Accepts pinned (`==`) and compatible (`~=`) specifiers; skips unpinned lines.
 *
 * @param {string} rawText
 * @returns {Map<string, string>}
 */
export function parsePythonRequirements(rawText) {
  const result = new Map();
  for (const rawLine of rawText.split("\n")) {
    const line = rawLine.split("#")[0].trim();
    if (!line || line.startsWith("-")) continue;
    const match = line.match(/^([A-Za-z0-9][\w.-]*)\s*(?:==|~=|>=|<=|!=|>|<)\s*([0-9][^\s,;]*)/);
    if (match) result.set(match[1].toLowerCase(), match[2].trim());
  }
  return result;
}

/**
 * Parses a pyproject.toml file — handles both PEP 621 `[project].dependencies`
 * and Poetry `[tool.poetry.dependencies]` formats.
 *
 * @param {string} rawText
 * @returns {Map<string, string>}
 */
export function parsePyprojectToml(rawText) {
  const result = new Map();

  // PEP 621: dependencies = ["requests>=2.28.0", ...]
  const pep621 = rawText.match(/\[project\][\s\S]*?dependencies\s*=\s*\[([\s\S]*?)\]/);
  if (pep621) {
    for (const m of pep621[1].matchAll(/"([^"]+)"/g)) {
      const req = m[1].match(/^([A-Za-z0-9][\w.-]*)\s*(?:==|~=|>=|<=|!=|>|<)\s*([0-9][^\s,;]*)/);
      if (req) result.set(req[1].toLowerCase(), req[2].trim());
    }
  }

  // Poetry: [tool.poetry.dependencies] with name = "^version" pairs
  const poetry = rawText.match(/\[tool\.poetry\.dependencies\]([\s\S]*?)(?=\[|$)/);
  if (poetry) {
    for (const line of poetry[1].split("\n")) {
      const kv = line.trim().match(/^([\w-]+)\s*=\s*"([^"]+)"/);
      if (kv && kv[1] !== "python") {
        result.set(kv[1].toLowerCase(), kv[2].replace(/^[\^~>=<!]+/, "").trim());
      }
    }
  }

  return result;
}

/**
 * Parses a Pipfile `[packages]` section into a name → version map.
 * Skips wildcard (`*`) pinned deps — no version to compare.
 *
 * @param {string} rawText
 * @returns {Map<string, string>}
 */
export function parsePipfile(rawText) {
  const result = new Map();
  const section = rawText.match(/\[packages\]([\s\S]*?)(?=\[|$)/);
  if (!section) return result;

  for (const line of section[1].split("\n")) {
    const kv = line.trim().match(/^([\w-]+)\s*=\s*"([^"]+)"/);
    if (!kv || kv[2] === "*") continue;
    const version = kv[2].replace(/^[\^~>=<!= ]+/, "").trim();
    if (version) result.set(kv[1].toLowerCase(), version);
  }

  return result;
}

// ── Rust / Cargo.toml parser ──────────────────────────────────────────────────

/**
 * Parses a Cargo.toml file's `[dependencies]` and `[dev-dependencies]` sections.
 * Handles both simple (`name = "1.0"`) and inline-table
 * (`name = { version = "1.0", ... }`) formats.
 *
 * @param {string} rawText
 * @returns {Map<string, string>}
 */
export function parseCargoToml(rawText) {
  const result = new Map();
  let inDeps = false;

  for (const line of rawText.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[")) {
      inDeps = /^\[(?:dev-)?dependencies\]/.test(trimmed);
      continue;
    }
    if (!inDeps || !trimmed || trimmed.startsWith("#")) continue;

    // Simple: serde = "1.0"
    const simple = trimmed.match(/^([\w-]+)\s*=\s*"([^"]+)"/);
    if (simple) { result.set(simple[1], simple[2]); continue; }

    // Inline table: tokio = { version = "1.28", features = [...] }
    const table = trimmed.match(/^([\w-]+)\s*=\s*\{[^}]*version\s*=\s*"([^"]+)"/);
    if (table) result.set(table[1], table[2]);
  }

  return result;
}

// ── Go / go.mod parser ────────────────────────────────────────────────────────

/**
 * Parses a go.mod file and returns a module-path → version map.
 * Handles both block `require (...)` and single-line `require` forms.
 * Versions are stored without the `v` prefix.
 *
 * @param {string} rawText
 * @returns {Map<string, string>}
 */
export function parseGoMod(rawText) {
  const result = new Map();
  const lines = [];

  const block = rawText.match(/require\s*\(([\s\S]*?)\)/);
  if (block) lines.push(...block[1].split("\n"));

  for (const line of rawText.split("\n")) {
    if (/^require\s+\S/.test(line)) lines.push(line.replace(/^require\s+/, ""));
  }

  for (const line of lines) {
    const trimmed = line.replace(/\/\/.*$/, "").trim();
    const match = trimmed.match(/^(\S+)\s+v([^\s]+)/);
    if (match) result.set(match[1], match[2]); // version stored without "v"
  }

  return result;
}

// ── Ruby / Gemfile parser ─────────────────────────────────────────────────────

/**
 * Parses a Gemfile and returns a gem-name → version map.
 * Only includes gems that declare an explicit version constraint.
 *
 * @param {string} rawText
 * @returns {Map<string, string>}
 */
export function parseGemfile(rawText) {
  const result = new Map();

  for (const rawLine of rawText.split("\n")) {
    const line = rawLine.split("#")[0].trim();
    const match = line.match(/^gem\s+['"]([^'"]+)['"]\s*,\s*['"](?:~>|>=|<=|=|!=|>|<)\s*([0-9][^'"]*)['"]/);
    if (match) result.set(match[1], match[2].trim());
  }

  return result;
}

// ── Registry fetch helpers ────────────────────────────────────────────────────

/**
 * Fetches the latest version of a Python package from PyPI.
 *
 * @param {string} packageName
 * @returns {Promise<string | null>}
 */
export async function fetchLatestPypiVersion(packageName) {
  const response = await fetch(`${PYPI.REGISTRY_URL}/${packageName}/json`);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`PyPI returned ${response.status} for "${packageName}"`);
  const data = await response.json();
  return data.info?.version ?? null;
}

/**
 * Fetches the latest version of a Rust crate from crates.io.
 *
 * @param {string} crateName
 * @returns {Promise<string | null>}
 */
export async function fetchLatestCratesVersion(crateName) {
  const response = await fetch(`${CRATES.REGISTRY_URL}/${crateName}`, {
    headers: { "User-Agent": CRATES.USER_AGENT },
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`crates.io returned ${response.status} for "${crateName}"`);
  const data = await response.json();
  return data.crate?.newest_version ?? null;
}

/**
 * Fetches the latest version of a Go module from the Go module proxy.
 * Returns the version without the `v` prefix for consistent semver comparison.
 *
 * @param {string} modulePath - e.g. "github.com/gin-gonic/gin"
 * @returns {Promise<string | null>}
 */
export async function fetchLatestGoVersion(modulePath) {
  // Go proxy requires lowercase module paths; capital letters use "!" escaping.
  const encoded = modulePath.replace(/[A-Z]/g, (c) => `!${c.toLowerCase()}`);
  const response = await fetch(`${GO_PROXY.URL}/${encoded}/@latest`);
  if (response.status === 404 || response.status === 410) return null;
  if (!response.ok) throw new Error(`Go proxy returned ${response.status} for "${modulePath}"`);
  const data = await response.json();
  return data.Version ? data.Version.replace(/^v/, "") : null;
}

/**
 * Fetches the latest version of a Ruby gem from RubyGems.
 *
 * @param {string} gemName
 * @returns {Promise<string | null>}
 */
export async function fetchLatestGemVersion(gemName) {
  const response = await fetch(`${RUBYGEMS.REGISTRY_URL}/${gemName}.json`);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`RubyGems returned ${response.status} for "${gemName}"`);
  const data = await response.json();
  return data.version ?? null;
}

// ── Generic ecosystem scanner ─────────────────────────────────────────────────

/**
 * Shared scanning logic for all ecosystems.
 * Fetches the manifest, parses dependencies, queries the registry concurrently,
 * and returns a ScanResult with all outdated packages.
 *
 * @param {object} params
 * @param {import('@octokit/rest').Octokit} params.octokit
 * @param {string} params.owner
 * @param {string} params.repo
 * @param {string} params.manifest
 * @param {string} params.ecosystem
 * @param {(raw: string) => Map<string, string>} params.parseDeps
 * @param {(name: string) => Promise<string | null>} params.fetchLatest
 * @returns {Promise<ScanResult>}
 */
async function scanEcosystem({ octokit, owner, repo, manifest, ecosystem, parseDeps, fetchLatest }) {
  const rawText = await fetchManifestContent(octokit, owner, repo, manifest);
  if (!rawText) throw new Error(`${manifest} not found in ${owner}/${repo}`);

  const deps = parseDeps(rawText);
  logger.info({ owner, repo, ecosystem, depCount: deps.size }, "Checking versions");

  const packageNames = [...deps.keys()];
  const tasks = packageNames.map((name) => async () => ({
    name,
    current: /** @type {string} */ (deps.get(name)),
    latest: await fetchLatest(name),
  }));

  const settled = await runInBatches(tasks, NPM.CONCURRENT_CHECKS);
  /** @type {OutdatedPackage[]} */
  const outdated = [];

  for (let i = 0; i < packageNames.length; i++) {
    const result = settled[i];
    if (result.status === "rejected") {
      logger.warn({ package: packageNames[i], reason: result.reason?.message }, "Version check failed — skipping");
      continue;
    }
    const { name, current, latest } = result.value;
    if (!latest || !current || !isNewer(current, latest)) continue;
    outdated.push({ name, current, latest, updateType: classifyUpdateType(current, latest), ecosystem });
  }

  logger.info({ owner, repo, ecosystem, outdated: outdated.length }, `${ecosystem} scan complete`);
  return { ecosystem, manifest, outdated };
}

// ── Per-ecosystem scanners ────────────────────────────────────────────────────

/**
 * Scans a Python repository using requirements.txt, pyproject.toml, or Pipfile.
 *
 * @param {import('@octokit/rest').Octokit} octokit
 * @param {string} owner
 * @param {string} repo
 * @param {string} [manifest]
 * @returns {Promise<ScanResult>}
 */
export async function scanPythonEcosystem(octokit, owner, repo, manifest = MANIFEST_FILE.PYTHON_REQUIREMENTS) {
  const parsers = {
    [MANIFEST_FILE.PYTHON_REQUIREMENTS]: parsePythonRequirements,
    [MANIFEST_FILE.PYTHON_PYPROJECT]: parsePyprojectToml,
    [MANIFEST_FILE.PYTHON_PIPFILE]: parsePipfile,
  };
  return scanEcosystem({
    octokit, owner, repo, manifest,
    ecosystem: ECOSYSTEM.PYTHON,
    parseDeps: parsers[manifest] ?? parsePythonRequirements,
    fetchLatest: fetchLatestPypiVersion,
  });
}

/**
 * Scans a Rust repository using Cargo.toml.
 *
 * @param {import('@octokit/rest').Octokit} octokit
 * @param {string} owner
 * @param {string} repo
 * @returns {Promise<ScanResult>}
 */
export async function scanRustEcosystem(octokit, owner, repo) {
  return scanEcosystem({
    octokit, owner, repo, manifest: MANIFEST_FILE.RUST,
    ecosystem: ECOSYSTEM.RUST,
    parseDeps: parseCargoToml,
    fetchLatest: fetchLatestCratesVersion,
  });
}

/**
 * Scans a Go repository using go.mod.
 *
 * @param {import('@octokit/rest').Octokit} octokit
 * @param {string} owner
 * @param {string} repo
 * @returns {Promise<ScanResult>}
 */
export async function scanGoEcosystem(octokit, owner, repo) {
  return scanEcosystem({
    octokit, owner, repo, manifest: MANIFEST_FILE.GO,
    ecosystem: ECOSYSTEM.GO,
    parseDeps: parseGoMod,
    fetchLatest: fetchLatestGoVersion,
  });
}

/**
 * Scans a Ruby repository using Gemfile.
 *
 * @param {import('@octokit/rest').Octokit} octokit
 * @param {string} owner
 * @param {string} repo
 * @returns {Promise<ScanResult>}
 */
export async function scanRubyEcosystem(octokit, owner, repo) {
  return scanEcosystem({
    octokit, owner, repo, manifest: MANIFEST_FILE.RUBY,
    ecosystem: ECOSYSTEM.RUBY,
    parseDeps: parseGemfile,
    fetchLatest: fetchLatestGemVersion,
  });
}

// ── Ecosystem detection ───────────────────────────────────────────────────────

/**
 * Each entry lists the manifests to probe for an ecosystem, in priority order.
 * The first manifest found wins — avoids duplicate results in polyglot repos.
 */
const ECOSYSTEM_CHECKS = [
  { ecosystem: ECOSYSTEM.NODE,   manifests: [MANIFEST_FILE.NODE] },
  { ecosystem: ECOSYSTEM.PYTHON, manifests: [MANIFEST_FILE.PYTHON_REQUIREMENTS, MANIFEST_FILE.PYTHON_PYPROJECT, MANIFEST_FILE.PYTHON_PIPFILE] },
  { ecosystem: ECOSYSTEM.RUST,   manifests: [MANIFEST_FILE.RUST] },
  { ecosystem: ECOSYSTEM.GO,     manifests: [MANIFEST_FILE.GO] },
  { ecosystem: ECOSYSTEM.RUBY,   manifests: [MANIFEST_FILE.RUBY] },
];

/**
 * Detects which package ecosystems are present in a repository by probing for
 * known manifest files via the GitHub Contents API.
 * Returns at most one entry per ecosystem even if multiple manifest files exist.
 *
 * @param {import('@octokit/rest').Octokit} octokit
 * @param {string} owner
 * @param {string} repo
 * @returns {Promise<Array<{ ecosystem: string; manifest: string }>>}
 */
export async function detectEcosystems(octokit, owner, repo, allowedEcosystems) {
  const checksToRun = allowedEcosystems
    ? ECOSYSTEM_CHECKS.filter(({ ecosystem }) => allowedEcosystems.includes(ecosystem))
    : ECOSYSTEM_CHECKS;

  const checks = checksToRun.map(({ ecosystem, manifests }) => async () => {
    for (const manifest of manifests) {
      const content = await fetchManifestContent(octokit, owner, repo, manifest);
      if (content !== null) return { ecosystem, manifest };
    }
    return null;
  });

  const settled = await runInBatches(checks, NPM.CONCURRENT_CHECKS);

  return settled
    .filter((r) => r.status === "fulfilled" && r.value !== null)
    .map((r) => /** @type {PromiseFulfilledResult<{ecosystem:string;manifest:string}>} */ (r).value);
}

// ── Node.js scanner ───────────────────────────────────────────────────────────

/**
 * Scans a Node.js repository for outdated npm dependencies.
 * Reads package.json via the GitHub Contents API, then queries the npm registry
 * for the latest version of each package.
 *
 * @param {import('@octokit/rest').Octokit} octokit
 * @param {string} owner
 * @param {string} repo
 * @returns {Promise<ScanResult>}
 */
export async function scanNodeEcosystem(octokit, owner, repo) {
  const rawJson = await fetchManifestContent(octokit, owner, repo, MANIFEST_FILE.NODE);
  if (!rawJson) {
    throw new Error(`package.json not found in ${owner}/${repo}`);
  }

  const deps = parsePackageJsonDependencies(rawJson);
  logger.info({ owner, repo, depCount: deps.size }, "Checking npm versions");

  const packageNames = [...deps.keys()];
  const tasks = packageNames.map((name) => async () => {
    const current = deps.get(name);
    const latest = await fetchLatestNpmVersion(name);
    return { name, current, latest };
  });

  const settled = await runInBatches(tasks, NPM.CONCURRENT_CHECKS);

  /** @type {OutdatedPackage[]} */
  const outdated = [];

  for (let i = 0; i < packageNames.length; i++) {
    const result = settled[i];
    if (result.status === "rejected") {
      logger.warn({ package: packageNames[i], reason: result.reason?.message }, "Version check failed — skipping");
      continue;
    }

    const { name, current, latest } = result.value;
    if (!latest || !isNewer(current, latest)) continue;

    outdated.push({
      name,
      current,
      latest,
      updateType: classifyUpdateType(current, latest),
      ecosystem: ECOSYSTEM.NODE,
    });
  }

  logger.info({ owner, repo, outdated: outdated.length }, "Node.js scan complete");
  return { ecosystem: ECOSYSTEM.NODE, manifest: MANIFEST_FILE.NODE, outdated };
}

// ── Public entrypoint ─────────────────────────────────────────────────────────

/**
 * Scans a repository for outdated dependencies across all detected ecosystems.
 * Returns one ScanResult per ecosystem found. Returns an empty array if no
 * known manifest files are present.
 *
 * @param {import('@octokit/rest').Octokit} octokit
 * @param {string} owner
 * @param {string} repo
 * @param {string[] | undefined} [allowedEcosystems] - If set, only probe for these ecosystems
 * @returns {Promise<ScanResult[]>}
 */
export async function scanRepository(octokit, owner, repo, allowedEcosystems) {
  const ecosystems = await detectEcosystems(octokit, owner, repo, allowedEcosystems);

  if (ecosystems.length === 0) {
    logger.info({ owner, repo }, "No recognized ecosystems found — skipping scan");
    return [];
  }

  logger.info({ owner, repo, ecosystems: ecosystems.map((e) => e.ecosystem) }, "Scanning detected ecosystems");

  const results = await Promise.allSettled(
    ecosystems.map(({ ecosystem, manifest }) => {
      if (ecosystem === ECOSYSTEM.NODE)   return scanNodeEcosystem(octokit, owner, repo);
      if (ecosystem === ECOSYSTEM.PYTHON) return scanPythonEcosystem(octokit, owner, repo, manifest);
      if (ecosystem === ECOSYSTEM.RUST)   return scanRustEcosystem(octokit, owner, repo);
      if (ecosystem === ECOSYSTEM.GO)     return scanGoEcosystem(octokit, owner, repo);
      if (ecosystem === ECOSYSTEM.RUBY)   return scanRubyEcosystem(octokit, owner, repo);
      return Promise.resolve({ ecosystem, manifest, outdated: [] });
    })
  );

  return results
    .filter((r) => {
      if (r.status === "rejected") {
        logger.error({ reason: r.reason?.message }, "Ecosystem scan failed");
        return false;
      }
      return true;
    })
    .map((r) => /** @type {PromiseFulfilledResult<ScanResult>} */ (r).value);
}
