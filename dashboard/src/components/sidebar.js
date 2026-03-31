/**
 * @fileoverview Sidebar navigation component.
 * Renders the primary navigation, run statistics, and last-run timestamp.
 */

import { formatRelativeTime, getRunSummary } from "../utils.js";

/** Navigation items in display order. */
const NAV_ITEMS = [
  {
    id: "overview",
    label: "Overview",
    path: "M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
  },
  {
    id: "updates",
    label: "All Updates",
    path: "M4 6h16M4 12h16M4 18h16",
  },
  {
    id: "advisories",
    label: "Advisories",
    path: "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z",
  },
];

/**
 * Creates a small navigation SVG icon.
 * @param {string} d - SVG path data
 * @returns {SVGSVGElement}
 */
function createNavIcon(d) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "18");
  svg.setAttribute("height", "18");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");

  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", d);
  svg.appendChild(path);
  return svg;
}

/**
 * Renders the sidebar into the given root element.
 *
 * @param {HTMLElement} root - Mount point (the #sidebar-root element)
 * @param {object} report - Full run report
 * @param {{ activeId?: string, onNav?: (id: string) => void }} [opts]
 */
export function renderSidebar(root, report, { activeId = "overview", onNav } = {}) {
  const summary = getRunSummary(report);
  root.innerHTML = "";

  // ── Brand ──────────────────────────────────────────────────────────────────
  const brand = document.createElement("div");
  brand.className = "sidebar__brand";
  brand.innerHTML = `<svg class="sidebar__logo" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/></svg>
    <span class="sidebar__title">Dep Bot</span>`;

  // ── Navigation ─────────────────────────────────────────────────────────────
  const nav = document.createElement("nav");
  nav.setAttribute("aria-label", "Dashboard sections");

  const ul = document.createElement("ul");
  ul.className = "sidebar__nav";

  for (const item of NAV_ITEMS) {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.className =
      `sidebar__nav-btn${item.id === activeId ? " sidebar__nav-btn--active" : ""}`;
    btn.setAttribute("aria-current", item.id === activeId ? "page" : "false");
    btn.dataset.navId = item.id;
    btn.appendChild(createNavIcon(item.path));
    btn.appendChild(document.createTextNode(item.label));
    btn.addEventListener("click", () => onNav?.(item.id));
    li.appendChild(btn);
    ul.appendChild(li);
  }

  nav.appendChild(ul);

  // ── Stats ──────────────────────────────────────────────────────────────────
  const statsSection = document.createElement("div");
  statsSection.className = "sidebar__stats";

  const statEntries = [
    { label: "Repos", value: summary.totalRepos },
    { label: "Updates", value: summary.totalUpdates },
    { label: "CVEs", value: summary.totalCves },
    { label: "Max Risk", value: summary.maxRisk },
  ];

  for (const { label, value } of statEntries) {
    const item = document.createElement("div");
    item.className = "sidebar__stat";
    item.innerHTML =
      `<span class="sidebar__stat-value">${value}</span>` +
      `<span class="sidebar__stat-label">${label}</span>`;
    statsSection.appendChild(item);
  }

  // ── Last run ───────────────────────────────────────────────────────────────
  const lastRun = document.createElement("div");
  lastRun.className = "sidebar__last-run";
  lastRun.textContent = `Last run: ${formatRelativeTime(report.runAt)}`;

  root.appendChild(brand);
  root.appendChild(nav);
  root.appendChild(statsSection);
  root.appendChild(lastRun);
}
