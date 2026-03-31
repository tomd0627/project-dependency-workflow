/**
 * @fileoverview Score badge component.
 * Renders a color-coded chip showing a numeric risk score (0–100).
 * Colors are sourced from CSS custom properties for WCAG-compliant contrast.
 */

import { getRiskColorVar, getRiskLevel } from "../utils.js";

/**
 * Creates a risk score badge element.
 *
 * @param {number} score - Risk score 0–100
 * @returns {HTMLSpanElement}
 *
 * @example
 * container.appendChild(createScoreBadge(85)); // renders a red "85" chip
 */
export function createScoreBadge(score) {
  const level = getRiskLevel(score);
  const colorVar = getRiskColorVar(level);

  const span = document.createElement("span");
  span.className = `score-badge score-badge--${level}`;
  span.style.setProperty("--badge-color", `var(${colorVar})`);
  span.textContent = String(score);
  span.setAttribute("aria-label", `Risk score ${score} — ${level}`);
  span.setAttribute("title", `Risk score: ${score}/100 (${level})`);

  return span;
}
