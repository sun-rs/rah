import { useEffect, useMemo, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  ChevronUp,
  FileText,
  FolderOpen,
  Plus,
  Search,
  X,
} from "lucide-react";
import { listDirectory, type DirectoryListingResponse } from "../api";

function normalizePath(value: string): string {
  const trimmed = value.trim().replace(/[\\/]+$/, "");
  if (!trimmed) {
    return "/";
  }
  return trimmed.startsWith("/private/var/") ? trimmed.slice("/private".length) : trimmed;
}

function getParentPath(path: string): string {
  const normalized = normalizePath(path);
  const lastSep = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
  if (lastSep <= 0) {
    return "/";
  }
  return normalized.slice(0, lastSep) || "/";
}

function joinPath(base: string, name: string): string {
  return `${normalizePath(base)}/${name}`.replace(/\/+/g, "/");
}

function relativePath(root: string, target: string): string {
  const normalizedRoot = normalizePath(root);
  const normalizedTarget = normalizePath(target);
  if (normalizedTarget === normalizedRoot) {
    return ".";
  }
  if (normalizedTarget.startsWith(`${normalizedRoot}/`)) {
    return normalizedTarget.slice(normalizedRoot.length + 1);
  }
  return normalizedTarget;
}

function preferredReferencePath(root: string, target: string): string {
  const normalizedRoot = normalizePath(root);
  const normalizedTarget = normalizePath(target);
  if (
    normalizedTarget === normalizedRoot ||
    normalizedTarget.startsWith(`${normalizedRoot}/`)
  ) {
    return relativePath(normalizedRoot, normalizedTarget);
  }
  return normalizedTarget;
}

function formatReference(path: string): string {
  return path.includes(" ") ? `@"${path}"` : `@${path}`;
}

export function FileReferencePicker(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  rootPath: string;
  onPick: (reference: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [currentPath, setCurrentPath] = useState(normalizePath(props.rootPath));
  const [listing, setListing] = useState<DirectoryListingResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!props.open) {
      return;
    }
    setCurrentPath(normalizePath(props.rootPath));
    setQuery("");
  }, [props.open, props.rootPath]);

  useEffect(() => {
    if (!props.open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    void listDirectory(currentPath)
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
  }, [currentPath, props.open]);

  const filteredEntries = useMemo(() => {
    if (!listing) return [];
    const q = query.trim().toLowerCase();
    if (!q) {
      return listing.entries;
    }
    return listing.entries.filter((entry) => entry.name.toLowerCase().includes(q));
  }, [listing, query]);

  const insertReference = (path: string) => {
    props.onPick(formatReference(preferredReferencePath(props.rootPath, path)));
    props.onOpenChange(false);
  };

  return (
    <Dialog.Root open={props.open} onOpenChange={props.onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40 z-40" />
        <Dialog.Content className="fixed left-1/2 top-1/2 max-h-[85vh] w-[90vw] max-w-xl -translate-x-1/2 -translate-y-1/2 rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] p-0 shadow-xl focus:outline-none z-50 flex flex-col">
          <div className="flex items-center justify-between border-b border-[var(--app-border)] px-4 py-3 shrink-0">
            <Dialog.Title className="flex items-center gap-2 text-sm font-semibold text-[var(--app-fg)]">
              <Plus size={16} className="text-[var(--app-hint)]" />
              <span>Insert file or folder</span>
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

          <div className="flex items-center gap-2 border-b border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-3 py-2 shrink-0">
            <button
              type="button"
              onClick={() => setCurrentPath(getParentPath(listing?.path || currentPath))}
              disabled={normalizePath(currentPath) === "/"}
              className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--app-hint)] hover:bg-[var(--app-bg)] hover:text-[var(--app-fg)] disabled:opacity-30 transition-colors"
              aria-label="Go up"
              title="Go up"
            >
              <ChevronUp size={16} />
            </button>
            <div className="min-w-0 truncate text-sm text-[var(--app-fg)]" title={listing?.path || currentPath}>
              {listing?.path || currentPath}
            </div>
          </div>

          <div className="px-4 pt-3 pb-2 shrink-0">
            <div className="flex items-center gap-2 rounded-lg border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-3 py-2">
              <Search size={14} className="text-[var(--app-hint)] shrink-0" />
              <input
                className="flex-1 bg-transparent text-sm text-[var(--app-fg)] placeholder-[var(--app-hint)] focus:outline-none"
                placeholder="Search files and folders…"
                value={query}
                onChange={(e) => setQuery(e.currentTarget.value)}
              />
            </div>
          </div>

          <div className="flex-1 overflow-y-auto custom-scrollbar px-4 pb-2">
            {error ? (
              <div className="py-6 text-center text-sm text-[var(--app-danger)]">{error}</div>
            ) : loading ? (
              <div className="py-6 text-center text-sm text-[var(--app-hint)]">Loading…</div>
            ) : filteredEntries.length > 0 ? (
              <div className="space-y-1 py-1">
                {filteredEntries.map((entry) => {
                  const nextPath = joinPath(listing?.path || currentPath, entry.name);
                  if (entry.type === "directory") {
                    return (
                      <div
                        key={`${entry.type}:${entry.name}`}
                        className="flex items-center gap-2 rounded-lg border border-transparent px-2 py-1.5 transition-colors hover:bg-[var(--app-subtle-bg)] hover:border-[var(--app-border)]"
                      >
                        <button
                          type="button"
                          onClick={() => setCurrentPath(nextPath)}
                          className="flex min-w-0 flex-1 items-center gap-2 text-left"
                        >
                          <FolderOpen size={16} className="shrink-0 text-[var(--app-hint)]" />
                          <span className="truncate text-sm text-[var(--app-fg)]">{entry.name}</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => insertReference(nextPath)}
                          className="inline-flex h-7 items-center justify-center rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-2 text-[11px] font-medium text-[var(--app-hint)] hover:text-[var(--app-fg)] transition-colors"
                        >
                          Insert
                        </button>
                      </div>
                    );
                  }
                  return (
                    <button
                      key={`${entry.type}:${entry.name}`}
                      type="button"
                      onClick={() => insertReference(nextPath)}
                      className="w-full text-left rounded-lg border border-transparent px-3 py-2 transition-colors hover:bg-[var(--app-subtle-bg)] hover:border-[var(--app-border)] flex items-center gap-2"
                    >
                      <FileText size={15} className="shrink-0 text-[var(--app-hint)]" />
                      <span className="truncate text-sm text-[var(--app-fg)]">{entry.name}</span>
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="py-6 text-center text-sm text-[var(--app-hint)]">
                {query.trim() ? "No matching files or folders." : "No files or folders in this directory."}
              </div>
            )}
          </div>

          <div className="flex items-center justify-between gap-3 border-t border-[var(--app-border)] px-4 py-3 shrink-0">
            <div className="min-w-0 truncate text-xs text-[var(--app-hint)]">
              Current folder:{" "}
              <span className="text-[var(--app-fg)]">
                {formatReference(preferredReferencePath(props.rootPath, listing?.path || currentPath))}
              </span>
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
                onClick={() => insertReference(listing?.path || currentPath)}
                className="rounded-lg bg-primary px-3 py-2 text-xs font-medium text-primary-foreground hover:opacity-90 transition-colors"
              >
                Insert folder
              </button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
