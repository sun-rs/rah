import type { ManagedSession, StoredSessionRef } from "@rah/runtime-protocol";

export const OPEN_CODE_MODEL_PROVIDER_SELECT_SQL = `(
  select json_extract(mm.data, '$.providerID')
  from message mm
  where mm.session_id = s.id
    and json_extract(mm.data, '$.role') = 'assistant'
    and nullif(trim(json_extract(mm.data, '$.providerID')), '') is not null
  order by mm.time_created desc, mm.id desc
  limit 1
)`;

export function openCodeStoredSessionIdentity(
  ref: StoredSessionRef,
): Pick<ManagedSession, "provider" | "providerSessionId" | "modelProvider" | "launchSource"> {
  return {
    provider: "opencode",
    providerSessionId: ref.providerSessionId,
    ...(ref.modelProvider ? { modelProvider: ref.modelProvider } : {}),
    launchSource: "web",
  };
}
