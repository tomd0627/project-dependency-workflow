/**
 * @fileoverview Status icon component.
 * Creates accessible inline SVG icons for pipeline status values.
 * Uses hand-picked Lucide icon paths — no runtime dependency on the lucide package.
 */

/**
 * SVG path data for each supported status.
 * All paths are designed for a 24×24 viewBox.
 * @type {Record<string, string>}
 */
const ICON_PATHS = {
  /** CheckCircle2 — approved / THUMBS_UP */
  approved:
    "M22 11.08V12a10 10 0 1 1-5.93-9.14M22 4 12 14.01l-3-3",
  /** XCircle — rejected / THUMBS_DOWN */
  rejected:
    "M18 6 6 18M6 6l12 12",
  /** Clock — pending / NEEDS_REVIEW */
  pending:
    "M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10zM12 6v6l4 2",
  /** ShieldAlert — security advisory */
  security:
    "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10zM12 8v4M12 16h.01",
  /** GitPullRequest — PR link */
  pr:
    "M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9v1a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V9",
  /** ArrowUpCircle — update available */
  update:
    "M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10zM12 8v8M8 12l4-4 4 4",
};

/**
 * Creates an accessible SVG icon element.
 *
 * @param {keyof ICON_PATHS} status - Icon identifier
 * @param {{ size?: number, label?: string }} [opts]
 *   - `size`  — width/height in px (default 16)
 *   - `label` — aria-label text; omit to render as decorative (aria-hidden)
 * @returns {SVGSVGElement}
 */
export function createStatusIcon(status, { size = 16, label } = {}) {
  const pathData = ICON_PATHS[status] ?? ICON_PATHS.update;

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("class", `status-icon status-icon--${status}`);

  if (label) {
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", label);
  } else {
    svg.setAttribute("aria-hidden", "true");
  }

  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", pathData);
  svg.appendChild(path);

  return svg;
}
