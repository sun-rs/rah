import { readFileSync } from "node:fs";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const packageJson = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
) as { version?: string };

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    __RAH_APP_VERSION__: JSON.stringify(packageJson.version ?? "0.0.0"),
    __RAH_WORKBENCH_VERSION__: JSON.stringify("1.0"),
  },
});
