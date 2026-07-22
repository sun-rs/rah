export type CanvasPaneId =
  | "canvas-1"
  | "canvas-2"
  | "canvas-3"
  | "canvas-4"
  | "canvas-5"
  | "canvas-6"
  | "canvas-7"
  | "canvas-8";

export type CanvasSplitAxis = "horizontal" | "vertical";

export type CanvasLayoutNode =
  | { kind: "pane"; paneId: CanvasPaneId }
  | {
      kind: "split";
      id: string;
      axis: CanvasSplitAxis;
      ratio: number;
      first: CanvasLayoutNode;
      second: CanvasLayoutNode;
    };

export type CanvasLayoutPresetId =
  | "two-horizontal"
  | "two-vertical"
  | "three-horizontal"
  | "four-grid";

export type CanvasGridDimensions = {
  columns: number;
  rows: number;
};

export type CanvasSplitJunctionDirections = {
  left: boolean;
  right: boolean;
  up: boolean;
  down: boolean;
};

export type CanvasSplitJunction = {
  position: number;
  directions: CanvasSplitJunctionDirections;
};

export const MAX_CANVAS_PANES = 8;

export const CANVAS_PANE_IDS: readonly CanvasPaneId[] = [
  "canvas-1",
  "canvas-2",
  "canvas-3",
  "canvas-4",
  "canvas-5",
  "canvas-6",
  "canvas-7",
  "canvas-8",
];

export const CANVAS_GRID_OPTIONS: readonly CanvasGridDimensions[] = [
  { columns: 2, rows: 1 },
  { columns: 3, rows: 1 },
  { columns: 4, rows: 1 },
  { columns: 1, rows: 2 },
  { columns: 1, rows: 3 },
  { columns: 2, rows: 2 },
  { columns: 3, rows: 2 },
  { columns: 4, rows: 2 },
  { columns: 2, rows: 3 },
] as const;

function splitId(path: string, axis: CanvasSplitAxis): string {
  return `canvas-split:${path}:${axis}`;
}

function buildLinearLayout(
  panes: readonly CanvasLayoutNode[],
  axis: CanvasSplitAxis,
  path: string,
): CanvasLayoutNode {
  if (panes.length === 1) {
    return panes[0]!;
  }
  const splitIndex = Math.floor(panes.length / 2);
  return {
    kind: "split",
    id: splitId(path, axis),
    axis,
    ratio: splitIndex / panes.length,
    first: buildLinearLayout(panes.slice(0, splitIndex), axis, `${path}.0`),
    second: buildLinearLayout(panes.slice(splitIndex), axis, `${path}.1`),
  };
}

function assertGridDimensions(columns: number, rows: number): void {
  const paneCount = columns * rows;
  if (
    !Number.isInteger(columns) ||
    !Number.isInteger(rows) ||
    columns < 1 ||
    rows < 1 ||
    paneCount < 2 ||
    paneCount > MAX_CANVAS_PANES
  ) {
    throw new Error(`Unsupported Canvas grid: ${columns} x ${rows}`);
  }
}

export function createCanvasGridLayout(columns: number, rows: number): CanvasLayoutNode {
  assertGridDimensions(columns, rows);
  const paneIds = CANVAS_PANE_IDS.slice(0, columns * rows);
  const rowNodes = Array.from({ length: rows }, (_, rowIndex) => {
    const rowPaneIds = paneIds.slice(rowIndex * columns, (rowIndex + 1) * columns);
    const panes = rowPaneIds.map<CanvasLayoutNode>((paneId) => ({ kind: "pane", paneId }));
    return buildLinearLayout(panes, "horizontal", `grid-r${rowIndex}`);
  });
  return buildLinearLayout(rowNodes, "vertical", "grid-root");
}

export function createCanvasPresetLayout(preset: CanvasLayoutPresetId): CanvasLayoutNode {
  switch (preset) {
    case "two-horizontal":
      return createCanvasGridLayout(2, 1);
    case "two-vertical":
      return createCanvasGridLayout(1, 2);
    case "three-horizontal":
      return createCanvasGridLayout(3, 1);
    case "four-grid":
      return createCanvasGridLayout(2, 2);
  }
}

