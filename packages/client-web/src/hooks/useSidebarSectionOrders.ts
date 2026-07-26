import { useEffect, useMemo, useState } from "react";
import type { CouncilSnapshot } from "@rah/runtime-protocol";
import { councilActivityAt } from "../council/council-activity";
import type { SidebarPinnedItemRef } from "../sidebar-view-model";
import {
  moveSidebarSectionItem,
  readSidebarSectionOrder,
  reconcileSidebarSectionOrder,
  sidebarCouncilOrderKey,
  sidebarPinnedOrderKey,
  writeSidebarSectionOrder,
  type SidebarDropPosition,
} from "../sidebar-section-order";

const PINNED_SIDEBAR_ORDER_KEY = "rah.sidebar-section-order.pinned.v1";
const COUNCIL_SIDEBAR_ORDER_KEY = "rah.sidebar-section-order.councils.v1";

function usePersistentSidebarSectionOrder(
  storageKey: string,
  availableKeys: readonly string[],
) {
  const [preferredOrder, setPreferredOrder] = useState<string[]>(() =>
    readSidebarSectionOrder(storageKey)
  );
  const order = useMemo(
    () => reconcileSidebarSectionOrder(preferredOrder, availableKeys),
    [availableKeys, preferredOrder],
  );

  useEffect(() => {
    writeSidebarSectionOrder(storageKey, preferredOrder);
  }, [preferredOrder, storageKey]);

  const move = (
    sourceKey: string,
    targetKey: string,
    position: SidebarDropPosition,
  ) => {
    setPreferredOrder((current) =>
      moveSidebarSectionItem(
        reconcileSidebarSectionOrder(current, availableKeys),
        sourceKey,
        targetKey,
        position,
      )
    );
  };

  return { move, order };
}

export function useSidebarSectionOrders(
  pinnedItems: readonly SidebarPinnedItemRef[],
  councils: readonly CouncilSnapshot[],
) {
  const pinnedKeys = useMemo(
    () => pinnedItems.map((item) => sidebarPinnedOrderKey(item.workspaceDir, item.itemKey)),
    [pinnedItems],
  );
  const councilKeys = useMemo(
    () =>
      councils
        .filter((council) => council.status === "running")
        .sort((left, right) =>
          councilActivityAt(right).localeCompare(councilActivityAt(left))
        )
        .map((council) => sidebarCouncilOrderKey(council.id)),
    [councils],
  );
  const pinned = usePersistentSidebarSectionOrder(
    PINNED_SIDEBAR_ORDER_KEY,
    pinnedKeys,
  );
  const council = usePersistentSidebarSectionOrder(
    COUNCIL_SIDEBAR_ORDER_KEY,
    councilKeys,
  );

  return {
    councilOrderKeys: council.order,
    moveCouncil: council.move,
    movePinned: pinned.move,
    pinnedOrderKeys: pinned.order,
  };
}
