import { readFileSync } from "node:fs";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const packageJson = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
) as { version?: string };

function shikiLanguageChunkName(id: string): string | null {
  const match = /\/@shikijs\/langs\/(?:dist\/)?([^/.?]+)(?:\.[^/?]+)?(?:\?.*)?$/.exec(id);
  if (!match?.[1]) {
    return null;
  }
  return `vendor-shiki-lang-${match[1].replace(/[^a-z0-9_-]/gi, "-")}`;
}

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) {
            return undefined;
          }
          if (
            id.includes("/react/") ||
            id.includes("/react-dom/") ||
            id.includes("/scheduler/")
          ) {
            return "vendor-react";
          }
          if (id.includes("/@xterm/")) {
            return "vendor-xterm";
          }
          if (
            id.includes("/shiki/") ||
            id.includes("/@shikijs/core/") ||
            id.includes("/@shikijs/engine-javascript/")
          ) {
            return "vendor-shiki-core";
          }
          const shikiLanguageChunk = shikiLanguageChunkName(id);
          if (shikiLanguageChunk) {
            return shikiLanguageChunk;
          }
          if (id.includes("/@shikijs/themes/")) {
            return "vendor-shiki-themes";
          }
          if (
            id.includes("/react-markdown/") ||
            id.includes("/remark-") ||
            id.includes("/rehype-") ||
            id.includes("/unified/") ||
            id.includes("/micromark") ||
            id.includes("/mdast-") ||
            id.includes("/hast-") ||
            id.includes("/unist-") ||
            id.includes("/vfile") ||
            id.includes("/property-information/") ||
            id.includes("/space-separated-tokens/") ||
            id.includes("/comma-separated-tokens/") ||
            id.includes("/html-url-attributes/")
          ) {
            return "vendor-markdown";
          }
          if (id.includes("/@radix-ui/")) {
            return "vendor-radix";
          }
          return "vendor";
        },
      },
    },
  },
  define: {
    __RAH_APP_VERSION__: JSON.stringify(packageJson.version ?? "0.0.0"),
    __RAH_WORKBENCH_VERSION__: JSON.stringify("1.0"),
  },
});
