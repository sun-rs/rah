export const DATA_IMAGE_URL_PATTERN = /data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=\r\n]+/g;
const DATA_IMAGE_URL_EXACT_PATTERN = /^data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=\r\n]+$/;

export function imageFilesFromClipboardData(data: DataTransfer | null): File[] {
  if (!data) {
    return [];
  }
  const files: File[] = [];
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind !== "file" || !item.type.startsWith("image/")) {
      continue;
    }
    const file = item.getAsFile();
    if (file) {
      files.push(file);
    }
  }
  if (files.length > 0) {
    return files;
  }
  return Array.from(data.files ?? []).filter((file) => file.type.startsWith("image/"));
}

export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
      } else {
        reject(new Error("Clipboard image could not be read as a data URL."));
      }
    });
    reader.addEventListener("error", () => {
      reject(reader.error ?? new Error("Clipboard image could not be read."));
    });
    reader.readAsDataURL(file);
  });
}

export async function readImageDataUrlsFromClipboardData(data: DataTransfer | null): Promise<string[]> {
  const files = imageFilesFromClipboardData(data);
  if (files.length === 0) {
    return [];
  }
  return Promise.all(files.map(readFileAsDataUrl));
}

export function appendImageDataUrlsToText(text: string, imageDataUrls: readonly string[]): string {
  const trimmedText = text.trim();
  const images = imageDataUrls.filter((url) => DATA_IMAGE_URL_EXACT_PATTERN.test(url));
  return [trimmedText, ...images].filter((part) => part.trim()).join("\n\n");
}
