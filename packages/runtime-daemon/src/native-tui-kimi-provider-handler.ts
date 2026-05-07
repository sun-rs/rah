import { readFileSync } from "node:fs";
import {
  createKimiWireActivityState,
  discoverKimiStoredSessions,
  translateKimiWireLinesToActivities,
} from "./kimi-session-files";
import {
  EMPTY_NATIVE_TUI_OUTPUT_OBSERVATION,
  sameNativeTuiDirectory,
} from "./native-tui-provider-handler-utils";
import type {
  NativeTuiMirrorUpdate,
  NativeTuiProviderHandler,
  NativeTuiProviderMirror,
  NativeTuiProviderRuntimeSession,
} from "./native-tui-provider-runtime-types";

function updateKimiMirror(
  session: NativeTuiProviderRuntimeSession,
  mirror: NativeTuiProviderMirror | undefined,
): NativeTuiMirrorUpdate {
  if (mirror?.provider !== "kimi") {
    if (!session.providerSessionId) {
      return { status: "missing" };
    }
    const record = discoverKimiStoredSessions().find(
      (candidate) =>
        candidate.ref.providerSessionId === session.providerSessionId &&
        sameNativeTuiDirectory(candidate.ref.cwd ?? candidate.ref.rootDir, session.cwd),
    ) ?? discoverKimiStoredSessions().find(
      (candidate) => candidate.ref.providerSessionId === session.providerSessionId,
    );
    if (!record) {
      return { status: "missing" };
    }
    mirror = {
      provider: "kimi",
      providerSessionId: session.providerSessionId,
      record,
      processedLineCount: 0,
      activityState: createKimiWireActivityState({
        turnIdPrefix: `kimi-native:${session.sessionId}`,
      }),
    };
  }

  let lines: string[];
  try {
    lines = readFileSync(mirror.record.wirePath, "utf8").split(/\r?\n/).filter(Boolean);
  } catch (error) {
    return { status: "failed", mirror, phase: "read_kimi_wire", error };
  }
  if (mirror.processedLineCount > lines.length) {
    mirror.processedLineCount = 0;
    mirror.activityState = createKimiWireActivityState({
      turnIdPrefix: `kimi-native:${session.sessionId}`,
    });
  }
  const nextLines = lines.slice(mirror.processedLineCount);
  mirror.processedLineCount = lines.length;
  const items = translateKimiWireLinesToActivities(
    mirror.record.ref.providerSessionId,
    nextLines,
    mirror.activityState,
  ).map((item) => ({
    meta: item.meta,
    activity: item.activity,
  }));
  return { status: "ok", mirror, items };
}

export const kimiNativeTuiProviderHandler: NativeTuiProviderHandler = {
  provider: "kimi",
  observeOutput: () => EMPTY_NATIVE_TUI_OUTPUT_OBSERVATION,
  updateMirror: updateKimiMirror,
};
