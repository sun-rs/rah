import { useEffect, useMemo, useState, type ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { ChevronUp, Folder, FolderOpen, HardDrive, Search, X } from "lucide-react";
import { listDirectory, type DirectoryListingResponse } from "../api";

function getParentPath(path: string): string {
  if (!path) return "/";
  const normalized = path.replace(/[\\/]+$/, "");
  const lastSep = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
  if (lastSep <= 0) return "/";
  return normalized.slice(0, lastSep) || "/";
}

export function WorkspacePicker(props: {
  currentDir: string;
  triggerLabel?: string;
  triggerIcon?: ReactNode;
  triggerClassName?: string;
  onSelect: (dir: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [currentPath, setCurrentPath] = useState(props.currentDir || "/");
  const [listing, setListing] = useState<DirectoryListingResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setCurrentPath(props.currentDir || "/");
      setQuery("");
    }
  }, [open, props.currentDir]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    listDirectory(currentPath)
      .then((res) => {
        if (!cancelled) {
          setListing(res);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open, currentPath]);

  const filteredEntries = useMemo(() => {
    if (!listing) return [];
    const q = query.trim().toLowerCase();
    if (!q) return listing.entries.filter((e) => e.type === "directory");
    return listing.entries.filter(
      (e) => e.type === "directory" && e.name.toLowerCase().includes(q),
    );
  }, [listing, query]);

  const handleSelect = () => {
    props.onSelect(listing?.path || currentPath);
    setOpen(false);
  };

  const displayCurrent = props.currentDir.trim() || "Choose workspace…";
  const labelText = props.triggerLabel !== undefined ? props.triggerLabel : displayCurrent;

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <button
          type="button"
          className={props.triggerClassName ?? "w-full text-left rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2 text-sm text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)] transition-colors"}
        >
          <div className="flex items-center gap-2">
            {props.triggerIcon ?? (
              <Folder size={16} className="text-[var(--app-hint)] shrink-0" />
            )}
            {labelText ? <span className="truncate">{labelText}</span> : null}
          </div>
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40 z-40" />
        <Dialog.Content className="fixed left-1/2 top-1/2 max-h-[85vh] w-[90vw] max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] p-0 shadow-xl focus:outline-none z-50 flex flex-col">
          <div className="flex items-center justify-between border-b border-[var(--app-border)] px-4 py-3 shrink-0">
            <Dialog.Title className="text-sm font-semibold text-[var(--app-fg)]">
              Select workspace
            </Dialog.Title>
            <Dialog.Close asChild>
              <button
                type="button"
                className="inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] transition-colors"
                aria-label="Close"
              >
                <X size={16} />
              </button>
            </Dialog.Close>
          </div>

          {/* Breadcrumb / path bar */}
          <div className="flex items-center gap-2 border-b border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-3 py-2 shrink-0">
            <button
              type="button"
              onClick={() => setCurrentPath(getParentPath(currentPath))}
              disabled={currentPath === "/"}
              className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--app-hint)] hover:bg-[var(--app-bg)] hover:text-[var(--app-fg)] disabled:opacity-30 transition-colors"
              aria-label="Go up"
              title="Go up"
            >
              <ChevronUp size={16} />
            </button>
            <div className="flex min-w-0 items-center gap-1.5 text-sm text-[var(--app-fg)]">
              <HardDrive size={14} className="text-[var(--app-hint)] shrink-0" />
              <span className="truncate font-medium" title={listing?.path || currentPath}>
                {listing?.path || currentPath}
              </span>
            </div>
          </div>

          {/* Search */}
          <div className="px-4 pt-3 pb-2 shrink-0">
            <div className="flex items-center gap-2 rounded-lg border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-3 py-2">
              <Search size={14} className="text-[var(--app-hint)] shrink-0" />
              <input
                className="flex-1 bg-transparent text-sm text-[var(--app-fg)] placeholder-[var(--app-hint)] focus:outline-none"
                placeholder="Search folders…"
                value={query}
                onChange={(e) => setQuery(e.currentTarget.value)}
              />
            </div>
          </div>

          {/* Directory listing */}
          <div className="flex-1 overflow-y-auto custom-scrollbar px-4 pb-2">
            {error ? (
              <div className="py-6 text-center text-sm text-[var(--app-danger)]">
                {error}
              </div>
            ) : loading ? (
              <div className="py-6 text-center text-sm text-[var(--app-hint)]">Loading…</div>
            ) : filteredEntries.length > 0 ? (
              <div className="space-y-1 py-1">
                {filteredEntries.map((entry) => (
                  <button
                    key={entry.name}
                    type="button"
                    onClick={() =>
                      setCurrentPath(`${listing?.path || currentPath}/${entry.name}`.replace(/\/+/g, "/"))
                    }
                    className="w-full text-left rounded-lg border border-transparent px-3 py-2 transition-colors hover:bg-[var(--app-subtle-bg)] hover:border-[var(--app-border)] flex items-center gap-2"
                  >
                    <FolderOpen size={16} className="text-[var(--app-hint)] shrink-0" />
                    <span className="text-sm text-[var(--app-fg)] truncate">{entry.name}</span>
                  </button>
                ))}
              </div>
            ) : (
              <div className="py-6 text-center text-sm text-[var(--app-hint)]">
                {query.trim() ? "No matching folders." : "No folders in this directory."}
              </div>
            )}
          </div>

          {/* Footer actions */}
          <div className="border-t border-[var(--app-border)] px-4 py-3 shrink-0 flex items-center justify-between gap-3">
            <div className="min-w-0 text-xs text-[var(--app-hint)] truncate">
              Selected: <span className="text-[var(--app-fg)]">{listing?.path || currentPath}</span>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <Dialog.Close asChild>
                <button
                  type="button"
                  className="rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2 text-xs font-medium text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)] transition-colors"
                >
                  Cancel
                </button>
              </Dialog.Close>
              <button
                type="button"
                onClick={handleSelect}
                className="rounded-lg bg-primary px-3 py-2 text-xs font-medium text-primary-foreground hover:opacity-90 transition-colors"
              >
                Select
              </button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
