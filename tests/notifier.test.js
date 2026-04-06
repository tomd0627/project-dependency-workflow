/**
 * @fileoverview Tests for the notifier module.
 */

import { jest } from "@jest/globals";
import { createReportIssue, renderIssueBody, sendWebhookNotification } from "../src/notifier.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Minimal valid RiskScore. */
const makeResult = (overrides = {}) => ({
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
  ...overrides,
});

/** Minimal valid DependencyReport. */
const makeReport = (overrides = {}) => ({
  owner: "octokit",
  repo: "rest.js",
  scannedAt: "2026-03-30T12:00:00.000Z",
  results: [makeResult()],
  ...overrides,
});

/**
 * Creates a mock Octokit for createReportIssue tests.
 *
 * @param {object} opts
 * @param {Function} [opts.createImpl] - impl for issues.create
 * @param {Array}   [opts.existingIssues] - list returned by listForRepo (default: [])
 */
const makeOctokit = ({ createImpl, existingIssues = [] } = {}) => ({
  rest: {
    issues: {
      listForRepo: jest.fn().mockResolvedValue({ data: existingIssues }),
      create: jest.fn().mockImplementation(
        createImpl ??
          (() => Promise.resolve({ data: { number: 42, html_url: "https://github.com/octokit/rest.js/issues/42" } }))
      ),
      update: jest.fn().mockResolvedValue({}),
    },
  },
});

/** Creates a mock fetch response. */
const makeJsonResponse = (body = {}, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: jest.fn().mockResolvedValue(body),
});

// ── renderIssueBody ───────────────────────────────────────────────────────────

describe("renderIssueBody", () => {
  it("includes the repo name in the header", () => {
    const body = renderIssueBody(makeReport());
    expect(body).toContain("octokit/rest.js");
  });

  it("includes the scanned-at timestamp", () => {
    const body = renderIssueBody(makeReport());
    expect(body).toContain("2026-03-30T12:00:00.000Z");
  });

  it("renders a row for each result in the package table", () => {
    const report = makeReport({
      results: [makeResult({ packageName: "lodash" }), makeResult({ packageName: "axios" })],
    });
    const body = renderIssueBody(report);
    expect(body).toContain("`lodash`");
    expect(body).toContain("`axios`");
  });

  it("shows correct summary counts", () => {
    const report = makeReport({
      results: [
        makeResult({ recommendation: "THUMBS_UP" }),
        makeResult({ packageName: "react", recommendation: "NEEDS_REVIEW" }),
        makeResult({ packageName: "webpack", recommendation: "THUMBS_DOWN" }),
      ],
    });
    const body = renderIssueBody(report);
    expect(body).toMatch(/Total outdated.*3/);
    expect(body).toMatch(/Auto-approve.*1/);
    expect(body).toMatch(/Needs review.*1/);
    expect(body).toMatch(/Skip.*1/);
  });

  it("includes a breaking changes section when present", () => {
    const result = makeResult({
      packageName: "react",
      updateType: "major",
      recommendation: "NEEDS_REVIEW",
      breakingChanges: ["Removed legacy context API", "useEffect cleanup timing changed"],
    });
    const body = renderIssueBody(makeReport({ results: [result] }));
    expect(body).toContain("### Breaking Changes");
    expect(body).toContain("Removed legacy context API");
    expect(body).toContain("useEffect cleanup timing changed");
  });

  it("omits the breaking changes section when none exist", () => {
    const body = renderIssueBody(makeReport());
    expect(body).not.toContain("### Breaking Changes");
  });

  it("bolds major update type in the table", () => {
    const body = renderIssueBody(makeReport({ results: [makeResult({ updateType: "major" })] }));
    expect(body).toContain("**Major**");
  });
});

// ── createReportIssue ─────────────────────────────────────────────────────────

