import React from "react";
import type { ConversationActivityKind } from "@rah/runtime-protocol";
import {
  Bot,
  FilePenLine,
  FileSearch,
  GitBranch,
  Globe2,
  ListChecks,
  Search,
  Terminal,
  Workflow,
  Wrench,
} from "lucide-react";

export function ConversationActivityIcon(props: {
  kind: ConversationActivityKind;
  size?: number;
}) {
  const size = props.size ?? 13;
  switch (props.kind) {
    case "command":
      return <Terminal size={size} />;
    case "file_read":
      return <FileSearch size={size} />;
    case "file_change":
      return <FilePenLine size={size} />;
    case "search":
      return <Search size={size} />;
    case "web":
      return <Globe2 size={size} />;
    case "git":
      return <GitBranch size={size} />;
    case "subagent":
      return <Bot size={size} />;
    case "plan":
      return <ListChecks size={size} />;
    case "automation":
      return <Workflow size={size} />;
    default:
      return <Wrench size={size} />;
  }
}

export function conversationActivityLabel(
  kind: ConversationActivityKind,
  count: number,
  running: boolean,
): string {
  const plural = count === 1 ? "" : "s";
  switch (kind) {
    case "command":
      return running ? `Running ${count} command${plural}` : `Ran ${count} command${plural}`;
    case "file_read":
      return running ? `Reading ${count} file${plural}` : `Read ${count} file${plural}`;
    case "file_change":
      return running ? `Editing ${count} file${plural}` : `Edited ${count} file${plural}`;
    case "search":
      return running ? "Searching files" : "Searched files";
    case "web":
      return running ? "Searching the web" : "Searched the web";
    case "git":
      return running ? "Updating Git" : "Updated Git";
    case "subagent":
      return running
        ? `Coordinating ${count} subagent${plural}`
        : `Coordinated ${count} subagent${plural}`;
    case "plan":
      return running ? "Updating the plan" : "Updated the plan";
    case "automation":
      return running ? "Running automation" : "Ran automation";
    default:
      return running ? `Using ${count} tool${plural}` : `Used ${count} tool${plural}`;
  }
}
