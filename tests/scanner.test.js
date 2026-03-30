/**
 * @fileoverview Tests for the scanner module.
 */

import { jest } from "@jest/globals";
import {
  classifyUpdateType,
  detectEcosystems,
  fetchLatestNpmVersion,
  fetchManifestContent,
  isNewer,
  parsePackageJsonDependencies,
  scanNodeEcosystem,
  scanRepository,
  stripVersionPrefix,
} from "../src/scanner.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Builds a minimal mock Octokit whose getContent resolves/rejects on demand. */
const makeOctokit = (getContentImpl) => ({
  rest: { repos: { getContent: jest.fn().mockImplementation(getContentImpl) } },
});

/** Returns a GitHub Contents API response shape for a given file payload. */
const makeContentResponse = (text) => ({
  data: { type: "file", content: Buffer.from(text).toString("base64"), encoding: "base64" },
});

/** Returns a minimal package.json string with the given deps. */
const makePackageJson = ({ dependencies = {}, devDependencies = {} } = {}) =>
  JSON.stringify({ name: "test-pkg", version: "1.0.0", dependencies, devDependencies });

/** Creates a mock fetch response. */
const makeJsonResponse = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: jest.fn().mockResolvedValue(body),
});

// ── stripVersionPrefix ────────────────────────────────────────────────────────

describe("stripVersionPrefix", () => {
  it.each([
    ["^1.2.3", "1.2.3"],
    ["~1.2.3", "1.2.3"],
    [">=1.2.3", "1.2.3"],
    [">1.2.3", "1.2.3"],
    ["<=1.2.3", "1.2.3"],
    ["=1.2.3", "1.2.3"],
    ["1.2.3", "1.2.3"],
    ["^0.0.1", "0.0.1"],
  ])("strips prefix from %s → %s", (input, expected) => {
    expect(stripVersionPrefix(input)).toBe(expected);
  });

  it("strips pre-release tag from version", () => {
    expect(stripVersionPrefix("1.2.3-beta.1")).toBe("1.2.3");
  });

  it("returns the version unchanged when there is no prefix", () => {
    expect(stripVersionPrefix("4.17.21")).toBe("4.17.21");
  });
});

// ── classifyUpdateType ────────────────────────────────────────────────────────

describe("classifyUpdateType", () => {
  it.each([
    ["1.0.0", "1.0.1", "patch"],
    ["1.0.9", "1.0.10", "patch"],
    ["1.0.0", "1.1.0", "minor"],
    ["1.9.9", "1.10.0", "minor"],
    ["1.0.0", "2.0.0", "major"],
    ["0.9.9", "1.0.0", "major"],
  ])("%s → %s is %s", (current, latest, expected) => {
    expect(classifyUpdateType(current, latest)).toBe(expected);
  });
});

// ── isNewer ───────────────────────────────────────────────────────────────────

describe("isNewer", () => {
  it("returns true when latest patch is higher", () => {
    expect(isNewer("1.0.0", "1.0.1")).toBe(true);
  });

  it("returns true when latest minor is higher", () => {
    expect(isNewer("1.0.0", "1.1.0")).toBe(true);
  });

  it("returns true when latest major is higher", () => {
    expect(isNewer("1.0.0", "2.0.0")).toBe(true);
  });

  it("returns false when versions are identical", () => {
    expect(isNewer("1.2.3", "1.2.3")).toBe(false);
  });

  it("returns false when latest is older", () => {
    expect(isNewer("2.0.0", "1.9.9")).toBe(false);
  });

  it("returns false when latest minor is lower", () => {
    expect(isNewer("1.5.0", "1.4.9")).toBe(false);
  });
});

// ── parsePackageJsonDependencies ──────────────────────────────────────────────

