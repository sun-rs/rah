const LAB_STORAGE_KEY = "rah.showLab";
const LAB_QUERY_PARAM = "lab";

function parseBooleanFlag(value: string | null): boolean | undefined {
  if (!value) {
    return undefined;
  }

  switch (value.trim().toLowerCase()) {
    case "1":
    case "true":
    case "yes":
    case "on":
      return true;
    case "0":
    case "false":
    case "no":
    case "off":
      return false;
    default:
      return undefined;
  }
}

export function isLabModeEnabled(): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  const queryValue = parseBooleanFlag(
    new URLSearchParams(window.location.search).get(LAB_QUERY_PARAM),
  );
  if (queryValue !== undefined) {
    return queryValue;
  }

  return parseBooleanFlag(window.localStorage.getItem(LAB_STORAGE_KEY)) ?? false;
}

