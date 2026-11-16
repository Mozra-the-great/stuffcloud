import { resolve } from 'node:path';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [svelte()],
  build: {
    target: 'es2023',
    sourcemap: true,
    // Never inline assets as data: URIs: the CSP allows fonts and images from the own origin only.
    assetsInlineLimit: 0,
    rolldownOptions: {
      input: {
        index: resolve(import.meta.dirname, 'index.html'),
        // Component gallery: the page the a11y and visual checks (T-05, T-06) run against.
        gallery: resolve(import.meta.dirname, 'gallery.html'),
      },
    },
  },
});
