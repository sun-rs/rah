export const WORKBENCH_HEADER_LAYOUT = {
  heightClassName: "h-10",
  heightCssValue: "2.5rem",
  heightPx: 40,
} as const;

export function pwaWorkbenchNoticeTop(): string {
  return `calc(env(safe-area-inset-top, 0px) + ${WORKBENCH_HEADER_LAYOUT.heightCssValue})`;
}
