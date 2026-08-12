import type {
  FocusEventHandler,
  PointerEventHandler,
  ReactNode,
} from "react";

export function UnifiedComposerSurface(props: {
  children: ReactNode;
  surface: "chat" | "new-task";
  isPwa?: boolean | undefined;
  expanded?: boolean | undefined;
  className?: string | undefined;
  onFocusCapture?: FocusEventHandler<HTMLDivElement> | undefined;
  onPointerDownCapture?: PointerEventHandler<HTMLDivElement> | undefined;
}) {
  return (
    <div
      className={`rah-unified-composer ${props.className ?? ""}`}
      data-surface={props.surface}
      data-pwa={props.isPwa ? "true" : "false"}
      data-composer-expanded={props.expanded ? "true" : "false"}
      onFocusCapture={props.onFocusCapture}
      onPointerDownCapture={props.onPointerDownCapture}
    >
      {props.children}
    </div>
  );
}

export function UnifiedComposerToolbar(props: {
  leading: ReactNode;
  trailing: ReactNode;
  className?: string | undefined;
  leadingClassName?: string | undefined;
  trailingClassName?: string | undefined;
}) {
  return (
    <div
      className={`rah-composer-toolbar flex min-w-0 items-center justify-between gap-2 ${props.className ?? ""}`}
    >
      <div
        className={`rah-composer-toolbar-leading flex min-w-0 items-center gap-1 md:gap-1.5 ${props.leadingClassName ?? ""}`}
      >
        {props.leading}
      </div>
      <div
        className={`rah-composer-toolbar-trailing flex min-w-0 shrink-0 items-center justify-end gap-1 md:gap-1.5 ${props.trailingClassName ?? ""}`}
      >
        {props.trailing}
      </div>
    </div>
  );
}
