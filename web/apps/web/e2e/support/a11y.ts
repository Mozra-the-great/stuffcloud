import type { Page } from '@playwright/test';

/** Runs the accessibility rules on the page as it is right now; throws on a violation. */
export type A11yRunner = (page: Page, label: string) => Promise<void>;

export interface A11yGate {
  /** Whether a runner is wired in. */
  readonly enabled: boolean;
  /** Checks the page that is on screen; `label` names the state in the report. */
  check: (page: Page, label: string) => Promise<void>;
}

/**
 * The accessibility gate. The specs call `a11y.check(page, '<state>')` after each state they put
 * on screen. `fixtures.ts` passes the axe runner (`axe.ts`, T-05 #13), so every call scans the page
 * and fails the test on a violation; without a runner (`createA11yGate()`) the call does nothing,
 * which only the unit tests of this module use.
 */
export function createA11yGate(runner?: A11yRunner): A11yGate {
  return {
    enabled: runner !== undefined,
    check: async (page, label): Promise<void> => {
      await runner?.(page, label);
    },
  };
}
