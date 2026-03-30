/**
 * @fileoverview Tests for the non-Node.js ecosystem scanners added in Step 9.
 * Covers: parse helpers, registry fetch functions, per-ecosystem scan functions,
 * and the updated detectEcosystems multi-ecosystem detection.
 */

import { jest } from "@jest/globals";
import {
  detectEcosystems,
  fetchLatestCratesVersion,
  fetchLatestGemVersion,
  fetchLatestGoVersion,
  fetchLatestPypiVersion,
  parseCargoToml,
  parseGemfile,
  parseGoMod,
  parsePipfile,
  parsePyprojectToml,
  parsePythonRequirements,
  scanGoEcosystem,
  scanPythonEcosystem,
  scanRubyEcosystem,
  scanRustEcosystem,
} from "../src/scanner.js";

// ── Shared helpers ────────────────────────────────────────────────────────────

const makeOctokit = (getContentImpl) => ({
  rest: { repos: { getContent: jest.fn().mockImplementation(getContentImpl) } },
});

const makeContentResponse = (text) => ({
  data: { type: "file", content: Buffer.from(text).toString("base64"), encoding: "base64" },
});

const makeJsonResponse = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: jest.fn().mockResolvedValue(body),
});

const notFound = () => Promise.reject(Object.assign(new Error("Not Found"), { status: 404 }));

let originalFetch;
beforeEach(() => { originalFetch = global.fetch; });
afterEach(() => { global.fetch = originalFetch; });

// ── parsePythonRequirements ───────────────────────────────────────────────────

describe("parsePythonRequirements", () => {
  it("parses exact-pinned packages (==)", () => {
    const result = parsePythonRequirements("requests==2.28.0\n");
    expect(result.get("requests")).toBe("2.28.0");
  });

  it("parses compatible-release packages (~=)", () => {
    const result = parsePythonRequirements("numpy~=1.23.0\n");
    expect(result.get("numpy")).toBe("1.23.0");
  });

  it("parses >= specifiers", () => {
    const result = parsePythonRequirements("flask>=2.0.0\n");
    expect(result.get("flask")).toBe("2.0.0");
  });

  it("skips comment lines", () => {
    const result = parsePythonRequirements("# this is a comment\nrequests==2.28.0\n");
    expect(result.size).toBe(1);
  });

  it("skips lines without a version specifier", () => {
    const result = parsePythonRequirements("requests\n");
    expect(result.size).toBe(0);
  });

  it("skips -r and -c option lines", () => {
    const result = parsePythonRequirements("-r base.txt\nrequests==2.28.0\n");
    expect(result.size).toBe(1);
  });

  it("normalises package names to lowercase", () => {
    const result = parsePythonRequirements("Django==4.2.0\n");
    expect(result.has("django")).toBe(true);
  });
});

// ── parsePyprojectToml ────────────────────────────────────────────────────────

describe("parsePyprojectToml", () => {
  it("parses PEP 621 [project].dependencies array", () => {
    const toml = `[project]\ndependencies = [\n  "requests>=2.28.0",\n  "flask>=2.0.0",\n]\n`;
    const result = parsePyprojectToml(toml);
    expect(result.get("requests")).toBe("2.28.0");
    expect(result.get("flask")).toBe("2.0.0");
  });

  it("parses Poetry [tool.poetry.dependencies] key-value pairs", () => {
    const toml = `[tool.poetry.dependencies]\npython = "^3.10"\nrequests = "^2.28.0"\n`;
    const result = parsePyprojectToml(toml);
    expect(result.get("requests")).toBe("2.28.0");
    expect(result.has("python")).toBe(false);
  });

  it("strips Poetry ^ prefix from versions", () => {
    const toml = `[tool.poetry.dependencies]\nflask = "^2.3.0"\n`;
    const result = parsePyprojectToml(toml);
    expect(result.get("flask")).toBe("2.3.0");
  });

  it("returns empty map for unrecognised format", () => {
    expect(parsePyprojectToml("[build-system]\nrequires = []\n").size).toBe(0);
  });
});

// ── parsePipfile ──────────────────────────────────────────────────────────────

describe("parsePipfile", () => {
  it("parses pinned versions from [packages]", () => {
    const pipfile = `[packages]\nrequests = "==2.28.0"\n`;
    expect(parsePipfile(pipfile).get("requests")).toBe("2.28.0");
  });

  it("skips wildcard entries (*)", () => {
    const pipfile = `[packages]\nrequests = "*"\n`;
    expect(parsePipfile(pipfile).size).toBe(0);
  });

  it("returns empty map when [packages] section is absent", () => {
    expect(parsePipfile("[dev-packages]\nflake8 = \"*\"\n").size).toBe(0);
  });
});

// ── parseCargoToml ────────────────────────────────────────────────────────────

