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

import { logger } from "./logger.js";
import { ECOSYSTEM, MANIFEST_FILE, NPM, UPDATE_TYPE } from "./constants.js";

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

// ── Ecosystem detection ───────────────────────────────────────────────────────

/**
 * Detects which package ecosystems are present in a repository by probing for
 * known manifest files via the GitHub Contents API.
 * A repository may contain multiple ecosystems (polyglot).
 *
 * @param {import('@octokit/rest').Octokit} octokit
 * @param {string} owner
 * @param {string} repo
 * @returns {Promise<Array<{ ecosystem: string; manifest: string }>>}
 */
export async function detectEcosystems(octokit, owner, repo) {
  /** @type {Array<{ ecosystem: string; manifest: string }>} */
  const NODE_MANIFESTS = [MANIFEST_FILE.NODE];

  // MVP: Node.js only. Additional ecosystems added in Step 9.
  const checks = NODE_MANIFESTS.map((manifest) => async () => {
    const content = await fetchManifestContent(octokit, owner, repo, manifest);
    return content !== null ? { ecosystem: ECOSYSTEM.NODE, manifest } : null;
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
 * @returns {Promise<ScanResult[]>}
 */
export async function scanRepository(octokit, owner, repo) {
  const ecosystems = await detectEcosystems(octokit, owner, repo);

  if (ecosystems.length === 0) {
    logger.info({ owner, repo }, "No recognized ecosystems found — skipping scan");
    return [];
  }

  logger.info({ owner, repo, ecosystems: ecosystems.map((e) => e.ecosystem) }, "Scanning detected ecosystems");

  const results = await Promise.allSettled(
    ecosystems.map(({ ecosystem }) => {
      if (ecosystem === ECOSYSTEM.NODE) return scanNodeEcosystem(octokit, owner, repo);
      // Additional ecosystems (Python, Rust, Go, Ruby) added in Step 9
      return Promise.resolve({ ecosystem, manifest: "", outdated: [] });
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