describe("parsePackageJsonDependencies", () => {
  it("parses dependencies", () => {
    const raw = makePackageJson({ dependencies: { lodash: "^4.17.20" } });
    const result = parsePackageJsonDependencies(raw);
    expect(result.get("lodash")).toBe("4.17.20");
  });

  it("parses devDependencies", () => {
    const raw = makePackageJson({ devDependencies: { jest: "^29.0.0" } });
    const result = parsePackageJsonDependencies(raw);
    expect(result.get("jest")).toBe("29.0.0");
  });

  it("merges dependencies and devDependencies", () => {
    const raw = makePackageJson({
      dependencies: { lodash: "4.17.20" },
      devDependencies: { jest: "29.0.0" },
    });
    const result = parsePackageJsonDependencies(raw);
    expect(result.size).toBe(2);
  });

  it("skips workspace: specifiers", () => {
    const raw = makePackageJson({ dependencies: { "my-local": "workspace:*" } });
    expect(parsePackageJsonDependencies(raw).size).toBe(0);
  });

  it("skips file: specifiers", () => {
    const raw = makePackageJson({ dependencies: { local: "file:../local" } });
    expect(parsePackageJsonDependencies(raw).size).toBe(0);
  });

  it("skips git+ specifiers", () => {
    const raw = makePackageJson({ dependencies: { pkg: "git+https://github.com/a/b.git" } });
    expect(parsePackageJsonDependencies(raw).size).toBe(0);
  });

  it("skips bare wildcard *", () => {
    const raw = makePackageJson({ dependencies: { any: "*" } });
    expect(parsePackageJsonDependencies(raw).size).toBe(0);
  });

  it("returns empty map when no dependencies are declared", () => {
    const raw = JSON.stringify({ name: "empty" });
    expect(parsePackageJsonDependencies(raw).size).toBe(0);
  });

  it("devDependencies overwrite same-named dependencies (last-write-wins merge)", () => {
    const raw = makePackageJson({
      dependencies: { shared: "1.0.0" },
      devDependencies: { shared: "2.0.0" },
    });
    const result = parsePackageJsonDependencies(raw);
    expect(result.get("shared")).toBe("2.0.0");
  });
});

// ── fetchManifestContent ──────────────────────────────────────────────────────

describe("fetchManifestContent", () => {
  it("decodes and returns base64 file content", async () => {
    const text = '{"name":"test"}';
    const octokit = makeOctokit(() => Promise.resolve(makeContentResponse(text)));
    const result = await fetchManifestContent(octokit, "owner", "repo", "package.json");
    expect(result).toBe(text);
  });

  it("returns null when the file does not exist (404)", async () => {
    const error = Object.assign(new Error("Not Found"), { status: 404 });
    const octokit = makeOctokit(() => Promise.reject(error));
    const result = await fetchManifestContent(octokit, "owner", "repo", "package.json");
    expect(result).toBeNull();
  });

  it("returns null when the path resolves to a directory", async () => {
    const octokit = makeOctokit(() => Promise.resolve({ data: [{ type: "dir" }] }));
    const result = await fetchManifestContent(octokit, "owner", "repo", "src");
    expect(result).toBeNull();
  });

  it("throws a descriptive error for non-404 API failures", async () => {
    const error = Object.assign(new Error("Server Error"), { status: 500 });
    const octokit = makeOctokit(() => Promise.reject(error));
    await expect(fetchManifestContent(octokit, "owner", "repo", "package.json")).rejects.toThrow(
      "Failed to fetch package.json from owner/repo"
    );
  });
});

// ── fetchLatestNpmVersion ─────────────────────────────────────────────────────

describe("fetchLatestNpmVersion", () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("returns the version from the npm registry", async () => {
    global.fetch = jest.fn().mockResolvedValue(makeJsonResponse({ version: "4.17.21" }));
    const result = await fetchLatestNpmVersion("lodash");
    expect(result).toBe("4.17.21");
  });

  it("returns null for packages not found in the registry (404)", async () => {
    global.fetch = jest.fn().mockResolvedValue(makeJsonResponse({}, 404));
    const result = await fetchLatestNpmVersion("@private/pkg");
    expect(result).toBeNull();
  });

  it("throws a descriptive error for non-404 registry failures", async () => {
    global.fetch = jest.fn().mockResolvedValue(makeJsonResponse({}, 503));
    await expect(fetchLatestNpmVersion("lodash")).rejects.toThrow("npm registry returned 503");
  });

  it("encodes scoped package names correctly in the URL", async () => {
    global.fetch = jest.fn().mockResolvedValue(makeJsonResponse({ version: "1.0.0" }));
    await fetchLatestNpmVersion("@octokit/rest");
    expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining("%2F"));
  });
});

// ── detectEcosystems ──────────────────────────────────────────────────────────

