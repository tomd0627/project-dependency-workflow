/**
 * @fileoverview Repo card component.
 * Renders a summary card for a single repository showing ecosystem,
 * update count, max risk score, CVE count, and PR status.
 */

import { formatEcosystem, getRepoStats } from "../utils.js";
import { createScoreBadge } from "./score-badge.js";
import { createStatusIcon } from "./status-icon.js";

/**
 * Creates a repo card element.
 *
 * @param {{ name: string, ecosystem: string, updates: Array, pr: object|null }} repo
 * @param {{ onClick?: (repo: object) => void }} [opts]
 * @returns {HTMLElement}
 */
export function createRepoCard(repo, { onClick } = {}) {
  const stats = getRepoStats(repo);

  const article = document.createElement("article");
  article.className = "repo-card";
  article.setAttribute("role", "button");
  article.setAttribute("tabindex", "0");
  article.setAttribute(
    "aria-label",
    `${repo.name} — ${stats.totalUpdates} update${stats.totalUpdates !== 1 ? "s" : ""}`
  );

  // ── Header: name + ecosystem badge ───────────────────────────────────────
  const header = document.createElement("header");
  header.className = "repo-card__header";

  const nameEl = document.createElement("h3");
  nameEl.className = "repo-card__name";
  nameEl.textContent = repo.name;

  const ecoBadge = document.createElement("span");
  ecoBadge.className = `repo-card__ecosystem eco-badge eco-badge--${repo.ecosystem}`;
  ecoBadge.textContent = formatEcosystem(repo.ecosystem);

  header.appendChild(nameEl);
  header.appendChild(ecoBadge);

  // ── Stats row ─────────────────────────────────────────────────────────────
  const statsRow = document.createElement("div");
  statsRow.className = "repo-card__stats";

  const updatesEl = document.createElement("span");
  updatesEl.className = "repo-card__stat";
  updatesEl.textContent = `${stats.totalUpdates} update${stats.totalUpdates !== 1 ? "s" : ""}`;

  const riskEl = document.createElement("span");
  riskEl.className = "repo-card__stat";
  riskEl.appendChild(createScoreBadge(stats.maxRisk));

  statsRow.appendChild(updatesEl);
  statsRow.appendChild(riskEl);

  if (stats.cveCount > 0) {
    const cveEl = document.createElement("span");
    cveEl.className = "repo-card__stat repo-card__stat--cve";
    cveEl.appendChild(
      createStatusIcon("security", { size: 14, label: `${stats.cveCount} CVE` })
    );
    cveEl.appendChild(document.createTextNode(` ${stats.cveCount} CVE`));
    statsRow.appendChild(cveEl);
  }

  // ── Footer: PR link or pending indicator ──────────────────────────────────
  const footer = document.createElement("footer");
  footer.className = "repo-card__footer";

  if (repo.pr) {
    const prLink = document.createElement("a");
    prLink.className = "repo-card__pr-link";
    prLink.href = repo.pr.url;
    prLink.target = "_blank";
    prLink.rel = "noopener noreferrer";
    prLink.appendChild(createStatusIcon("pr", { size: 14 }));
    prLink.appendChild(document.createTextNode(` PR #${repo.pr.number}`));
    footer.appendChild(prLink);
  } else {
    const pendingEl = document.createElement("span");
    pendingEl.className = "repo-card__pr-pending";
    pendingEl.appendChild(createStatusIcon("pending", { size: 14 }));
    pendingEl.appendChild(document.createTextNode(" Awaiting gate"));
    footer.appendChild(pendingEl);
  }

  article.appendChild(header);
  article.appendChild(statsRow);
  article.appendChild(footer);

  if (onClick) {
    article.addEventListener("click", () => onClick(repo));
    article.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onClick(repo);
      }
    });
  }

  return article;
}
