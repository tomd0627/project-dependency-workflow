/**
 * @fileoverview Tests for the auditor module.
 */

import { jest } from "@jest/globals";
import {
  buildAdvisoryQuery,
  fetchAdvisories,
  parseAdvisoryResponse,
} from "../src/auditor.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Builds a minimal advisory node matching the GraphQL response shape. */
const makeNode = (overrides = {}) => ({
  advisory: {
    ghsaId: "GHSA-xxxx-yyyy-zzzz",
    severity: "HIGH",
    summary: "Prototype pollution vulnerability",
  },
  vulnerableVersionRange: "< 4.17.21",
  firstPatchedVersion: { identifier: "4.17.21" },
  package: { name: "lodash" },
  ...overrides,
});

/** Builds a mock fetch response. */
const makeJsonResponse = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: jest.fn().mockResolvedValue(body),
});

let originalFetch;
beforeEach(() => { originalFetch = global.fetch; });
afterEach(() => { global.fetch = originalFetch; });

// ── buildAdvisoryQuery ────────────────────────────────────────────────────────

describe("buildAdvisoryQuery", () => {
  it("uses pkg0 alias for the first package", () => {
    const query = buildAdvisoryQuery(["lodash"], "NPM");
    expect(query).toContain("pkg0:");
  });

  it("uses pkg1 alias for the second package", () => {
    const query = buildAdvisoryQuery(["lodash", "axios"], "NPM");
    expect(query).toContain("pkg1:");
  });

  it("embeds the ecosystem enum in the query", () => {
    const query = buildAdvisoryQuery(["lodash"], "NPM");
    expect(query).toContain("ecosystem: NPM");
  });

  it("embeds the package name as a quoted string", () => {
    const query = buildAdvisoryQuery(["lodash"], "NPM");
    expect(query).toContain('"lodash"');
  });

  it("handles scoped package names", () => {
    const query = buildAdvisoryQuery(["@octokit/rest"], "NPM");
    expect(query).toContain('"@octokit/rest"');
  });

  it("includes ghsaId, severity, and summary in the selection set", () => {
    const query = buildAdvisoryQuery(["lodash"], "NPM");
    expect(query).toContain("ghsaId");
    expect(query).toContain("severity");
    expect(query).toContain("summary");
  });

  it("includes vulnerableVersionRange and firstPatchedVersion", () => {
    const query = buildAdvisoryQuery(["lodash"], "NPM");
    expect(query).toContain("vulnerableVersionRange");
    expect(query).toContain("firstPatchedVersion");
  });

  it("produces a query with N aliases for N packages", () => {
    const query = buildAdvisoryQuery(["a", "b", "c"], "NPM");
    expect(query).toContain("pkg0:");
    expect(query).toContain("pkg1:");
    expect(query).toContain("pkg2:");
  });
});

// ── parseAdvisoryResponse ─────────────────────────────────────────────────────

describe("parseAdvisoryResponse", () => {
  it("extracts an advisory from a single-package response", () => {
    const data = { pkg0: { nodes: [makeNode()] } };
    const result = parseAdvisoryResponse(data, ["lodash"]);
    expect(result).toHaveLength(1);
    expect(result[0].ghsaId).toBe("GHSA-xxxx-yyyy-zzzz");
    expect(result[0].packageName).toBe("lodash");
    expect(result[0].severity).toBe("HIGH");
    expect(result[0].affectedRange).toBe("< 4.17.21");
    expect(result[0].patchedVersion).toBe("4.17.21");
  });

  it("extracts advisories across multiple packages", () => {
    const data = {
      pkg0: { nodes: [makeNode({ package: { name: "lodash" } })] },
      pkg1: { nodes: [makeNode({ package: { name: "axios" }, advisory: { ghsaId: "GHSA-aaaa-bbbb-cccc", severity: "MEDIUM", summary: "SSRF" } })] },
    };
    const result = parseAdvisoryResponse(data, ["lodash", "axios"]);
    expect(result).toHaveLength(2);
  });

  it("returns empty array when no nodes are present", () => {
    const data = { pkg0: { nodes: [] } };
    expect(parseAdvisoryResponse(data, ["lodash"])).toHaveLength(0);
  });

  it("sets patchedVersion to null when firstPatchedVersion is null", () => {
    const node = makeNode({ firstPatchedVersion: null });
    const data = { pkg0: { nodes: [node] } };
    const [advisory] = parseAdvisoryResponse(data, ["lodash"]);
    expect(advisory.patchedVersion).toBeNull();
  });

  it("handles missing pkg alias gracefully (returns empty for that slot)", () => {
    const data = { pkg0: { nodes: [makeNode()] } };
    // Query was built for two packages but data only has pkg0
    const result = parseAdvisoryResponse(data, ["lodash", "axios"]);
    expect(result).toHaveLength(1);
  });

  it("flattens multiple advisories per package", () => {
    const data = { pkg0: { nodes: [makeNode(), makeNode({ advisory: { ghsaId: "GHSA-2222-3333-4444", severity: "LOW", summary: "Other" } })] } };
    const result = parseAdvisoryResponse(data, ["lodash"]);
    expect(result).toHaveLength(2);
  });
});