export function canvasLayoutPaneIds(layout: CanvasLayoutNode): CanvasPaneId[] {
  if (layout.kind === "pane") {
    return [layout.paneId];
  }
  return [
    ...canvasLayoutPaneIds(layout.first),
    ...canvasLayoutPaneIds(layout.second),
  ];
}

export function canvasLayoutPaneCount(layout: CanvasLayoutNode): number {
  return canvasLayoutPaneIds(layout).length;
}

type CanvasLayoutRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type CanvasDividerSegment = {
  splitId: string;
  depth: number;
  orientation: "horizontal" | "vertical";
  x1: number;
  y1: number;
  x2: number;
  y2: number;
};

function collectCanvasDividerSegments(
  layout: CanvasLayoutNode,
  rect: CanvasLayoutRect,
  depth: number,
  segments: CanvasDividerSegment[],
): void {
  if (layout.kind === "pane") {
    return;
  }
  if (layout.axis === "horizontal") {
    const dividerX = rect.x + rect.width * layout.ratio;
    segments.push({
      splitId: layout.id,
      depth,
      orientation: "vertical",
      x1: dividerX,
      y1: rect.y,
      x2: dividerX,
      y2: rect.y + rect.height,
    });
    collectCanvasDividerSegments(
      layout.first,
      { ...rect, width: rect.width * layout.ratio },
      depth + 1,
      segments,
    );
    collectCanvasDividerSegments(
      layout.second,
      {
        x: dividerX,
        y: rect.y,
        width: rect.width * (1 - layout.ratio),
        height: rect.height,
      },
      depth + 1,
      segments,
    );
    return;
  }

  const dividerY = rect.y + rect.height * layout.ratio;
  segments.push({
    splitId: layout.id,
    depth,
    orientation: "horizontal",
    x1: rect.x,
    y1: dividerY,
    x2: rect.x + rect.width,
    y2: dividerY,
  });
  collectCanvasDividerSegments(
    layout.first,
    { ...rect, height: rect.height * layout.ratio },
    depth + 1,
    segments,
  );
  collectCanvasDividerSegments(
    layout.second,
    {
      x: rect.x,
      y: dividerY,
      width: rect.width,
      height: rect.height * (1 - layout.ratio),
    },
    depth + 1,
    segments,
  );
}

function canvasSegmentContains(value: number, start: number, end: number): boolean {
  const epsilon = 1e-6;
  return value >= Math.min(start, end) - epsilon && value <= Math.max(start, end) + epsilon;
}

/**
 * Derives the visible T/cross markers at real divider junctions. Resize hit
 * targets still belong to their original split nodes; this is only the shared
 * visual projection of the layout tree.
 */
