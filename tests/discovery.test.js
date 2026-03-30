/**
 * @fileoverview Tests for the discovery module.
 */

import { jest } from "@jest/globals";
import { discoverRepositories, fetchAllRepositories, filterAndOrderRepositories } from "../src/discovery.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** @param {string} name */
const makeRepo = (name) => ({ name, full_name: `owner/${name}` });

/**
 * Builds a minimal mock Octokit whose paginate resolves to the given repos.
 *
 * @param {object[]} repos
 */
const makeOctokit = (repos) => ({
  paginate: jest.fn().mockResolvedValue(repos),
  rest: { repos: { listForAuthenticatedUser: {} } },
  hook: { after: jest.fn() },
});

// ── filterAndOrderRepositories ────────────────────────────────────────────────

describe("filterAndOrderRepositories", () => {
  it("removes excluded repos", () => {
    const repos = [makeRepo("a"), makeRepo("b"), makeRepo("c")];
    const result = filterAndOrderRepositories(repos, ["b"], [], undefined);
    expect(result.map((r) => r.name)).toEqual(["a", "c"]);
  });

  it("moves priority repos to the front", () => {
    const repos = [makeRepo("a"), makeRepo("b"), makeRepo("c")];
    const result = filterAndOrderRepositories(repos, [], ["c"], undefined);
    expect(result[0].name).toBe("c");
  });

  it("moves multiple priority repos to the front, preserving API order among them", () => {
    const repos = [makeRepo("a"), makeRepo("b"), makeRepo("c"), makeRepo("d")];
    const result = filterAndOrderRepositories(repos, [], ["c", "a"], undefined);
    expect(result.map((r) => r.name)).toEqual(["a", "c", "b", "d"]);
  });

  it("filters to a single target repo matched by short name", () => {
    const repos = [makeRepo("a"), makeRepo("b")];
    const result = filterAndOrderRepositories(repos, [], [], "a");
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("a");
  });

  it("filters to a single target repo matched by full_name (owner/repo)", () => {
    const repos = [makeRepo("a"), makeRepo("b")];
    const result = filterAndOrderRepositories(repos, [], [], "owner/b");
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("b");
  });

  it("returns empty array when all repos are excluded", () => {
    const repos = [makeRepo("a")];
    const result = filterAndOrderRepositories(repos, ["a"], [], undefined);
    expect(result).toHaveLength(0);
  });

  it("exclusion takes precedence over priority — excluded priority repos are removed", () => {
    const repos = [makeRepo("a"), makeRepo("b")];
    const result = filterAndOrderRepositories(repos, ["b"], ["b"], undefined);
    expect(result.map((r) => r.name)).toEqual(["a"]);
  });

  it("returns all repos unchanged when no filters are applied", () => {
    const repos = [makeRepo("a"), makeRepo("b"), makeRepo("c")];
    const result = filterAndOrderRepositories(repos, [], [], undefined);
    expect(result.map((r) => r.name)).toEqual(["a", "b", "c"]);
  });

  it("returns empty array for empty input", () => {
    expect(filterAndOrderRepositories([], ["x"], ["y"], undefined)).toEqual([]);
  });
});

// ── fetchAllRepositories ──────────────────────────────────────────────────────

describe("fetchAllRepositories", () => {
  it("returns the list resolved by octokit.paginate", async () => {
    const repos = [makeRepo("x"), makeRepo("y")];
    const octokit = makeOctokit(repos);

    const result = await fetchAllRepositories(octokit);

    expect(result).toEqual(repos);
  });

  it("calls paginate with affiliation=owner and per_page=100", async () => {
    const octokit = makeOctokit([]);

    await fetchAllRepositories(octokit);

    expect(octokit.paginate).toHaveBeenCalledWith(
      octokit.rest.repos.listForAuthenticatedUser,
      expect.objectContaining({ affiliation: "owner", per_page: 100 })
    );
  });

  it("returns an empty array when the user has no repositories", async () => {
    const octokit = makeOctokit([]);
    const result = await fetchAllRepositories(octokit);
    expect(result).toHaveLength(0);
  });

  it("surfaces paginate errors to the caller", async () => {
    const octokit = {
      paginate: jest.fn().mockRejectedValue(new Error("Network failure")),
      rest: { repos: { listForAuthenticatedUser: {} } },
    };

    await expect(fetchAllRepositories(octokit)).rejects.toThrow("Network failure");
  });
});

// ── discoverRepositories ──────────────────────────────────────────────────────

describe("discoverRepositories", () => {
  it("returns filtered and ordered repos", async () => {
    const repos = [makeRepo("main-app"), makeRepo("archived"), makeRepo("priority-lib")];
    const octokit = makeOctokit(repos);

    const result = await discoverRepositories({
      token: "fake-token",
      excludedRepos: ["archived"],
      priorityRepos: ["priority-lib"],
      targetRepo: undefined,
      _octokitOverride: octokit,
    });

    expect(result[0].name).toBe("priority-lib");
    expect(result.map((r) => r.name)).not.toContain("archived");
  });

  it("returns only the target repo when targetRepo is set", async () => {
    const repos = [makeRepo("a"), makeRepo("b"), makeRepo("c")];
    const octokit = makeOctokit(repos);

    const result = await discoverRepositories({
      token: "fake-token",
      excludedRepos: [],
      priorityRepos: [],
      targetRepo: "b",
      _octokitOverride: octokit,
    });

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("b");
  });

  it("returns empty array when no repos survive filtering", async () => {
    const octokit = makeOctokit([makeRepo("excluded")]);

    const result = await discoverRepositories({
      token: "fake-token",
      excludedRepos: ["excluded"],
      priorityRepos: [],
      targetRepo: undefined,
      _octokitOverride: octokit,
    });

    expect(result).toHaveLength(0);
  });
});
