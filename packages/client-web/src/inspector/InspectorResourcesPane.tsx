import type {
  ConversationOutputProjection,
  ConversationSourceProjection,
} from "@rah/runtime-protocol";
import { Globe2, Image as ImageIcon } from "lucide-react";
import { FileResourceIcon } from "../components/chat/FileResourceIcon";
import { getDisplayPath } from "./shared";

type InspectorResource = ConversationOutputProjection | ConversationSourceProjection;

function detail(resource: InspectorResource, workspaceRoot: string): string {
  if (resource.path) return getDisplayPath(resource.path, workspaceRoot);
  if (resource.url) return resource.url;
  return "activity" in resource ? resource.activity : resource.activities.join(" · ");
}

function ResourceIcon(props: { resource: InspectorResource }) {
  if (props.resource.path) {
    return (
      <FileResourceIcon
        path={props.resource.path}
        size={15}
        className="shrink-0 text-[var(--app-hint)]"
      />
    );
  }
  return props.resource.kind === "image" ? (
    <ImageIcon size={15} className="shrink-0 text-[var(--app-hint)]" />
  ) : (
    <Globe2 size={15} className="shrink-0 text-[var(--app-hint)]" />
  );
}

export function InspectorResourcesPane(props: {
  workspaceRoot: string;
  resources: readonly InspectorResource[];
  emptyLabel: string;
  testId: string;
  onOpenFile: (path: string) => void;
  onOpenUrl: (url: string) => void;
}) {
  if (props.resources.length === 0) {
    return <div className="text-sm text-[var(--app-hint)]">{props.emptyLabel}</div>;
  }

  return (
    <div className="space-y-0.5" data-testid={props.testId}>
      {props.resources.map((resource) => {
        const content = (
          <>
            <ResourceIcon resource={resource} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium text-[var(--app-fg)]">
                {resource.label}
              </div>
              <div className="truncate text-[11px] text-[var(--app-hint)]">
                {detail(resource, props.workspaceRoot)}
              </div>
            </div>
          </>
        );
        if (!resource.path && !resource.url) {
          return (
            <div key={resource.id} className="flex w-full items-center gap-2 px-1.5 py-2">
              {content}
            </div>
          );
        }
        return (
          <button
            key={resource.id}
            type="button"
            className="flex w-full items-center gap-2 rounded-md px-1.5 py-2 text-left transition-colors hover:bg-[var(--app-bg)]"
            title={resource.path ?? resource.url ?? resource.label}
            onClick={() => {
              if (resource.path) props.onOpenFile(resource.path);
              else if (resource.url) props.onOpenUrl(resource.url);
            }}
          >
            {content}
          </button>
        );
      })}
    </div>
  );
}