describe("parseCargoToml", () => {
  it("parses simple name = \"version\" entries", () => {
    const toml = `[dependencies]\nserde = "1.0"\n`;
    expect(parseCargoToml(toml).get("serde")).toBe("1.0");
  });

  it("parses inline table entries with version field", () => {
    const toml = `[dependencies]\ntokio = { version = "1.28", features = ["full"] }\n`;
    expect(parseCargoToml(toml).get("tokio")).toBe("1.28");
  });

  it("parses [dev-dependencies]", () => {
    const toml = `[dev-dependencies]\ncriterion = "0.5"\n`;
    expect(parseCargoToml(toml).get("criterion")).toBe("0.5");
  });

  it("ignores entries outside dependency sections", () => {
    const toml = `[package]\nname = "my-crate"\n\n[dependencies]\nserde = "1.0"\n`;
    const result = parseCargoToml(toml);
    expect(result.has("name")).toBe(false);
    expect(result.get("serde")).toBe("1.0");
  });

  it("returns empty map when no dependency sections exist", () => {
    expect(parseCargoToml("[package]\nname = \"x\"\n").size).toBe(0);
  });
});

// ── parseGoMod ────────────────────────────────────────────────────────────────

describe("parseGoMod", () => {
  it("parses a require block", () => {
    const mod = `module example.com/app\n\nrequire (\n\tgithub.com/gin-gonic/gin v1.9.1\n\tgithub.com/stretchr/testify v1.8.4\n)\n`;
    const result = parseGoMod(mod);
    expect(result.get("github.com/gin-gonic/gin")).toBe("1.9.1");
    expect(result.get("github.com/stretchr/testify")).toBe("1.8.4");
  });

  it("parses single-line require statements", () => {
    const mod = `require github.com/pkg/errors v0.9.1\n`;
    expect(parseGoMod(mod).get("github.com/pkg/errors")).toBe("0.9.1");
  });

  it("strips the v prefix from versions", () => {
    const mod = `require (\n\tgithub.com/foo/bar v2.0.0\n)\n`;
    expect(parseGoMod(mod).get("github.com/foo/bar")).toBe("2.0.0");
  });

  it("strips // indirect comments", () => {
    const mod = `require (\n\tgithub.com/foo/bar v1.0.0 // indirect\n)\n`;
    expect(parseGoMod(mod).get("github.com/foo/bar")).toBe("1.0.0");
  });

  it("returns empty map for a module with no dependencies", () => {
    expect(parseGoMod("module example.com/app\n\ngo 1.21\n").size).toBe(0);
  });
});

// ── parseGemfile ──────────────────────────────────────────────────────────────

describe("parseGemfile", () => {
  it("parses gems with ~> version constraints", () => {
    const gemfile = `gem 'rails', '~> 7.0.4'\n`;
    expect(parseGemfile(gemfile).get("rails")).toBe("7.0.4");
  });

  it("parses gems with >= constraints", () => {
    const gemfile = `gem 'puma', '>= 5.0'\n`;
    expect(parseGemfile(gemfile).get("puma")).toBe("5.0");
  });

  it("parses double-quoted gem declarations", () => {
    const gemfile = `gem "pg", "~> 1.4"\n`;
    expect(parseGemfile(gemfile).get("pg")).toBe("1.4");
  });

  it("skips gems without a version constraint", () => {
    const gemfile = `gem 'tzinfo-data'\n`;
    expect(parseGemfile(gemfile).size).toBe(0);
  });

  it("strips inline comments", () => {
    const gemfile = `gem 'rails', '~> 7.0.4' # web framework\n`;
    expect(parseGemfile(gemfile).get("rails")).toBe("7.0.4");
  });
});

// ── fetchLatestPypiVersion ────────────────────────────────────────────────────

describe("fetchLatestPypiVersion", () => {
  it("returns the latest version from PyPI", async () => {
    global.fetch = jest.fn().mockResolvedValue(makeJsonResponse({ info: { version: "2.28.2" } }));
    expect(await fetchLatestPypiVersion("requests")).toBe("2.28.2");
  });

  it("returns null for packages not found (404)", async () => {
    global.fetch = jest.fn().mockResolvedValue(makeJsonResponse({}, 404));
    expect(await fetchLatestPypiVersion("private-pkg")).toBeNull();
  });

  it("throws on non-404 errors", async () => {
    global.fetch = jest.fn().mockResolvedValue(makeJsonResponse({}, 503));
    await expect(fetchLatestPypiVersion("requests")).rejects.toThrow("PyPI returned 503");
  });
});

// ── fetchLatestCratesVersion ──────────────────────────────────────────────────

