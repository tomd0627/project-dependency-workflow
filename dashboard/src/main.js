/**
 * @fileoverview Dashboard entry point.
 * Bootstraps the application, wires up navigation, and mounts all components.
 */

import { createRepoCard } from "./components/repo-card.js";
import { renderSidebar } from "./components/sidebar.js";
import { renderUpdateTable } from "./components/update-table.js";
import { runReport as fixtureReport } from "./fixtures/run-report.js";
import { flattenUpdates } from "./utils.js";

// Populated at bootstrap — either live data from /run-report.json or the fixture.
let runReport = fixtureReport;

const sidebarRoot = /** @type {HTMLElement} */ (document.getElementById("sidebar-root"));
const appRoot = /** @type {HTMLElement} */ (document.getElementById("app-root"));
const announcer = /** @type {HTMLElement} */ (document.getElementById("status-announcer"));

/**
 * Announces a message to screen readers via the live region.
 * @param {string} message
 */
function announce(message) {
  announcer.textContent = "";
  // Brief timeout ensures the DOM mutation fires a fresh announcement event.
  setTimeout(() => { announcer.textContent = message; }, 50);
}

// ── Section renderers ────────────────────────────────────────────────────────

/**
 * Renders the overview: repo grid + full update table.
 */
function renderOverview() {
  appRoot.innerHTML = "";

  const header = createPageHeader(
    "Overview",
    `${runReport.repositories.length} repositories · ${runReport.durationSeconds}s pipeline run`
  );

  // Repo grid
  const repoSection = document.createElement("section");
  repoSection.setAttribute("aria-labelledby", "section-repos");

  const repoHeading = createSectionHeading("Repositories", "section-repos");
  const grid = document.createElement("div");
  grid.className = "repo-grid";

  for (const repo of runReport.repositories) {
    grid.appendChild(
      createRepoCard(repo, { onClick: (r) => renderRepoDetail(r) })
    );
  }

  repoSection.appendChild(repoHeading);
  repoSection.appendChild(grid);

  // Updates table
  const tableSection = document.createElement("section");
  tableSection.setAttribute("aria-labelledby", "section-updates");

  const tableHeading = createSectionHeading("All Updates", "section-updates");
  const tableRoot = document.createElement("div");
  tableRoot.className = "table-wrapper";
  renderUpdateTable(tableRoot, flattenUpdates(runReport.repositories));

  tableSection.appendChild(tableHeading);
  tableSection.appendChild(tableRoot);

  appRoot.appendChild(header);
  appRoot.appendChild(repoSection);
  appRoot.appendChild(tableSection);

  announce("Overview loaded");
}

/**
 * Renders all updates across every repository in a flat table.
 */
function renderUpdatesSection() {
  appRoot.innerHTML = "";

  const allUpdates = flattenUpdates(runReport.repositories);
  const header = createPageHeader(
    "All Updates",
    `${allUpdates.length} total updates across ${runReport.repositories.length} repositories`
  );

  const tableRoot = document.createElement("div");
  tableRoot.className = "table-wrapper";
  renderUpdateTable(tableRoot, allUpdates);

  appRoot.appendChild(header);
  appRoot.appendChild(tableRoot);

  announce("All updates loaded");
}

/**
 * Renders only updates that have one or more CVE advisories.
 */
function renderAdvisoriesSection() {
  appRoot.innerHTML = "";

  const withCve = flattenUpdates(runReport.repositories).filter(
    (u) => u.advisories?.length > 0
  );

  const header = createPageHeader(
    "Advisories",
    `${withCve.length} package${withCve.length !== 1 ? "s" : ""} with known vulnerabilities`
  );

  const tableRoot = document.createElement("div");
  tableRoot.className = "table-wrapper";
  renderUpdateTable(tableRoot, withCve);

  appRoot.appendChild(header);
  appRoot.appendChild(tableRoot);

  announce("Advisories loaded");
}

/**
 * Renders the detail view for a single repository.
 * @param {object} repo
 */
function renderRepoDetail(repo) {
  appRoot.innerHTML = "";

  const header = document.createElement("header");
  header.className = "page-header";

  const backBtn = document.createElement("button");
  backBtn.className = "back-btn";
  backBtn.setAttribute("aria-label", "Back to overview");
  backBtn.textContent = "← Back";
  backBtn.addEventListener("click", () => navigate("overview"));

  const h1 = document.createElement("h1");
  h1.className = "page-title";
  h1.textContent = repo.name;

  header.appendChild(backBtn);
  header.appendChild(h1);

  const tableRoot = document.createElement("div");
  tableRoot.className = "table-wrapper";

  const updates = (repo.updates ?? []).map((u) => ({
    ...u,
    repoName: repo.name,
    ecosystem: repo.ecosystem,
  }));
  renderUpdateTable(tableRoot, updates);

  appRoot.appendChild(header);
  appRoot.appendChild(tableRoot);

  announce(`Viewing ${repo.name}`);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Creates a page <header> with a title and optional subtitle.
 * @param {string} title
 * @param {string} [subtitle]
 * @returns {HTMLElement}
 */
function createPageHeader(title, subtitle) {
  const header = document.createElement("header");
  header.className = "page-header";

  const h1 = document.createElement("h1");
  h1.className = "page-title";
  h1.textContent = title;
  header.appendChild(h1);

  if (subtitle) {
    const p = document.createElement("p");
    p.className = "page-subtitle";
    p.textContent = subtitle;
    header.appendChild(p);
  }

  return header;
}

/**
 * Creates an <h2> section heading with an id for aria-labelledby.
 * @param {string} text
 * @param {string} id
 * @returns {HTMLHeadingElement}
 */
function createSectionHeading(text, id) {
  const h2 = document.createElement("h2");
  h2.className = "section-title";
  h2.id = id;
  h2.textContent = text;
  return h2;
}

// ── Router ───────────────────────────────────────────────────────────────────

/**
 * Navigates to a named section, re-rendering the sidebar and main content.
 * @param {string} id - 'overview' | 'updates' | 'advisories'
 */
function navigate(id) {
  renderSidebar(sidebarRoot, runReport, { activeId: id, onNav: navigate });

  if (id === "overview") renderOverview();
  else if (id === "updates") renderUpdatesSection();
  else if (id === "advisories") renderAdvisoriesSection();
}

// ── Bootstrap ────────────────────────────────────────────────────────────────

/**
 * Fetches the live run report from /run-report.json.
 * Falls back to the fixture silently if the file is absent (local dev, first run).
 */
async function bootstrap() {
  try {
    const res = await fetch("/run-report.json");
    if (res.ok) {
      const data = await res.json();
      // Only use live data if it has actual repositories.
      if (Array.isArray(data.repositories) && data.repositories.length > 0) {
        runReport = data;
      }
    }
  } catch {
    // Network error or missing file — fixture data is already in place.
  }
  navigate("overview");
}

bootstrap();
