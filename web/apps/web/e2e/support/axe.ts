import AxeBuilder from '@axe-core/playwright';
import type { A11yRunner } from './a11y.ts';
import { formatViolations, GATE_TAGS } from './axe-report.ts';

/**
 * The axe runner of the a11y gate (`createA11yGate` in `a11y.ts`): scans the page as it is on
 * screen, in the real browser (contrast, focusability and the accessibility tree are only
 * meaningful there), and throws with a readable report when a rule is violated. Zero violations
 * is the bar, whatever the impact: nothing is waved through as "minor".
 */
export function createAxeRunner(): A11yRunner {
  return async (page, label): Promise<void> => {
    const results = await new AxeBuilder({ page }).withTags([...GATE_TAGS]).analyze();
    const report = formatViolations(label, results.violations);
    if (report !== '') {
      throw new Error(report);
    }
  };
}