export function deriveCanvasSplitJunctions(
  layout: CanvasLayoutNode,
): ReadonlyMap<string, readonly CanvasSplitJunction[]> {
  const segments: CanvasDividerSegment[] = [];
  collectCanvasDividerSegments(
    layout,
    { x: 0, y: 0, width: 1, height: 1 },
    0,
    segments,
  );
  const junctions = new Map<string, {
    x: number;
    y: number;
    segments: Set<CanvasDividerSegment>;
  }>();

  for (let firstIndex = 0; firstIndex < segments.length; firstIndex += 1) {
    for (let secondIndex = firstIndex + 1; secondIndex < segments.length; secondIndex += 1) {
      const first = segments[firstIndex]!;
      const second = segments[secondIndex]!;
      if (first.orientation === second.orientation) {
        continue;
      }
      const vertical = first.orientation === "vertical" ? first : second;
      const horizontal = first.orientation === "horizontal" ? first : second;
      const x = vertical.x1;
      const y = horizontal.y1;
      if (
        !canvasSegmentContains(x, horizontal.x1, horizontal.x2) ||
        !canvasSegmentContains(y, vertical.y1, vertical.y2)
      ) {
        continue;
      }
      const key = `${x.toFixed(6)}:${y.toFixed(6)}`;
      const junction = junctions.get(key) ?? { x, y, segments: new Set<CanvasDividerSegment>() };
      junction.segments.add(first);
      junction.segments.add(second);
      junctions.set(key, junction);
    }
  }

  const result = new Map<string, CanvasSplitJunction[]>();
  for (const junction of junctions.values()) {
    const touchingSegments = [...junction.segments];
    const owner = touchingSegments.reduce((current, candidate) =>
      candidate.depth < current.depth ? candidate : current,
    );
    const directions: CanvasSplitJunctionDirections = {
      left: false,
      right: false,
      up: false,
      down: false,
    };
    const epsilon = 1e-6;
    for (const segment of touchingSegments) {
      if (segment.orientation === "horizontal") {
        directions.left ||= junction.x > segment.x1 + epsilon;
        directions.right ||= junction.x < segment.x2 - epsilon;
      } else {
        directions.up ||= junction.y > segment.y1 + epsilon;
        directions.down ||= junction.y < segment.y2 - epsilon;
      }
    }
    const span = owner.orientation === "horizontal"
      ? owner.x2 - owner.x1
      : owner.y2 - owner.y1;
    const offset = owner.orientation === "horizontal"
      ? junction.x - owner.x1
      : junction.y - owner.y1;
    const entry = {
      position: span > 0 ? Math.max(0, Math.min(1, offset / span)) : 0.5,
      directions,
    };
    const owned = result.get(owner.splitId) ?? [];
    owned.push(entry);
    result.set(owner.splitId, owned);
  }
  for (const owned of result.values()) {
    owned.sort((left, right) => left.position - right.position);
  }
  return result;
}

function sameLayoutTopology(first: CanvasLayoutNode, second: CanvasLayoutNode): boolean {
  if (first.kind !== second.kind) {
    return false;
  }
  if (first.kind === "pane" && second.kind === "pane") {
    return first.paneId === second.paneId;
  }
  if (first.kind === "split" && second.kind === "split") {
    return (
      first.axis === second.axis &&
      sameLayoutTopology(first.first, second.first) &&
      sameLayoutTopology(first.second, second.second)
    );
  }
  return false;
}

export function getCanvasGridDimensions(
  layout: CanvasLayoutNode,
): CanvasGridDimensions | null {
  return (
    CANVAS_GRID_OPTIONS.find((dimensions) =>
      sameLayoutTopology(
        layout,
        createCanvasGridLayout(dimensions.columns, dimensions.rows),
      ),
    ) ?? null
  );
}

export function getCanvasLayoutPresetId(
  layout: CanvasLayoutNode,
): CanvasLayoutPresetId | null {
  const presets: readonly CanvasLayoutPresetId[] = [
    "two-horizontal",
    "two-vertical",
    "three-horizontal",
    "four-grid",
  ];
  return (
    presets.find((preset) => sameLayoutTopology(layout, createCanvasPresetLayout(preset))) ??
    null
  );
}

function replaceCanvasPane(
  layout: CanvasLayoutNode,
  paneId: CanvasPaneId,
  replacement: CanvasLayoutNode,
): CanvasLayoutNode {
  if (layout.kind === "pane") {
    return layout.paneId === paneId ? replacement : layout;
  }
  return {
    ...layout,
    first: replaceCanvasPane(layout.first, paneId, replacement),
    second: replaceCanvasPane(layout.second, paneId, replacement),
  };
}