// ── fetchAdvisories ───────────────────────────────────────────────────────────

describe("fetchAdvisories", () => {
  it("returns empty array immediately when packageNames is empty", async () => {
    global.fetch = jest.fn();
    const result = await fetchAdvisories({ token: "tok", packageNames: [], ecosystem: "node" });
    expect(result).toEqual([]);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("returns empty array for an unknown ecosystem", async () => {
    global.fetch = jest.fn();
    const result = await fetchAdvisories({ token: "tok", packageNames: ["lodash"], ecosystem: "cobol" });
    expect(result).toEqual([]);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("POSTs to the GitHub GraphQL endpoint", async () => {
    const body = { data: { pkg0: { nodes: [] } } };
    global.fetch = jest.fn().mockResolvedValue(makeJsonResponse(body));
    await fetchAdvisories({ token: "tok", packageNames: ["lodash"], ecosystem: "node" });
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("github.com/graphql"),
      expect.objectContaining({ method: "POST" })
    );
  });

  it("includes the Bearer token in the Authorization header", async () => {
    global.fetch = jest.fn().mockResolvedValue(makeJsonResponse({ data: { pkg0: { nodes: [] } } }));
    await fetchAdvisories({ token: "my-token", packageNames: ["lodash"], ecosystem: "node" });
    const headers = global.fetch.mock.calls[0][1].headers;
    expect(headers.Authorization).toBe("Bearer my-token");
  });

  it("returns parsed advisories on a successful response", async () => {
    const body = { data: { pkg0: { nodes: [makeNode()] } } };
    global.fetch = jest.fn().mockResolvedValue(makeJsonResponse(body));
    const result = await fetchAdvisories({ token: "tok", packageNames: ["lodash"], ecosystem: "node" });
    expect(result).toHaveLength(1);
    expect(result[0].ghsaId).toBe("GHSA-xxxx-yyyy-zzzz");
  });

  it("returns empty array on a non-200 HTTP response", async () => {
    global.fetch = jest.fn().mockResolvedValue(makeJsonResponse({}, 503));
    const result = await fetchAdvisories({ token: "tok", packageNames: ["lodash"], ecosystem: "node" });
    expect(result).toEqual([]);
  });

  it("returns empty array and does not throw when fetch rejects", async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error("Network error"));
    await expect(
      fetchAdvisories({ token: "tok", packageNames: ["lodash"], ecosystem: "node" })
    ).resolves.toEqual([]);
  });

  it("returns partial results and continues when GraphQL errors are present", async () => {
    const body = {
      data: { pkg0: { nodes: [makeNode()] } },
      errors: [{ message: "Something went wrong" }],
    };
    global.fetch = jest.fn().mockResolvedValue(makeJsonResponse(body));
    const result = await fetchAdvisories({ token: "tok", packageNames: ["lodash"], ecosystem: "node" });
    expect(result).toHaveLength(1);
  });

  it("maps the 'python' ecosystem to PIP in the query", async () => {
    global.fetch = jest.fn().mockResolvedValue(makeJsonResponse({ data: { pkg0: { nodes: [] } } }));
    await fetchAdvisories({ token: "tok", packageNames: ["requests"], ecosystem: "python" });
    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.query).toContain("PIP");
  });
});
