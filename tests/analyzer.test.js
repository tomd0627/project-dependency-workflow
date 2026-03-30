/**
 * @fileoverview Tests for the analyzer module — specifically the JSON parsing logic.
 */

import { parseClaudeResponse } from "../src/analyzer.js";

describe("parseClaudeResponse", () => {
  const validResponse = JSON.stringify({
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
  });

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
    const bad = JSON.stringify({
      packageName: "x",
      currentVersion: "1.0.0",
      latestVersion: "2.0.0",
      updateType: "major",
      riskScore: 80,
      recommendation: "INVALID",
      summary: "x",
      breakingChanges: [],
      ramifications: [],
      changelogUrl: null,
    });
    expect(() => parseClaudeResponse(bad)).toThrow(/Invalid recommendation/);
  });
});