export function splitCanvasLayoutPane(
  layout: CanvasLayoutNode,
  paneId: CanvasPaneId,
  axis: CanvasSplitAxis,
): { layout: CanvasLayoutNode; newPaneId: CanvasPaneId } | null {
  const visiblePaneIds = canvasLayoutPaneIds(layout);
  if (!visiblePaneIds.includes(paneId) || visiblePaneIds.length >= MAX_CANVAS_PANES) {
    return null;
  }

  const grid = getCanvasGridDimensions(layout);
  if (axis === "horizontal" && grid?.rows === 1 && grid.columns < MAX_CANVAS_PANES) {
    const nextLayout = createCanvasGridLayout(grid.columns + 1, 1);
    return {
      layout: nextLayout,
      newPaneId: CANVAS_PANE_IDS[grid.columns]!,
    };
  }
  if (axis === "vertical" && grid?.columns === 1 && grid.rows < MAX_CANVAS_PANES) {
    const nextLayout = createCanvasGridLayout(1, grid.rows + 1);
    return {
      layout: nextLayout,
      newPaneId: CANVAS_PANE_IDS[grid.rows]!,
    };
  }

  const newPaneId = CANVAS_PANE_IDS.find((candidate) => !visiblePaneIds.includes(candidate));
  if (!newPaneId) {
    return null;
  }
  return {
    layout: replaceCanvasPane(layout, paneId, {
      kind: "split",
      id: `canvas-split:${paneId}:${newPaneId}:${axis}`,
      axis,
      ratio: 0.5,
      first: { kind: "pane", paneId },
      second: { kind: "pane", paneId: newPaneId },
    }),
    newPaneId,
  };
}

function removeCanvasPaneNode(
  layout: CanvasLayoutNode,
  paneId: CanvasPaneId,
): { layout: CanvasLayoutNode | null; removed: boolean } {
  if (layout.kind === "pane") {
    return layout.paneId === paneId
      ? { layout: null, removed: true }
      : { layout, removed: false };
  }

  const first = removeCanvasPaneNode(layout.first, paneId);
  if (first.removed) {
    return first.layout
      ? { layout: { ...layout, first: first.layout }, removed: true }
      : { layout: layout.second, removed: true };
  }

  const second = removeCanvasPaneNode(layout.second, paneId);
  if (second.removed) {
    return second.layout
      ? { layout: { ...layout, second: second.layout }, removed: true }
      : { layout: layout.first, removed: true };
  }

  return { layout, removed: false };
}

export function removeCanvasLayoutPane(
  layout: CanvasLayoutNode,
  paneId: CanvasPaneId,
): CanvasLayoutNode | null {
  const visiblePaneIds = canvasLayoutPaneIds(layout);
  if (visiblePaneIds.length <= 1 || !visiblePaneIds.includes(paneId)) {
    return null;
  }
  return removeCanvasPaneNode(layout, paneId).layout;
}

