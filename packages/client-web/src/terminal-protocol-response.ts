export function isTerminalProtocolResponse(data: string): boolean {
  if (!data) {
    return false;
  }
  let remaining = data;
  const consume = (pattern: RegExp) => {
    const match = pattern.exec(remaining);
    if (!match || match.index !== 0) {
      return false;
    }
    remaining = remaining.slice(match[0].length);
    return true;
  };

  while (remaining) {
    if (consume(/^\x1b\[\d+;\d+R/)) {
      continue;
    }
    if (consume(/^\x1b\[\?(?:\d+;)*\d+c/)) {
      continue;
    }
    if (consume(/^\x1b\[>(?:\d+;)*\d+c/)) {
      continue;
    }
    if (consume(/^\x1b\[\?\d+u/)) {
      continue;
    }
    if (consume(/^\x1b\](?:10|11);(?:[^\x1b\x07]|\x1b(?!\\))*(?:\x07|\x1b\\)/)) {
      continue;
    }
    return false;
  }
  return true;
}
