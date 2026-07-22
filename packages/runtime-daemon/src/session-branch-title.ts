const NUMBERED_FORK_SUFFIX = /^(.*) \((\d+)\)$/;

function normalizedTitle(value: string | null | undefined): string | undefined {
  const title = value?.trim();
  return title || undefined;
}

function splitNumberedForkTitle(title: string): { base: string; index: number } {
  const match = NUMBERED_FORK_SUFFIX.exec(title);
  const index = match ? Number.parseInt(match[2] ?? "", 10) : Number.NaN;
  if (!match || !Number.isSafeInteger(index) || index < 2) {
    return { base: title, index: 1 };
  }
  return {
    base: normalizedTitle(match[1]) ?? title,
    index,
  };
}

/**
 * Allocate the next desktop-style title for a persistent fork.
 *
 * The original thread is generation 1 and is left unsuffixed. Persistent
 * descendants share one monotonically increasing suffix sequence.
 */
export function allocateForkSessionTitle(
  parentTitle: string | null | undefined,
  existingTitles: readonly (string | null | undefined)[],
  options: { parentIsFork?: boolean } = {},
): string {
  const normalizedParentTitle = normalizedTitle(parentTitle) ?? "Codex";
  const parent = options.parentIsFork
    ? splitNumberedForkTitle(normalizedParentTitle)
    : { base: normalizedParentTitle, index: 1 };
  let highestIndex = parent.index;

  for (const candidateValue of existingTitles) {
    const candidateTitle = normalizedTitle(candidateValue);
    if (!candidateTitle) {
      continue;
    }
    if (candidateTitle === parent.base) {
      highestIndex = Math.max(highestIndex, 1);
      continue;
    }
    const candidate = splitNumberedForkTitle(candidateTitle);
    if (candidate.base === parent.base) {
      highestIndex = Math.max(highestIndex, candidate.index);
    }
  }

  return `${parent.base} (${Math.max(2, highestIndex + 1)})`;
}
