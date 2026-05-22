import type { ReactNode, Ref } from "react";

export function ConversationPageShell(props: {
  as?: "div" | "section";
  rootRef?: Ref<HTMLDivElement>;
  className?: string;
  header?: ReactNode;
  notices?: ReactNode;
  body?: ReactNode;
  composer?: ReactNode;
  children?: ReactNode;
}) {
  if (props.as === "section") {
    return (
      <section className={props.className ?? "flex h-full min-h-0 flex-col"}>
        {props.header}
        {props.notices}
        {props.body}
        {props.composer}
        {props.children}
      </section>
    );
  }

  return (
    <div ref={props.rootRef} className={props.className ?? "flex h-full min-h-0 flex-col"}>
      {props.header}
      {props.notices}
      {props.body}
      {props.composer}
      {props.children}
    </div>
  );
}