describe("fetchLatestCratesVersion", () => {
  it("returns the newest_version from crates.io", async () => {
    global.fetch = jest.fn().mockResolvedValue(makeJsonResponse({ crate: { newest_version: "1.0.136" } }));
    expect(await fetchLatestCratesVersion("serde")).toBe("1.0.136");
  });

  it("includes a User-Agent header in the request", async () => {
    global.fetch = jest.fn().mockResolvedValue(makeJsonResponse({ crate: { newest_version: "1.0" } }));
    await fetchLatestCratesVersion("serde");
    expect(global.fetch.mock.calls[0][1].headers["User-Agent"]).toBeTruthy();
  });

  it("returns null for crates not found (404)", async () => {
    global.fetch = jest.fn().mockResolvedValue(makeJsonResponse({}, 404));
    expect(await fetchLatestCratesVersion("private-crate")).toBeNull();
  });

  it("throws on non-404 errors", async () => {
    global.fetch = jest.fn().mockResolvedValue(makeJsonResponse({}, 500));
    await expect(fetchLatestCratesVersion("serde")).rejects.toThrow("crates.io returned 500");
  });
});

// ── fetchLatestGoVersion ──────────────────────────────────────────────────────

describe("fetchLatestGoVersion", () => {
  it("returns the version without the v prefix", async () => {
    global.fetch = jest.fn().mockResolvedValue(makeJsonResponse({ Version: "v1.9.1" }));
    expect(await fetchLatestGoVersion("github.com/gin-gonic/gin")).toBe("1.9.1");
  });

  it("uses the Go proxy URL", async () => {
    global.fetch = jest.fn().mockResolvedValue(makeJsonResponse({ Version: "v1.0.0" }));
    await fetchLatestGoVersion("github.com/pkg/errors");
    expect(global.fetch.mock.calls[0][0]).toContain("proxy.golang.org");
  });

  it("returns null for 404 responses", async () => {
    global.fetch = jest.fn().mockResolvedValue(makeJsonResponse({}, 404));
    expect(await fetchLatestGoVersion("github.com/private/pkg")).toBeNull();
  });

  it("returns null for 410 gone responses", async () => {
    global.fetch = jest.fn().mockResolvedValue(makeJsonResponse({}, 410));
    expect(await fetchLatestGoVersion("github.com/deprecated/pkg")).toBeNull();
  });

  it("throws on other non-2xx errors", async () => {
    global.fetch = jest.fn().mockResolvedValue(makeJsonResponse({}, 500));
    await expect(fetchLatestGoVersion("github.com/pkg/errors")).rejects.toThrow("Go proxy returned 500");
  });
});

// ── fetchLatestGemVersion ─────────────────────────────────────────────────────

describe("fetchLatestGemVersion", () => {
  it("returns the latest gem version", async () => {
    global.fetch = jest.fn().mockResolvedValue(makeJsonResponse({ version: "7.0.8" }));
    expect(await fetchLatestGemVersion("rails")).toBe("7.0.8");
  });

  it("returns null for gems not found (404)", async () => {
    global.fetch = jest.fn().mockResolvedValue(makeJsonResponse({}, 404));
    expect(await fetchLatestGemVersion("private-gem")).toBeNull();
  });

  it("throws on non-404 errors", async () => {
    global.fetch = jest.fn().mockResolvedValue(makeJsonResponse({}, 503));
    await expect(fetchLatestGemVersion("rails")).rejects.toThrow("RubyGems returned 503");
  });
});

// ── scanPythonEcosystem ───────────────────────────────────────────────────────

describe("scanPythonEcosystem", () => {
  it("returns outdated Python packages from requirements.txt", async () => {
    const octokit = makeOctokit(() => Promise.resolve(makeContentResponse("requests==2.28.0\n")));
    global.fetch = jest.fn().mockResolvedValue(makeJsonResponse({ info: { version: "2.31.0" } }));

    const result = await scanPythonEcosystem(octokit, "owner", "repo");
    expect(result.ecosystem).toBe("python");
    expect(result.outdated).toHaveLength(1);
    expect(result.outdated[0].name).toBe("requests");
    expect(result.outdated[0].updateType).toBe("minor");
  });

  it("throws when the manifest is not found", async () => {
    const octokit = makeOctokit(notFound);
    await expect(scanPythonEcosystem(octokit, "owner", "repo")).rejects.toThrow(/not found/);
  });
});

// ── scanRustEcosystem ─────────────────────────────────────────────────────────

describe("scanRustEcosystem", () => {
  it("returns outdated Rust crates from Cargo.toml", async () => {
    const toml = `[dependencies]\nserde = "1.0.150"\n`;
    const octokit = makeOctokit(() => Promise.resolve(makeContentResponse(toml)));
    global.fetch = jest.fn().mockResolvedValue(makeJsonResponse({ crate: { newest_version: "1.0.195" } }));

    const result = await scanRustEcosystem(octokit, "owner", "repo");
    expect(result.ecosystem).toBe("rust");
    expect(result.outdated[0].name).toBe("serde");
  });

  it("throws when Cargo.toml is not found", async () => {
    const octokit = makeOctokit(notFound);
    await expect(scanRustEcosystem(octokit, "owner", "repo")).rejects.toThrow(/not found/);
  });
});

