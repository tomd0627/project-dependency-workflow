/**
 * @fileoverview Static run-report fixture for dashboard development and demos.
 * Shape mirrors the JSON the pipeline would write to .cache/run-report.json
 * after a full pipeline execution.
 */

export const runReport = {
  runAt: "2026-03-29T08:14:32Z",
  durationSeconds: 47.3,

  repositories: [
    {
      name: "acme-corp/api-server",
      ecosystem: "node",
      updates: [
        {
          name: "express",
          currentVersion: "4.18.2",
          latestVersion: "5.0.1",
          updateType: "major",
          riskScore: 85,
          recommendation: "NEEDS_REVIEW",
          advisories: [],
        },
        {
          name: "axios",
          currentVersion: "1.6.2",
          latestVersion: "1.7.9",
          updateType: "minor",
          riskScore: 42,
          recommendation: "NEEDS_REVIEW",
          advisories: [
            {
              ghsaId: "GHSA-wf5p-g6vw-rhxx",
              severity: "MODERATE",
              summary: "Axios vulnerable to CSRF via cross-origin request",
            },
          ],
        },
        {
          name: "dotenv",
          currentVersion: "16.3.1",
          latestVersion: "16.4.7",
          updateType: "patch",
          riskScore: 12,
          recommendation: "THUMBS_UP",
          advisories: [],
        },
      ],
      pr: {
        number: 42,
        url: "https://github.com/acme-corp/api-server/pull/42",
        status: "open",
      },
    },

    {
      name: "acme-corp/data-pipeline",
      ecosystem: "python",
      updates: [
        {
          name: "requests",
          currentVersion: "2.31.0",
          latestVersion: "2.32.3",
          updateType: "minor",
          riskScore: 78,
          recommendation: "NEEDS_REVIEW",
          advisories: [
            {
              ghsaId: "GHSA-9wx4-h78v-vm56",
              severity: "HIGH",
              summary: "Requests allows HTTP header injection in redirects",
            },
          ],
        },
        {
          name: "pydantic",
          currentVersion: "2.5.0",
          latestVersion: "2.10.6",
          updateType: "minor",
          riskScore: 35,
          recommendation: "THUMBS_UP",
          advisories: [],
        },
      ],
      pr: {
        number: 7,
        url: "https://github.com/acme-corp/data-pipeline/pull/7",
        status: "open",
      },
    },

    {
      name: "acme-corp/web-frontend",
      ecosystem: "node",
      updates: [
        {
          name: "vite",
          currentVersion: "5.0.8",
          latestVersion: "6.2.0",
          updateType: "major",
          riskScore: 92,
          recommendation: "THUMBS_DOWN",
          advisories: [
            {
              ghsaId: "GHSA-vg6x-rcgg-rjx6",
              severity: "CRITICAL",
              summary: "Vite allows server.fs.deny bypass via URL encoding",
            },
          ],
        },
        {
          name: "typescript",
          currentVersion: "5.3.3",
          latestVersion: "5.8.2",
          updateType: "minor",
          riskScore: 18,
          recommendation: "THUMBS_UP",
          advisories: [],
        },
        {
          name: "@vitejs/plugin-react",
          currentVersion: "4.2.1",
          latestVersion: "4.3.4",
          updateType: "patch",
          riskScore: 8,
          recommendation: "THUMBS_UP",
          advisories: [],
        },
      ],
      pr: null, // blocked at gate — awaiting manual approval
    },
  ],
};
