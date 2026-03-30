/**
 * @fileoverview Tests for the analyzer module.
 */

import { jest } from "@jest/globals";
import { callClaudeWithRetry, fetchChangelog, parseClaudeResponse } from "../src/analyzer.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Minimal valid RiskScore returned by Claude. */
const validRiskScore = {
  packageName: "lodash",
  currentVersion: "4.17.20",
  latestVersion: "4.17.21",
  updateType: "patch",
  riskScore: 10,
  recommendation: "THUMBS_UP",
  summary: "Minor security patch.",
  breakingChanges: [],
  ramifications: [],
  changelogUrl: null,
};

/** Creates a mock Anthropic client whose messages.create resolves/rejects on demand. */
const makeClient = (impl) => ({
  messages: { create: jest.fn().mockImplementation(impl) },
});

/** Wraps text in the shape the Anthropic SDK returns. */
const makeApiResponse = (text) => ({
  content: [{ type: "text", text }],
});

/** Creates a mock fetch response. */
const makeJsonResponse = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: jest.fn().mockResolvedValue(body),
});

// ── parseClaudeResponse ───────────────────────────────────────────────────────

describe("parseClaudeResponse", () => {
  const validResponse = JSON.stringify(validRiskScore);

  it("parses a valid Claude response", () => {
    const result = parseClaudeResponse(validResponse);
    expect(result.packageName).toBe("lodash");
    expect(result.riskScore).toBe(10);
  });

  it("throws on invalid JSON", () => {
    expect(() => parseClaudeResponse("not json")).toThrow(/not valid JSON/);
  });

  it("throws on missing required fields", () => {
    const incomplete = JSON.stringify({ packageName: "x" });
    expect(() => parseClaudeResponse(incomplete)).toThrow(/missing required field/);
  });

  it("throws on invalid recommendation value", () => {
    const bad = JSON.stringify({ ...validRiskScore, recommendation: "INVALID" });
    expect(() => parseClaudeResponse(bad)).toThrow(/Invalid recommendation/);
  });
});

// ── fetchChangelog ────────────────────────────────────────────────────────────

describe("fetchChangelog", () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("returns empty when npm registry returns non-200", async () => {
    global.fetch = jest.fn().mockResolvedValue(makeJsonResponse({}, 404));
    const result = await fetchChangelog({ token: "tok", packageName: "missing", latestVersion: "1.0.0" });
    expect(result).toEqual({ text: "", url: null });
  });

  it("returns empty when package has no repository URL", async () => {
    global.fetch = jest.fn().mockResolvedValue(makeJsonResponse({ name: "no-repo" }));
    const result = await fetchChangelog({ token: "tok", packageName: "no-repo", latestVersion: "1.0.0" });
    expect(result).toEqual({ text: "", url: null });
  });

  it("returns empty when repository is not on GitHub", async () => {
    const registryData = { repository: { url: "https://gitlab.com/org/pkg.git" } };
    global.fetch = jest.fn().mockResolvedValue(makeJsonResponse(registryData));
    const result = await fetchChangelog({ token: "tok", packageName: "pkg", latestVersion: "1.0.0" });
    expect(result).toEqual({ text: "", url: null });
  });

  it("returns release notes when found with 'v' prefix tag", async () => {
    const registryData = { repository: { url: "https://github.com/lodash/lodash.git" } };
    const release = { body: "### Fixed\n- security patch", html_url: "https://github.com/lodash/lodash/releases/tag/v4.17.21" };

    global.fetch = jest.fn()
      .mockResolvedValueOnce(makeJsonResponse(registryData))
      .mockResolvedValueOnce(makeJsonResponse(release));

    const result = await fetchChangelog({ token: "tok", packageName: "lodash", latestVersion: "4.17.21" });
    expect(result.text).toContain("security patch");
    expect(result.url).toBe(release.html_url);
  });

  it("falls back to bare version tag when 'v' prefix tag returns 404", async () => {
    const registryData = { repository: { url: "https://github.com/org/pkg.git" } };
    const release = { body: "Release notes", html_url: "https://github.com/org/pkg/releases/tag/1.0.0" };

    global.fetch = jest.fn()
      .mockResolvedValueOnce(makeJsonResponse(registryData))
      .mockResolvedValueOnce(makeJsonResponse({}, 404))   // v1.0.0 not found
      .mockResolvedValueOnce(makeJsonResponse(release));  // 1.0.0 found

    const result = await fetchChangelog({ token: "tok", packageName: "pkg", latestVersion: "1.0.0" });
    expect(result.text).toBe("Release notes");
    expect(result.url).toBe(release.html_url);
  });

  it("returns empty when no matching release tag exists", async () => {
    const registryData = { repository: { url: "https://github.com/org/pkg.git" } };

    global.fetch = jest.fn()
      .mockResolvedValueOnce(makeJsonResponse(registryData))
      .mockResolvedValueOnce(makeJsonResponse({}, 404))
      .mockResolvedValueOnce(makeJsonResponse({}, 404));

    const result = await fetchChangelog({ token: "tok", packageName: "pkg", latestVersion: "2.0.0" });
    expect(result).toEqual({ text: "", url: null });
  });

  it("encodes scoped package names correctly in the registry URL", async () => {
    global.fetch = jest.fn().mockResolvedValue(makeJsonResponse({ name: "scoped" }));
    await fetchChangelog({ token: "tok", packageName: "@octokit/rest", latestVersion: "21.0.0" });
    expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining("%2F"));
  });

  it("returns empty when npm fetch throws a network error", async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error("Network error"));
    const result = await fetchChangelog({ token: "tok", packageName: "pkg", latestVersion: "1.0.0" });
    expect(result).toEqual({ text: "", url: null });
  });
});

