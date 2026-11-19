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
 * The seam for the accessibility gate. The specs call `a11y.check(page, '<state>')` after each
 * state they put on screen; with no runner the call does nothing, so the gate is off. T-05 (#13)
 * turns it on by passing an axe runner to `createA11yGate` in `fixtures.ts`, without touching
 * a single spec.
 */
export function createA11yGate(runner?: A11yRunner): A11yGate {
  return {
    enabled: runner !== undefined,
    check: async (page, label): Promise<void> => {
      await runner?.(page, label);
    },
  };
}
