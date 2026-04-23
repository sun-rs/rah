import { Suspense, lazy } from "react";

const ReactMarkdown = lazy(async () => ({
  default: (await import("react-markdown")).default,
}));

export function MarkdownRenderer(props: {
  className?: string;
  content: string;
  fallbackClassName?: string;
}) {
  return (
    <Suspense
      fallback={
        <div
          className={
            props.fallbackClassName ??
            "whitespace-pre-wrap break-words [overflow-wrap:anywhere]"
          }
        >
          {props.content}
        </div>
      }
    >
      <div className={props.className}>
        <ReactMarkdown>{props.content}</ReactMarkdown>
      </div>
    </Suspense>
  );
}
