import { stat } from "node:fs/promises";
import { movePathToTrash } from "../packages/runtime-daemon/src/trash";

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

export async function movePathToTrashIfExists(sourcePath: string | null | undefined): Promise<void> {
  if (!sourcePath) {
    return;
  }
  try {
    await stat(sourcePath);
  } catch (error) {
    if (isMissingPathError(error)) {
      return;
    }
    throw error;
  }
  await movePathToTrash(sourcePath);
}