// ── scanGoEcosystem ───────────────────────────────────────────────────────────

describe("scanGoEcosystem", () => {
  it("returns outdated Go modules from go.mod", async () => {
    const mod = `require (\n\tgithub.com/gin-gonic/gin v1.8.0\n)\n`;
    const octokit = makeOctokit(() => Promise.resolve(makeContentResponse(mod)));
    global.fetch = jest.fn().mockResolvedValue(makeJsonResponse({ Version: "v1.9.1" }));

    const result = await scanGoEcosystem(octokit, "owner", "repo");
    expect(result.ecosystem).toBe("go");
    expect(result.outdated[0].name).toBe("github.com/gin-gonic/gin");
  });

  it("throws when go.mod is not found", async () => {
    const octokit = makeOctokit(notFound);
    await expect(scanGoEcosystem(octokit, "owner", "repo")).rejects.toThrow(/not found/);
  });
});

// ── scanRubyEcosystem ─────────────────────────────────────────────────────────

describe("scanRubyEcosystem", () => {
  it("returns outdated Ruby gems from Gemfile", async () => {
    const gemfile = `gem 'rails', '~> 7.0.4'\n`;
    const octokit = makeOctokit(() => Promise.resolve(makeContentResponse(gemfile)));
    global.fetch = jest.fn().mockResolvedValue(makeJsonResponse({ version: "7.1.3" }));

    const result = await scanRubyEcosystem(octokit, "owner", "repo");
    expect(result.ecosystem).toBe("ruby");
    expect(result.outdated[0].name).toBe("rails");
  });

  it("throws when Gemfile is not found", async () => {
    const octokit = makeOctokit(notFound);
    await expect(scanRubyEcosystem(octokit, "owner", "repo")).rejects.toThrow(/not found/);
  });
});

// ── detectEcosystems (multi-ecosystem) ───────────────────────────────────────

describe("detectEcosystems — multi-ecosystem", () => {
  it("detects Python when requirements.txt is present", async () => {
    const octokit = makeOctokit((args) =>
      args.path === "requirements.txt"
        ? Promise.resolve(makeContentResponse("requests==2.28.0"))
        : notFound()
    );
    const result = await detectEcosystems(octokit, "owner", "repo");
    expect(result.some((r) => r.ecosystem === "python")).toBe(true);
  });

  it("detects Rust when Cargo.toml is present", async () => {
    const octokit = makeOctokit((args) =>
      args.path === "Cargo.toml"
        ? Promise.resolve(makeContentResponse("[dependencies]"))
        : notFound()
    );
    const result = await detectEcosystems(octokit, "owner", "repo");
    expect(result.some((r) => r.ecosystem === "rust")).toBe(true);
  });

  it("detects Go when go.mod is present", async () => {
    const octokit = makeOctokit((args) =>
      args.path === "go.mod"
        ? Promise.resolve(makeContentResponse("module example.com/app"))
        : notFound()
    );
    const result = await detectEcosystems(octokit, "owner", "repo");
    expect(result.some((r) => r.ecosystem === "go")).toBe(true);
  });

  it("detects Ruby when Gemfile is present", async () => {
    const octokit = makeOctokit((args) =>
      args.path === "Gemfile"
        ? Promise.resolve(makeContentResponse("gem 'rails'"))
        : notFound()
    );
    const result = await detectEcosystems(octokit, "owner", "repo");
    expect(result.some((r) => r.ecosystem === "ruby")).toBe(true);
  });

  it("detects multiple ecosystems in a polyglot repo", async () => {
    const octokit = makeOctokit((args) => {
      if (args.path === "package.json") return Promise.resolve(makeContentResponse('{"name":"x"}'));
      if (args.path === "requirements.txt") return Promise.resolve(makeContentResponse("requests==2.28.0"));
      return notFound();
    });
    const result = await detectEcosystems(octokit, "owner", "repo");
    expect(result.map((r) => r.ecosystem)).toContain("node");
    expect(result.map((r) => r.ecosystem)).toContain("python");
  });

  it("uses requirements.txt over pyproject.toml when both exist (priority order)", async () => {
    const octokit = makeOctokit((args) => {
      if (args.path === "requirements.txt") return Promise.resolve(makeContentResponse("requests==2.28.0"));
      if (args.path === "pyproject.toml") return Promise.resolve(makeContentResponse("[project]"));
      return notFound();
    });
    const result = await detectEcosystems(octokit, "owner", "repo");
    const python = result.find((r) => r.ecosystem === "python");
    expect(python?.manifest).toBe("requirements.txt");
  });
});
