declare module "*.svg" {
  const src: string;
  export default src;
}

declare module "*.png" {
  const src: string;
  export default src;
}

declare module "mermaid/dist/mermaid.esm.min.mjs" {
  const mermaid: typeof import("mermaid").default;
  export default mermaid;
}

declare const __RAH_APP_VERSION__: string;
declare const __RAH_WORKBENCH_VERSION__: string;
