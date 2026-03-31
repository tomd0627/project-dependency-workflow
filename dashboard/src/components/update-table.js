/**
 * @fileoverview Update table component.
 * Renders a sortable table of dependency updates with risk scores,
 * recommendations, and CVE severity chips.
 */

import {
  formatEcosystem,
  formatRecommendation,
  formatUpdateType,
  sortUpdatesByRisk,
} from "../utils.js";
import { createScoreBadge } from "./score-badge.js";
import { createStatusIcon } from "./status-icon.js";

/** Maps recommendation values to status icon identifiers. */
const REC_ICON = {
  THUMBS_UP: "approved",
  THUMBS_DOWN: "rejected",
  NEEDS_REVIEW: "pending",
};

/**
 * Creates a single table row for one dependency update.
 * @param {object} update
 * @returns {HTMLTableRowElement}
 */
function createUpdateRow(update) {
  const tr = document.createElement("tr");
  tr.className = "update-table__row";

  // Package name
  const tdName = document.createElement("td");
  tdName.className = "update-table__cell update-table__cell--name";
  tdName.textContent = update.name;

  // Repository
  const tdRepo = document.createElement("td");
  tdRepo.className = "update-table__cell update-table__cell--repo";
  tdRepo.textContent = update.repoName ?? "—";

  // Ecosystem badge
  const tdEco = document.createElement("td");
  tdEco.className = "update-table__cell";
  const ecoBadge = document.createElement("span");
  ecoBadge.className = `eco-badge eco-badge--${update.ecosystem}`;
  ecoBadge.textContent = formatEcosystem(update.ecosystem);
  tdEco.appendChild(ecoBadge);

  // Version: current → latest
  const tdVersion = document.createElement("td");
  tdVersion.className = "update-table__cell update-table__cell--version";
  const fromEl = document.createElement("span");
  fromEl.className = "version-from";
  fromEl.textContent = update.currentVersion;
  const arrowEl = document.createElement("span");
  arrowEl.className = "version-arrow";
  arrowEl.setAttribute("aria-hidden", "true");
  arrowEl.textContent = "→";
  const toEl = document.createElement("span");
  toEl.className = "version-to";
  toEl.textContent = update.latestVersion;
  tdVersion.appendChild(fromEl);
  tdVersion.appendChild(arrowEl);
  tdVersion.appendChild(toEl);

  // Update type badge
  const tdType = document.createElement("td");
  tdType.className = "update-table__cell";
  const typeBadge = document.createElement("span");
  typeBadge.className = `type-badge type-badge--${update.updateType}`;
  typeBadge.textContent = formatUpdateType(update.updateType);
  tdType.appendChild(typeBadge);

  // Risk score badge
  const tdRisk = document.createElement("td");
  tdRisk.className = "update-table__cell update-table__cell--risk";
  tdRisk.appendChild(createScoreBadge(update.riskScore));

  // Recommendation
  const tdRec = document.createElement("td");
  tdRec.className = "update-table__cell";
  const recStatus = REC_ICON[update.recommendation] ?? "pending";
  const recWrapper = document.createElement("span");
  recWrapper.className = `rec-badge rec-badge--${recStatus}`;
  recWrapper.appendChild(createStatusIcon(recStatus, { size: 14 }));
  recWrapper.appendChild(
    document.createTextNode(` ${formatRecommendation(update.recommendation)}`)
  );
  tdRec.appendChild(recWrapper);

  // CVE severity chip
  const tdCve = document.createElement("td");
  tdCve.className = "update-table__cell update-table__cell--cve";
  if (update.advisories?.length > 0) {
    const { severity, summary } = update.advisories[0];
    const chip = document.createElement("span");
    chip.className = `cve-chip cve-chip--${severity.toLowerCase()}`;
    chip.textContent = severity;
    chip.setAttribute("title", summary);
    tdCve.appendChild(chip);
  } else {
    tdCve.textContent = "—";
  }

  for (const td of [tdName, tdRepo, tdEco, tdVersion, tdType, tdRisk, tdRec, tdCve]) {
    tr.appendChild(td);
  }

  return tr;
}

/**
 * Renders the update table into a container element.
 * Updates are pre-sorted by risk score, highest first.
 *
 * @param {HTMLElement} root - Container element to render into
 * @param {Array} updates - Flat array of update objects (may include repoName/ecosystem)
 */
export function renderUpdateTable(root, updates) {
  root.innerHTML = "";

  if (updates.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "No updates found.";
    root.appendChild(empty);
    return;
  }

  const table = document.createElement("table");
  table.className = "update-table";
  table.setAttribute("aria-label", "Dependency updates");

  const thead = document.createElement("thead");
  const headerRow = document.createElement("tr");
  const headers = ["Package", "Repository", "Ecosystem", "Version", "Type", "Risk", "Rec.", "CVE"];
  for (const h of headers) {
    const th = document.createElement("th");
    th.className = "update-table__th";
    th.scope = "col";
    th.textContent = h;
    headerRow.appendChild(th);
  }
  thead.appendChild(headerRow);

  const tbody = document.createElement("tbody");
  for (const update of sortUpdatesByRisk(updates)) {
    tbody.appendChild(createUpdateRow(update));
  }

  table.appendChild(thead);
  table.appendChild(tbody);
  root.appendChild(table);
}