describe("detectEcosystems", () => {
  it("detects Node.js when package.json is present", async () => {
    const notFound = Object.assign(new Error("Not Found"), { status: 404 });
    const octokit = makeOctokit((args) =>
      args.path === "package.json"
        ? Promise.resolve(makeContentResponse('{"name":"test"}'))
        : Promise.reject(notFound)
    );
    const result = await detectEcosystems(octokit, "owner", "repo");
    expect(result).toHaveLength(1);
    expect(result[0].ecosystem).toBe("node");
    expect(result[0].manifest).toBe("package.json");
  });

  it("returns empty array when no manifest files are found", async () => {
    const error = Object.assign(new Error("Not Found"), { status: 404 });
    const octokit = makeOctokit(() => Promise.reject(error));
    const result = await detectEcosystems(octokit, "owner", "repo");
    expect(result).toHaveLength(0);
  });
});

// ── scanNodeEcosystem ─────────────────────────────────────────────────────────

describe("scanNodeEcosystem", () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("returns outdated packages", async () => {
    const pkg = makePackageJson({ dependencies: { lodash: "^4.17.20" } });
    const octokit = makeOctokit(() => Promise.resolve(makeContentResponse(pkg)));
    global.fetch = jest.fn().mockResolvedValue(makeJsonResponse({ version: "4.17.21" }));

    const result = await scanNodeEcosystem(octokit, "owner", "repo");

    expect(result.ecosystem).toBe("node");
    expect(result.outdated).toHaveLength(1);
    expect(result.outdated[0].name).toBe("lodash");
    expect(result.outdated[0].current).toBe("4.17.20");
    expect(result.outdated[0].latest).toBe("4.17.21");
    expect(result.outdated[0].updateType).toBe("patch");
  });

  it("does not flag packages already at the latest version", async () => {
    const pkg = makePackageJson({ dependencies: { lodash: "4.17.21" } });
    const octokit = makeOctokit(() => Promise.resolve(makeContentResponse(pkg)));
    global.fetch = jest.fn().mockResolvedValue(makeJsonResponse({ version: "4.17.21" }));

    const result = await scanNodeEcosystem(octokit, "owner", "repo");
    expect(result.outdated).toHaveLength(0);
  });

  it("skips packages not found in the npm registry", async () => {
    const pkg = makePackageJson({ dependencies: { "private-pkg": "1.0.0" } });
    const octokit = makeOctokit(() => Promise.resolve(makeContentResponse(pkg)));
    global.fetch = jest.fn().mockResolvedValue(makeJsonResponse({}, 404));

    const result = await scanNodeEcosystem(octokit, "owner", "repo");
    expect(result.outdated).toHaveLength(0);
  });

  it("classifies major version bumps correctly", async () => {
    const pkg = makePackageJson({ dependencies: { react: "^17.0.2" } });
    const octokit = makeOctokit(() => Promise.resolve(makeContentResponse(pkg)));
    global.fetch = jest.fn().mockResolvedValue(makeJsonResponse({ version: "18.3.1" }));

    const result = await scanNodeEcosystem(octokit, "owner", "repo");
    expect(result.outdated[0].updateType).toBe("major");
  });

  it("throws when package.json is not found", async () => {
    const error = Object.assign(new Error("Not Found"), { status: 404 });
    const octokit = makeOctokit(() => Promise.reject(error));
    await expect(scanNodeEcosystem(octokit, "owner", "repo")).rejects.toThrow(
      "package.json not found"
    );
  });
});

// ── scanRepository ────────────────────────────────────────────────────────────

describe("scanRepository", () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("returns scan results for detected ecosystems", async () => {
    const pkg = makePackageJson({ dependencies: { lodash: "4.17.20" } });
    const notFound = Object.assign(new Error("Not Found"), { status: 404 });
    const octokit = makeOctokit((args) =>
      args.path === "package.json"
        ? Promise.resolve(makeContentResponse(pkg))
        : Promise.reject(notFound)
    );
    global.fetch = jest.fn().mockResolvedValue(makeJsonResponse({ version: "4.17.21" }));

    const results = await scanRepository(octokit, "owner", "repo");
    expect(results).toHaveLength(1);
    expect(results[0].ecosystem).toBe("node");
  });

  it("returns empty array when no ecosystems are detected", async () => {
    const error = Object.assign(new Error("Not Found"), { status: 404 });
    const octokit = makeOctokit(() => Promise.reject(error));
    const results = await scanRepository(octokit, "owner", "repo");
    expect(results).toHaveLength(0);
  });
});
