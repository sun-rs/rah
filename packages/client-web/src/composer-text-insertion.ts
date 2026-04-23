export function insertTextAtSelection(args: {
  current: string;
  selectionStart: number;
  selectionEnd: number;
  insertedText: string;
}): { nextValue: string; caret: number } {
  const insertedCore = args.insertedText;
  const prefixNeedsSpace =
    args.selectionStart > 0 &&
    !/\s/.test(args.current.slice(Math.max(0, args.selectionStart - 1), args.selectionStart));
  const suffixNeedsSpace =
    args.selectionEnd < args.current.length &&
    !/\s/.test(args.current.slice(args.selectionEnd, args.selectionEnd + 1)) &&
    !/\s$/.test(insertedCore);
  const inserted = `${prefixNeedsSpace ? " " : ""}${insertedCore}${suffixNeedsSpace ? " " : ""}`;
  const suffix = args.current.slice(args.selectionEnd);
  const normalizedSuffix =
    /\s$/.test(inserted) && /^\s/.test(suffix) ? suffix.replace(/^\s+/, "") : suffix;
  return {
    nextValue: `${args.current.slice(0, args.selectionStart)}${inserted}${normalizedSuffix}`,
    caret: args.selectionStart + inserted.length,
  };
}
