import { useEffect, useRef, useState } from "react";

export function useWorkbenchSelectionState(args: {
  selectedSessionId: string | null;
  workspaceDirs: string[];
}) {
  const [workspacePickerOpen, setWorkspacePickerOpen] = useState(false);
  const [selectedWorkspaceOnlyDir, setSelectedWorkspaceOnlyDir] = useState<string | null>(null);
  const workspacePickerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!workspacePickerOpen) {
      return;
    }
    const onPointerDown = (event: PointerEvent) => {
      if (!workspacePickerRef.current?.contains(event.target as Node)) {
        setWorkspacePickerOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [workspacePickerOpen]);

  useEffect(() => {
    if (args.selectedSessionId && selectedWorkspaceOnlyDir !== null) {
      setSelectedWorkspaceOnlyDir(null);
    }
  }, [args.selectedSessionId, selectedWorkspaceOnlyDir]);

  useEffect(() => {
    if (
      selectedWorkspaceOnlyDir &&
      !args.workspaceDirs.some((dir) => dir === selectedWorkspaceOnlyDir)
    ) {
      setSelectedWorkspaceOnlyDir(null);
    }
  }, [selectedWorkspaceOnlyDir, args.workspaceDirs]);

  return {
    selectedWorkspaceOnlyDir,
    setSelectedWorkspaceOnlyDir,
    workspacePickerOpen,
    setWorkspacePickerOpen,
    workspacePickerRef,
  };
}
