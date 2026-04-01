/**
 * @fileoverview Dashboard entry point.
 * Bootstraps the application, wires up navigation, and mounts all components.
 */

import { createRepoCard } from "./components/repo-card.js";
import { renderSidebar } from "./components/sidebar.js";
import { renderUpdateTable } from "./components/update-table.js";
import { runReport as fixtureReport } from "./fixtures/run-report.js";
import { flattenUpdates, getRepoStats } from "./utils.js";

/** Max repo cards shown on the Overview before the "Show all" button appears. */
const OVERVIEW_REPO_LIMIT = 12;

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

  // Sort by max risk descending so the most critical repos surface first.
  const sorted = [...runReport.repositories].sort(
    (a, b) => getRepoStats(b).maxRisk - getRepoStats(a).maxRisk
  );
  const visible = sorted.slice(0, OVERVIEW_REPO_LIMIT);
  const hidden = sorted.slice(OVERVIEW_REPO_LIMIT);

  for (const repo of visible) {
    grid.appendChild(createRepoCard(repo, { onClick: (r) => renderRepoDetail(r) }));
  }

  if (hidden.length > 0) {
    const footer = document.createElement("div");
    footer.className = "repo-grid__footer";

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "view-all-btn";
    btn.textContent = `Show all ${runReport.repositories.length} repositories`;
    btn.addEventListener("click", () => {
      footer.remove();
      for (const repo of hidden) {
        grid.appendChild(createRepoCard(repo, { onClick: (r) => renderRepoDetail(r) }));
      }
    });

    footer.appendChild(btn);
    grid.appendChild(footer);
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

// ── Mobile navigation ─────────────────────────────────────────────────────────

function openSidebarMenu() {
  document.getElementById("sidebar")?.classList.add("sidebar--open");
  document.getElementById("sidebar-overlay")?.classList.add("sidebar-overlay--visible");
  const toggle = document.getElementById("menu-toggle");
  if (toggle) {
    toggle.classList.add("menu-toggle--open");
    toggle.setAttribute("aria-expanded", "true");
    toggle.setAttribute("aria-label", "Close navigation");
  }
  document.body.style.overflow = "hidden";
}

function closeSidebarMenu() {
  document.getElementById("sidebar")?.classList.remove("sidebar--open");
  document.getElementById("sidebar-overlay")?.classList.remove("sidebar-overlay--visible");
  const toggle = document.getElementById("menu-toggle");
  if (toggle) {
    toggle.classList.remove("menu-toggle--open");
    toggle.setAttribute("aria-expanded", "false");
    toggle.setAttribute("aria-label", "Open navigation");
  }
  document.body.style.overflow = "";
}

function setupMobileNav() {
  document.getElementById("menu-toggle")?.addEventListener("click", () => {
    const isOpen = document.getElementById("sidebar")?.classList.contains("sidebar--open");
    if (isOpen) closeSidebarMenu(); else openSidebarMenu();
  });
  document.getElementById("sidebar-overlay")?.addEventListener("click", closeSidebarMenu);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeSidebarMenu(); });
}

// ── Router ───────────────────────────────────────────────────────────────────

/**
 * Navigates to a named section, re-rendering the sidebar and main content.
 * @param {string} id - 'overview' | 'updates' | 'advisories'
 */
function navigate(id) {
  closeSidebarMenu();
  renderSidebar(sidebarRoot, runReport, { activeId: id, onNav: navigate, onClose: closeSidebarMenu });

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
  setupMobileNav();
  navigate("overview");
}

bootstrap();