export function updateCanvasSplitRatio(
  layout: CanvasLayoutNode,
  splitNodeId: string,
  ratio: number,
): CanvasLayoutNode {
  if (layout.kind === "pane") {
    return layout;
  }
  const normalizedRatio = Math.max(0.15, Math.min(0.85, ratio));
  if (layout.id === splitNodeId) {
    return { ...layout, ratio: normalizedRatio };
  }
  return {
    ...layout,
    first: updateCanvasSplitRatio(layout.first, splitNodeId, normalizedRatio),
    second: updateCanvasSplitRatio(layout.second, splitNodeId, normalizedRatio),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCanvasPaneId(value: unknown): value is CanvasPaneId {
  return typeof value === "string" && CANVAS_PANE_IDS.includes(value as CanvasPaneId);
}

function normalizeLayoutNode(
  value: unknown,
  path: string,
  seenPaneIds: Set<CanvasPaneId>,
  seenSplitIds: Set<string>,
  depth: number,
): CanvasLayoutNode | null {
  if (!isRecord(value) || depth > MAX_CANVAS_PANES * 2) {
    return null;
  }
  if (value.kind === "pane") {
    if (!isCanvasPaneId(value.paneId) || seenPaneIds.has(value.paneId)) {
      return null;
    }
    seenPaneIds.add(value.paneId);
    return { kind: "pane", paneId: value.paneId };
  }
  if (value.kind !== "split" || (value.axis !== "horizontal" && value.axis !== "vertical")) {
    return null;
  }
  const first = normalizeLayoutNode(
    value.first,
    `${path}.0`,
    seenPaneIds,
    seenSplitIds,
    depth + 1,
  );
  const second = normalizeLayoutNode(
    value.second,
    `${path}.1`,
    seenPaneIds,
    seenSplitIds,
    depth + 1,
  );
  if (!first || !second) {
    return null;
  }
  const persistedId = typeof value.id === "string" && value.id.length > 0 ? value.id : null;
  const id = persistedId && !seenSplitIds.has(persistedId)
    ? persistedId
    : splitId(path, value.axis);
  seenSplitIds.add(id);
  const rawRatio = typeof value.ratio === "number" && Number.isFinite(value.ratio)
    ? value.ratio
    : 0.5;
  return {
    kind: "split",
    id,
    axis: value.axis,
    ratio: Math.max(0.15, Math.min(0.85, rawRatio)),
    first,
    second,
  };
}

export function normalizeCanvasLayout(value: unknown): CanvasLayoutNode | null {
  const seenPaneIds = new Set<CanvasPaneId>();
  const layout = normalizeLayoutNode(value, "root", seenPaneIds, new Set(), 0);
  return layout && seenPaneIds.size >= 1 ? layout : null;
}

function normalizedWeights(value: unknown, count: number): number[] {
  if (!Array.isArray(value) || value.length !== count) {
    return Array.from({ length: count }, () => 1);
  }
  const weights = value.map((item) =>
    typeof item === "number" && Number.isFinite(item) && item > 0 ? item : 1,
  );
  return weights.some((weight) => weight > 0)
    ? weights
    : Array.from({ length: count }, () => 1);
}

function buildWeightedLinearLayout(
  paneIds: readonly CanvasPaneId[],
  weights: readonly number[],
  axis: CanvasSplitAxis,
  path: string,
): CanvasLayoutNode {
  if (paneIds.length === 1) {
    return { kind: "pane", paneId: paneIds[0]! };
  }
  const splitIndex = Math.floor(paneIds.length / 2);
  const firstWeights = weights.slice(0, splitIndex);
  const secondWeights = weights.slice(splitIndex);
  const firstTotal = firstWeights.reduce((sum, weight) => sum + weight, 0);
  const secondTotal = secondWeights.reduce((sum, weight) => sum + weight, 0);
  return {
    kind: "split",
    id: splitId(path, axis),
    axis,
    ratio: firstTotal / (firstTotal + secondTotal),
    first: buildWeightedLinearLayout(
      paneIds.slice(0, splitIndex),
      firstWeights,
      axis,
      `${path}.0`,
    ),
    second: buildWeightedLinearLayout(
      paneIds.slice(splitIndex),
      secondWeights,
      axis,
      `${path}.1`,
    ),
  };
}

export function migrateLegacyCanvasLayout(value: unknown, ratios: unknown): CanvasLayoutNode | null {
  if (
    value !== "two-horizontal" &&
    value !== "two-vertical" &&
    value !== "three-horizontal" &&
    value !== "four-grid"
  ) {
    return null;
  }
  if (value === "two-horizontal" || value === "two-vertical") {
    return buildWeightedLinearLayout(
      CANVAS_PANE_IDS.slice(0, 2),
      normalizedWeights(ratios, 2),
      value === "two-horizontal" ? "horizontal" : "vertical",
      "legacy-root",
    );
  }
  if (value === "three-horizontal") {
    return buildWeightedLinearLayout(
      CANVAS_PANE_IDS.slice(0, 3),
      normalizedWeights(ratios, 3),
      "horizontal",
      "legacy-root",
    );
  }

  const weights = normalizedWeights(ratios, 4);
  const firstRow = buildWeightedLinearLayout(
    CANVAS_PANE_IDS.slice(0, 2),
    weights.slice(0, 2),
    "horizontal",
    "legacy-row-0",
  );
  const secondRow = buildWeightedLinearLayout(
    CANVAS_PANE_IDS.slice(2, 4),
    weights.slice(0, 2),
    "horizontal",
    "legacy-row-1",
  );
  return {
    kind: "split",
    id: "canvas-split:legacy-root:vertical",
    axis: "vertical",
    ratio: weights[2]! / (weights[2]! + weights[3]!),
    first: firstRow,
    second: secondRow,
  };
}
