export function shouldRequestPtyReplay(args: {
  initialReplay: boolean;
  fromSeq?: number;
}): boolean {
  return args.fromSeq !== undefined || args.initialReplay;
}
