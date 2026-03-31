/**
 * @fileoverview Unit tests for dashboard utility functions.
 * Tests all pure functions in dashboard/src/utils.js.
 */

import {
  flattenUpdates,
  formatEcosystem,
  formatRecommendation,
  formatRelativeTime,
  formatUpdateType,
  getRiskColorVar,
  getRiskLevel,
  getRepoStats,
  getRunSummary,
  sortUpdatesByRisk,
} from "../dashboard/src/utils.js";

// ── getRiskLevel ─────────────────────────────────────────────────────────────

describe("getRiskLevel", () => {
  it("returns 'low' for score 0", () => {
    expect(getRiskLevel(0)).toBe("low");
  });

  it("returns 'low' for score at threshold (30)", () => {
    expect(getRiskLevel(30)).toBe("low");
  });

  it("returns 'medium' for score just above low threshold (31)", () => {
    expect(getRiskLevel(31)).toBe("medium");
  });

  it("returns 'medium' for score at threshold (70)", () => {
    expect(getRiskLevel(70)).toBe("medium");
  });

  it("returns 'high' for score just above medium threshold (71)", () => {
    expect(getRiskLevel(71)).toBe("high");
  });

  it("returns 'high' for score at threshold (90)", () => {
    expect(getRiskLevel(90)).toBe("high");
  });

  it("returns 'critical' for score just above high threshold (91)", () => {
    expect(getRiskLevel(91)).toBe("critical");
  });

  it("returns 'critical' for score 100", () => {
    expect(getRiskLevel(100)).toBe("critical");
  });
});

// ── getRiskColorVar ──────────────────────────────────────────────────────────

describe("getRiskColorVar", () => {
  it("maps 'low' to accent-primary", () => {
    expect(getRiskColorVar("low")).toBe("--color-accent-primary");
  });

  it("maps 'medium' to accent-warm", () => {
    expect(getRiskColorVar("medium")).toBe("--color-accent-warm");
  });

  it("maps 'high' to accent-danger", () => {
    expect(getRiskColorVar("high")).toBe("--color-accent-danger");
  });

  it("maps 'critical' to accent-danger", () => {
    expect(getRiskColorVar("critical")).toBe("--color-accent-danger");
  });

  it("returns dim fallback for unknown level", () => {
    expect(getRiskColorVar("unknown")).toBe("--color-text-dim");
  });
});

// ── formatUpdateType ─────────────────────────────────────────────────────────

describe("formatUpdateType", () => {
  it("capitalises 'patch'", () => {
    expect(formatUpdateType("patch")).toBe("Patch");
  });

  it("capitalises 'minor'", () => {
    expect(formatUpdateType("minor")).toBe("Minor");
  });

  it("capitalises 'major'", () => {
    expect(formatUpdateType("major")).toBe("Major");
  });

  it("passes through an unknown type unchanged", () => {
    expect(formatUpdateType("beta")).toBe("beta");
  });
});

// ── formatEcosystem ──────────────────────────────────────────────────────────

describe("formatEcosystem", () => {
  it("maps 'node' to 'Node.js'", () => {
    expect(formatEcosystem("node")).toBe("Node.js");
  });

  it("maps 'python' to 'Python'", () => {
    expect(formatEcosystem("python")).toBe("Python");
  });

  it("maps 'rust' to 'Rust'", () => {
    expect(formatEcosystem("rust")).toBe("Rust");
  });

  it("maps 'go' to 'Go'", () => {
    expect(formatEcosystem("go")).toBe("Go");
  });

  it("maps 'ruby' to 'Ruby'", () => {
    expect(formatEcosystem("ruby")).toBe("Ruby");
  });

  it("passes through an unknown ecosystem unchanged", () => {
    expect(formatEcosystem("elixir")).toBe("elixir");
  });
});

// ── formatRecommendation ─────────────────────────────────────────────────────

