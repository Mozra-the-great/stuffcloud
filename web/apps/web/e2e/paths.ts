import { resolve } from 'node:path';

/** `web/apps/web`. */
export const APP_ROOT = resolve(import.meta.dirname, '..');

/** Where `pnpm e2e:build` writes the end-to-end build (ignored by git). */
export const E2E_DIST = resolve(APP_ROOT, 'dist-e2e');
