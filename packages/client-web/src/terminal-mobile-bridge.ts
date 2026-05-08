export type MobileBridgeFocusSource = "surface" | "shortcut";

export type MobileBridgeFocusOptions = {
  allowBrowserScroll?: boolean;
  scrollBlock?: ScrollLogicalPosition;
};

export function mobileBridgeFocusOptionsForSource(
  source: MobileBridgeFocusSource,
): MobileBridgeFocusOptions {
  if (source === "surface") {
    return {
      allowBrowserScroll: false,
      scrollBlock: "nearest",
    };
  }
  return {
    allowBrowserScroll: false,
    scrollBlock: "nearest",
  };
}