describe("formatRecommendation", () => {
  it("maps THUMBS_UP to 'Approve'", () => {
    expect(formatRecommendation("THUMBS_UP")).toBe("Approve");
  });

  it("maps THUMBS_DOWN to 'Hold'", () => {
    expect(formatRecommendation("THUMBS_DOWN")).toBe("Hold");
  });

  it("maps NEEDS_REVIEW to 'Review'", () => {
    expect(formatRecommendation("NEEDS_REVIEW")).toBe("Review");
  });

  it("passes through an unknown recommendation unchanged", () => {
    expect(formatRecommendation("UNKNOWN")).toBe("UNKNOWN");
  });
});

// ── formatRelativeTime ───────────────────────────────────────────────────────

describe("formatRelativeTime", () => {
  it("returns 'just now' for a sub-minute diff", () => {
    const now = new Date().toISOString();
    expect(formatRelativeTime(now)).toBe("just now");
  });

  it("returns singular 'minute' for exactly 1 minute", () => {
    const d = new Date(Date.now() - 1 * 60_000).toISOString();
    expect(formatRelativeTime(d)).toBe("1 minute ago");
  });

  it("returns plural 'minutes' for 10 minutes", () => {
    const d = new Date(Date.now() - 10 * 60_000).toISOString();
    expect(formatRelativeTime(d)).toBe("10 minutes ago");
  });

  it("returns singular 'hour' for exactly 1 hour", () => {
    const d = new Date(Date.now() - 1 * 3_600_000).toISOString();
    expect(formatRelativeTime(d)).toBe("1 hour ago");
  });

  it("returns plural 'hours' for 3 hours", () => {
    const d = new Date(Date.now() - 3 * 3_600_000).toISOString();
    expect(formatRelativeTime(d)).toBe("3 hours ago");
  });

  it("returns singular 'day' for exactly 1 day", () => {
    const d = new Date(Date.now() - 1 * 86_400_000).toISOString();
    expect(formatRelativeTime(d)).toBe("1 day ago");
  });

  it("returns plural 'days' for 5 days", () => {
    const d = new Date(Date.now() - 5 * 86_400_000).toISOString();
    expect(formatRelativeTime(d)).toBe("5 days ago");
  });

  it("returns a locale date string (no 'ago') for dates older than 30 days", () => {
    const d = new Date(Date.now() - 60 * 86_400_000).toISOString();
    expect(formatRelativeTime(d)).not.toContain("ago");
  });
});

// ── getRepoStats ─────────────────────────────────────────────────────────────

describe("getRepoStats", () => {
  const repo = {
    updates: [
      { riskScore: 80, advisories: [{ severity: "HIGH" }] },
      { riskScore: 40, advisories: [] },
      { riskScore: 10, advisories: [{ severity: "LOW" }, { severity: "MODERATE" }] },
    ],
  };

  it("counts totalUpdates correctly", () => {
    expect(getRepoStats(repo).totalUpdates).toBe(3);
  });

  it("returns the highest riskScore as maxRisk", () => {
    expect(getRepoStats(repo).maxRisk).toBe(80);
  });

  it("sums advisory counts across all updates", () => {
    expect(getRepoStats(repo).cveCount).toBe(3);
  });

  it("returns zeros for an empty updates array", () => {
    expect(getRepoStats({ updates: [] })).toEqual({
      totalUpdates: 0,
      maxRisk: 0,
      cveCount: 0,
    });
  });

  it("handles a missing updates property gracefully", () => {
    expect(getRepoStats({})).toEqual({ totalUpdates: 0, maxRisk: 0, cveCount: 0 });
  });
});

// ── getRunSummary ────────────────────────────────────────────────────────────