// ── callClaudeWithRetry ───────────────────────────────────────────────────────

describe("callClaudeWithRetry", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it("returns parsed RiskScore on first successful call", async () => {
    const client = makeClient(() => Promise.resolve(makeApiResponse(JSON.stringify(validRiskScore))));
    const result = await callClaudeWithRetry(client, "prompt", "lodash@4.17.21");
    expect(result.packageName).toBe("lodash");
    expect(result.recommendation).toBe("THUMBS_UP");
    expect(client.messages.create).toHaveBeenCalledTimes(1);
  });

  it("retries on a 503 server error and succeeds on second attempt", async () => {
    const serverError = Object.assign(new Error("Service Unavailable"), { status: 503 });
    const client = makeClient(
      jest.fn()
        .mockRejectedValueOnce(serverError)
        .mockResolvedValueOnce(makeApiResponse(JSON.stringify(validRiskScore)))
    );

    const promise = callClaudeWithRetry(client, "prompt", "lodash@4.17.21");
    await jest.runAllTimersAsync();
    const result = await promise;

    expect(client.messages.create).toHaveBeenCalledTimes(2);
    expect(result.recommendation).toBe("THUMBS_UP");
  });

  it("retries on a 429 rate-limit error", async () => {
    const rateLimitError = Object.assign(new Error("Too Many Requests"), { status: 429 });
    const client = makeClient(
      jest.fn()
        .mockRejectedValueOnce(rateLimitError)
        .mockResolvedValueOnce(makeApiResponse(JSON.stringify(validRiskScore)))
    );

    const promise = callClaudeWithRetry(client, "prompt", "pkg@1.0.0");
    await jest.runAllTimersAsync();
    const result = await promise;

    expect(client.messages.create).toHaveBeenCalledTimes(2);
    expect(result.recommendation).toBe("THUMBS_UP");
  });

  it("does not retry on a 400 client error", async () => {
    const clientError = Object.assign(new Error("Bad Request"), { status: 400 });
    const client = makeClient(jest.fn().mockRejectedValue(clientError));

    const promise = callClaudeWithRetry(client, "prompt", "pkg@1.0.0");
    await jest.runAllTimersAsync();
    const result = await promise;

    expect(client.messages.create).toHaveBeenCalledTimes(1);
    expect(result.recommendation).toBe("NEEDS_REVIEW");
  });

  it("does not retry when Claude returns invalid JSON", async () => {
    const client = makeClient(() => Promise.resolve(makeApiResponse("not json at all")));

    const promise = callClaudeWithRetry(client, "prompt", "pkg@1.0.0");
    await jest.runAllTimersAsync();
    const result = await promise;

    expect(client.messages.create).toHaveBeenCalledTimes(1);
    expect(result.recommendation).toBe("NEEDS_REVIEW");
  });

  it("falls back to NEEDS_REVIEW after exhausting all retries", async () => {
    const serverError = Object.assign(new Error("Internal Server Error"), { status: 500 });
    const client = makeClient(jest.fn().mockRejectedValue(serverError));

    const promise = callClaudeWithRetry(client, "prompt", "pkg@2.0.0");
    await jest.runAllTimersAsync();
    const result = await promise;

    expect(result.recommendation).toBe("NEEDS_REVIEW");
    expect(result.summary).toMatch(/failed after retries/);
  });

  it("extracts packageName from cacheKey in fallback result", async () => {
    const serverError = Object.assign(new Error("Error"), { status: 500 });
    const client = makeClient(jest.fn().mockRejectedValue(serverError));

    const promise = callClaudeWithRetry(client, "prompt", "my-pkg@3.1.0");
    await jest.runAllTimersAsync();
    const result = await promise;

    expect(result.packageName).toBe("my-pkg");
    expect(result.latestVersion).toBe("3.1.0");
  });

  it("handles scoped package names in cacheKey correctly", async () => {
    const serverError = Object.assign(new Error("Error"), { status: 500 });
    const client = makeClient(jest.fn().mockRejectedValue(serverError));

    const promise = callClaudeWithRetry(client, "prompt", "@octokit/rest@21.0.2");
    await jest.runAllTimersAsync();
    const result = await promise;

    expect(result.packageName).toBe("@octokit/rest");
    expect(result.latestVersion).toBe("21.0.2");
  });
});
