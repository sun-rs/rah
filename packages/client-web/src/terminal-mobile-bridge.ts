export type MobileBridgeFocusSource = "shortcut";

export type MobileBridgeFocusOptions = {
  allowBrowserScroll?: boolean;
  scrollBlock?: ScrollLogicalPosition;
};

export function mobileBridgeFocusOptionsForSource(
  source: MobileBridgeFocusSource,
): MobileBridgeFocusOptions {
  void source;
  return {
    allowBrowserScroll: false,
    scrollBlock: "nearest",
  };
}
