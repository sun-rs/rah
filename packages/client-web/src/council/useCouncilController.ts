import { useCallback, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { CouncilSnapshot } from "@rah/runtime-protocol";
import * as api from "../api";
import {
  mergeCouncilLists,
  mergeCouncilMessageEvent,
  mergeCouncilSnapshot,
} from "./council-message-window";
import { useCouncilTransport } from "./useCouncilTransport";

export type CouncilStateUpdater = (
  current: readonly CouncilSnapshot[],
) => CouncilSnapshot[];

export function useCouncilController() {
  const [councils, setCouncils] = useState<CouncilSnapshot[]>([]);
  const [councilsLoaded, setCouncilsLoaded] = useState(false);
  const councilsRef = useRef<CouncilSnapshot[]>([]);
  const refreshRef = useRef<Promise<void> | null>(null);
  const catalogActivatedRef = useRef(false);
  const [selectedCouncilId, setSelectedCouncilIdState] = useState<string | null>(null);
  const selectedCouncilIdRef = useRef<string | null>(null);
  const [unreadCouncilIds, setUnreadCouncilIds] = useState<Set<string>>(() => new Set());

  const setSelectedCouncilId = useCallback<Dispatch<SetStateAction<string | null>>>((next) => {
    const resolved = typeof next === "function"
      ? next(selectedCouncilIdRef.current)
      : next;
    selectedCouncilIdRef.current = resolved;
    setSelectedCouncilIdState(resolved);
    if (resolved) {
      setUnreadCouncilIds((current) => {
        if (!current.has(resolved)) {
          return current;
        }
        const updated = new Set(current);
        updated.delete(resolved);
        return updated;
      });
    }
  }, []);

  const updateCouncils = useCallback((update: CouncilStateUpdater): CouncilSnapshot[] => {
    const next = update(councilsRef.current);
    councilsRef.current = next;
    setCouncils(next);
    return next;
  }, []);

  const refreshCouncils = useCallback((): Promise<void> => {
    catalogActivatedRef.current = true;
    if (refreshRef.current) {
      return refreshRef.current;
    }
    const operation = api.listCouncils()
      .then((response) => {
        setCouncilsLoaded(true);
        const mergedCouncils = updateCouncils((current) =>
          mergeCouncilLists(current, response.councils),
        );
        setSelectedCouncilId((current) => {
          if (!current || mergedCouncils.some((council) => council.id === current)) {
            return current;
          }
          return null;
        });
      })
      .catch(() => {
        // The full Council page owns user-visible loading errors.
      })
      .finally(() => {
        if (refreshRef.current === operation) {
          refreshRef.current = null;
        }
      });
    refreshRef.current = operation;
    return operation;
  }, [setSelectedCouncilId, updateCouncils]);

  const upsertCouncil = useCallback((council: CouncilSnapshot) => {
    updateCouncils((current) => {
      const index = current.findIndex((candidate) => candidate.id === council.id);
      if (index < 0) {
        return [council, ...current];
      }
      return current.map((candidate, candidateIndex) =>
        candidateIndex === index ? mergeCouncilSnapshot(candidate, council) : candidate,
      );
    });
  }, [updateCouncils]);

  useCouncilTransport({
    onMessage: (council, message) => {
      if (message.role === "agent" && selectedCouncilIdRef.current !== council.id) {
        setUnreadCouncilIds((current) => {
          if (current.has(council.id)) {
            return current;
          }
          return new Set(current).add(council.id);
        });
      }
      updateCouncils((current) => {
        const index = current.findIndex((candidate) => candidate.id === council.id);
        const nextCouncil = mergeCouncilMessageEvent(
          index >= 0 ? current[index] : undefined,
          council,
          message,
        );
        return index >= 0
          ? current.map((candidate, candidateIndex) =>
              candidateIndex === index ? nextCouncil : candidate,
            )
          : [nextCouncil, ...current];
      });
    },
    onRefresh: refreshCouncils,
    shouldRefresh: () => catalogActivatedRef.current,
  });

  const removeCouncil = useCallback(async (councilId: string) => {
    await api.deleteCouncil(councilId);
    setUnreadCouncilIds((current) => {
      if (!current.has(councilId)) {
        return current;
      }
      const updated = new Set(current);
      updated.delete(councilId);
      return updated;
    });
    await refreshCouncils();
  }, [refreshCouncils]);

  const renameCouncil = useCallback(async (councilId: string, title: string) => {
    const response = await api.renameCouncil(councilId, { title });
    upsertCouncil(response.council);
  }, [upsertCouncil]);

  return {
    councils,
    councilsLoaded,
    selectedCouncilId,
    setSelectedCouncilId,
    unreadCouncilIds,
    updateCouncils,
    refreshCouncils,
    upsertCouncil,
    removeCouncil,
    renameCouncil,
  };
}
