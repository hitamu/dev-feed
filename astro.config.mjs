import { defineConfig } from 'astro/config';

// SITE_URL / BASE_PATH are injected by the GitHub Pages workflow
// (actions/configure-pages outputs). Local dev serves from root.
export default defineConfig({
  site: process.env.SITE_URL,
  base: process.env.BASE_PATH || '/',
  build: {
    // Emit dist/pages/2.html instead of dist/pages/2/index.html so the
    // infinite-scroll fetch URL is a plain file path.
    format: 'file',
  },
});
