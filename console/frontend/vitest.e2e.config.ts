import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Real-HTTP UI E2E (TASK-012): loads data from a live Console started by the
// Go E2E test. Kept out of the default `npm test` include set.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./test/setup.ts"],
    include: ["test-e2e/**/*.e2e.tsx"],
    testTimeout: 30_000,
  },
});
