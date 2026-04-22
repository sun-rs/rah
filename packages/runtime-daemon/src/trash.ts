import { mkdir, rename, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function resolveTrashDir(): string {
  const override = process.env.RAH_TRASH_DIR?.trim();
  if (override) {
    return override;
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), ".Trash");
  }
  if (process.platform === "linux") {
    return path.join(os.homedir(), ".local", "share", "Trash", "files");
  }
  throw new Error(`Trash is not supported on ${process.platform}.`);
}

async function uniqueTrashTarget(targetPath: string): Promise<string> {
  const directory = path.dirname(targetPath);
  const extension = path.extname(targetPath);
  const basename = extension ? path.basename(targetPath, extension) : path.basename(targetPath);
  let candidate = targetPath;
  let suffix = 2;
  for (;;) {
    try {
      await stat(candidate);
      candidate = path.join(directory, `${basename} ${suffix}${extension}`);
      suffix += 1;
    } catch {
      return candidate;
    }
  }
}

export async function movePathToTrash(sourcePath: string): Promise<void> {
  const trashDir = resolveTrashDir();
  await mkdir(trashDir, { recursive: true });
  const target = await uniqueTrashTarget(path.join(trashDir, path.basename(sourcePath)));
  await rename(sourcePath, target);
}
