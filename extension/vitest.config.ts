import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'happy-dom',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**'],
      // Boundary code that can only be exercised inside a Chrome MV3 runtime,
      // plus type-only modules (no executable statements). Keeping them in
      // coverage would peg the floor to 0% and obscure regressions in the
      // pure-logic layer that *is* covered by the offline suite.
      exclude: [
        'src/background/**', // Chrome service-worker entry; covered by the README smoke test
        'src/popup/main.ts', // 3-line entry that calls renderPopup
        'src/lib/messages.ts', // TypeScript interfaces; no runtime code
      ],
      thresholds: {
        // Global floors with a ~3-point buffer below measured (88.91/80.13/
        // 93.33/88.91 on the synthesized fixture). Tight enough to catch a
        // meaningful regression; loose enough not to fail spuriously when
        // adding a new file with a small uncovered tail.
        statements: 85,
        branches: 75,
        functions: 90,
        lines: 85,
        // The lib layer is where logic regressions actually matter, so hold
        // it tighter. Without this, a drop from 95% to 85% in lib would be
        // masked by the rest of the codebase staying high.
        'src/lib/**': {
          statements: 90,
          branches: 80,
          functions: 95,
          lines: 90,
        },
      },
    },
  },
});
