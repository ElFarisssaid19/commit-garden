import { defineConfig } from 'vite';

export default defineConfig({
  // Relative asset paths so the build works at the domain root (local preview)
  // and under the GitHub Pages project subpath (/commit-garden/).
  base: './',
  build: {
    // three.js alone is ~600 kB minified and can't be split further, so it gets
    // its own long-cacheable chunk and the warning threshold sits just above it.
    chunkSizeWarningLimit: 700,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [{ name: 'three', test: /node_modules[\\/]three[\\/]/ }],
        },
      },
    },
  },
});
