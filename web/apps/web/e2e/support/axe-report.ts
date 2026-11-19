import type { Result } from 'axe-core';

/**
 * The axe rule sets that gate the build: every rule that maps to a WCAG A or AA success criterion
 * up to WCAG 2.2 (SPEC 12). `best-practice` rules (landmarks, one `h1`, no skipped heading levels)
 * are part of the gate as well: they are the rules the shell and the tool frame were built to.
 * Rules axe marks as experimental stay off.
 */
export const GATE_TAGS: readonly string[] = [
  'wcag2a',
  'wcag2aa',
  'wcag21a',
  'wcag21aa',
  'wcag22aa',
  'best-practice',
];

/** How many nodes of one violation are listed before the report says "and N more". */
const NODES_SHOWN = 5;

/** The report of one scan: what is wrong, where, and how to read up on it. Empty when clean. */
export function formatViolations(label: string, violations: readonly Result[]): string {
  if (violations.length === 0) {
    return '';
  }
  const lines: string[] = [
    `${String(violations.length)} accessibility violation(s) in "${label}" (axe ${GATE_TAGS.join(', ')}):`,
  ];
  for (const violation of violations) {
    lines.push(
      '',
      `- ${violation.id} (${violation.impact ?? 'unrated'}): ${violation.help}`,
      `  ${violation.helpUrl}`,
    );
    for (const node of violation.nodes.slice(0, NODES_SHOWN)) {
      lines.push(`  at ${node.target.join(' >> ')}`, `     ${node.html.slice(0, 160)}`);
      if (node.failureSummary !== undefined) {
        lines.push(`     ${node.failureSummary.split('\n').join('\n     ')}`);
      }
    }
    if (violation.nodes.length > NODES_SHOWN) {
      lines.push(`  ... and ${String(violation.nodes.length - NODES_SHOWN)} more`);
    }
  }
  return lines.join('\n');
}