describe("createReportIssue", () => {
  it("creates an issue and returns its number and URL", async () => {
    const octokit = makeOctokit();
    const result = await createReportIssue({
      octokit,
      owner: "octokit",
      repo: "rest.js",
      report: makeReport(),
      dryRun: false,
    });
    expect(result).toEqual({ issueNumber: 42, issueUrl: "https://github.com/octokit/rest.js/issues/42" });
    expect(octokit.rest.issues.create).toHaveBeenCalledTimes(1);
  });

  it("passes title, body, and labels to the API", async () => {
    const octokit = makeOctokit({
      createImpl: () => Promise.resolve({ data: { number: 1, html_url: "https://github.com/a/b/issues/1" } }),
    });
    await createReportIssue({
      octokit,
      owner: "a",
      repo: "b",
      report: makeReport({ owner: "a", repo: "b" }),
      dryRun: false,
    });
    const call = octokit.rest.issues.create.mock.calls[0][0];
    expect(call.title).toMatch(/deps: dependency update report/);
    expect(call.body).toContain("a/b");
    expect(call.labels).toContain("dependencies");
  });

  it("returns null and skips the API call in dry-run mode", async () => {
    const octokit = makeOctokit();
    const result = await createReportIssue({
      octokit,
      owner: "octokit",
      repo: "rest.js",
      report: makeReport(),
      dryRun: true,
    });
    expect(result).toBeNull();
    expect(octokit.rest.issues.create).not.toHaveBeenCalled();
  });

  it("includes the scan date in the issue title", async () => {
    const octokit = makeOctokit({
      createImpl: () => Promise.resolve({ data: { number: 7, html_url: "https://github.com/a/b/issues/7" } }),
    });
    await createReportIssue({
      octokit,
      owner: "a",
      repo: "b",
      report: makeReport({ scannedAt: "2026-03-30T12:00:00.000Z" }),
      dryRun: false,
    });
    const call = octokit.rest.issues.create.mock.calls[0][0];
    expect(call.title).toContain("2026-03-30");
  });

  it("reuses an existing open dep-bot issue instead of creating a new one", async () => {
    const existing = {
      number: 99,
      html_url: "https://github.com/octokit/rest.js/issues/99",
      title: "deps: dependency update report — 2026-03-29",
    };
    const octokit = makeOctokit({ existingIssues: [existing] });
    const result = await createReportIssue({
      octokit,
      owner: "octokit",
      repo: "rest.js",
      report: makeReport(),
      dryRun: false,
    });
    expect(result).toEqual({ issueNumber: 99, issueUrl: existing.html_url });
    expect(octokit.rest.issues.create).not.toHaveBeenCalled();
    expect(octokit.rest.issues.update).toHaveBeenCalledWith(
      expect.objectContaining({ issue_number: 99 })
    );
  });

  it("creates a new issue when no existing open dep-bot issue is found", async () => {
    const octokit = makeOctokit({ existingIssues: [] });
    await createReportIssue({
      octokit,
      owner: "octokit",
      repo: "rest.js",
      report: makeReport(),
      dryRun: false,
    });
    expect(octokit.rest.issues.create).toHaveBeenCalledTimes(1);
    expect(octokit.rest.issues.update).not.toHaveBeenCalled();
  });
});

// ── sendWebhookNotification ───────────────────────────────────────────────────

describe("sendWebhookNotification", () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("POSTs JSON content to a Discord webhook", async () => {
    global.fetch = jest.fn().mockResolvedValue(makeJsonResponse());
    await sendWebhookNotification({
      discordWebhook: "https://discord.com/api/webhooks/123/abc",
      message: "hello",
    });
    expect(global.fetch).toHaveBeenCalledWith(
      "https://discord.com/api/webhooks/123/abc",
      expect.objectContaining({ method: "POST" })
    );
    const call = global.fetch.mock.calls[0][1];
    expect(JSON.parse(call.body)).toEqual({ content: "hello" });
  });

  it("POSTs plain text to an ntfy.sh topic", async () => {
    global.fetch = jest.fn().mockResolvedValue(makeJsonResponse());
    await sendWebhookNotification({ ntfyTopic: "my-alerts", message: "update ready" });
    expect(global.fetch).toHaveBeenCalledWith(
      "https://ntfy.sh/my-alerts",
      expect.objectContaining({ method: "POST", body: "update ready" })
    );
  });

  it("sends to both targets when both are configured", async () => {
    global.fetch = jest.fn().mockResolvedValue(makeJsonResponse());
    await sendWebhookNotification({
      discordWebhook: "https://discord.com/api/webhooks/1/x",
      ntfyTopic: "alerts",
      message: "test",
    });
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it("sends nothing when neither target is configured", async () => {
    global.fetch = jest.fn().mockResolvedValue(makeJsonResponse());
    await sendWebhookNotification({ message: "test" });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("truncates Discord messages exceeding 2000 characters", async () => {
    global.fetch = jest.fn().mockResolvedValue(makeJsonResponse());
    const long = "x".repeat(2100);
    await sendWebhookNotification({
      discordWebhook: "https://discord.com/api/webhooks/1/x",
      message: long,
    });
    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.content.length).toBeLessThanOrEqual(2000);
    expect(body.content.endsWith("...")).toBe(true);
  });

  it("does not truncate messages within the Discord limit", async () => {
    global.fetch = jest.fn().mockResolvedValue(makeJsonResponse());
    const short = "hello world";
    await sendWebhookNotification({
      discordWebhook: "https://discord.com/api/webhooks/1/x",
      message: short,
    });
    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.content).toBe(short);
  });

  it("logs a warning on non-2xx Discord response but does not throw", async () => {
    global.fetch = jest.fn().mockResolvedValue(makeJsonResponse({}, 400));
    await expect(
      sendWebhookNotification({ discordWebhook: "https://discord.com/api/webhooks/1/x", message: "hi" })
    ).resolves.toBeUndefined();
  });

  it("logs a warning when Discord fetch throws but does not throw", async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error("Network error"));
    await expect(
      sendWebhookNotification({ discordWebhook: "https://discord.com/api/webhooks/1/x", message: "hi" })
    ).resolves.toBeUndefined();
  });
});
