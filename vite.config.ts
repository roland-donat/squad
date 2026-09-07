import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The UI is served by the squad server itself, in Vite middleware mode during
// development and from `dist/ui` in production. There is therefore no dev proxy:
// the API and the UI always share a single origin.
export default defineConfig({
  root: "src/ui",
  plugins: [react()],
  build: {
    outDir: "../../dist/ui",
    emptyOutDir: true,
  },
});