describe("getRunSummary", () => {
  const report = {
    repositories: [
      {
        updates: [
          { riskScore: 90, advisories: [{}] },
          { riskScore: 20, advisories: [] },
        ],
      },
      {
        updates: [
          { riskScore: 50, advisories: [{}] },
        ],
      },
    ],
  };

  it("counts total repositories", () => {
    expect(getRunSummary(report).totalRepos).toBe(2);
  });

  it("counts total updates across all repos", () => {
    expect(getRunSummary(report).totalUpdates).toBe(3);
  });

  it("sums CVEs across all repos", () => {
    expect(getRunSummary(report).totalCves).toBe(2);
  });

  it("returns the global maximum risk score", () => {
    expect(getRunSummary(report).maxRisk).toBe(90);
  });

  it("returns all zeros for an empty repositories array", () => {
    expect(getRunSummary({ repositories: [] })).toEqual({
      totalRepos: 0,
      totalUpdates: 0,
      totalCves: 0,
      maxRisk: 0,
    });
  });

  it("handles a missing repositories property gracefully", () => {
    expect(getRunSummary({})).toEqual({
      totalRepos: 0,
      totalUpdates: 0,
      totalCves: 0,
      maxRisk: 0,
    });
  });
});

// ── sortUpdatesByRisk ────────────────────────────────────────────────────────

describe("sortUpdatesByRisk", () => {
  const updates = [
    { name: "a", riskScore: 30 },
    { name: "b", riskScore: 90 },
    { name: "c", riskScore: 60 },
  ];

  it("sorts updates in descending risk order", () => {
    const sorted = sortUpdatesByRisk(updates);
    expect(sorted.map((u) => u.riskScore)).toEqual([90, 60, 30]);
  });

  it("does not mutate the original array", () => {
    sortUpdatesByRisk(updates);
    expect(updates[0].name).toBe("a");
  });

  it("handles an empty array", () => {
    expect(sortUpdatesByRisk([])).toEqual([]);
  });

  it("handles a single-element array", () => {
    expect(sortUpdatesByRisk([{ riskScore: 50 }])).toEqual([{ riskScore: 50 }]);
  });

  it("preserves ties in stable order", () => {
    const tied = [
      { name: "x", riskScore: 50 },
      { name: "y", riskScore: 50 },
    ];
    const sorted = sortUpdatesByRisk(tied);
    expect(sorted).toHaveLength(2);
    expect(sorted[0].riskScore).toBe(50);
  });
});

// ── flattenUpdates ───────────────────────────────────────────────────────────

describe("flattenUpdates", () => {
  const repos = [
    {
      name: "org/repo-a",
      ecosystem: "node",
      updates: [{ name: "pkg-1", riskScore: 50 }, { name: "pkg-2", riskScore: 20 }],
    },
    {
      name: "org/repo-b",
      ecosystem: "python",
      updates: [{ name: "pkg-3", riskScore: 80 }],
    },
  ];

  it("returns a flat array with all updates", () => {
    expect(flattenUpdates(repos)).toHaveLength(3);
  });

  it("annotates each update with repoName", () => {
    const flat = flattenUpdates(repos);
    expect(flat[0].repoName).toBe("org/repo-a");
    expect(flat[2].repoName).toBe("org/repo-b");
  });

  it("annotates each update with ecosystem", () => {
    const flat = flattenUpdates(repos);
    expect(flat[0].ecosystem).toBe("node");
    expect(flat[2].ecosystem).toBe("python");
  });

  it("preserves original update properties", () => {
    const flat = flattenUpdates(repos);
    expect(flat[0].name).toBe("pkg-1");
    expect(flat[0].riskScore).toBe(50);
  });

  it("handles repos with empty updates arrays", () => {
    const result = flattenUpdates([{ name: "empty", ecosystem: "go", updates: [] }]);
    expect(result).toEqual([]);
  });

  it("handles an empty repositories array", () => {
    expect(flattenUpdates([])).toEqual([]);
  });

  it("handles repos with a missing updates property", () => {
    const result = flattenUpdates([{ name: "no-updates", ecosystem: "rust" }]);
    expect(result).toEqual([]);
  });
});
