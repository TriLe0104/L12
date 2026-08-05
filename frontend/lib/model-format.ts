/** Which 3D formats an order may carry, and how to name one from a filename.
 *
 *  Deliberately dependency-free: this is the only part of the model feature the
 *  cards need in the initial bundle. Everything that can actually parse geometry
 *  — three.js, the per-format loaders, the OpenCascade and Rhino WASM — is
 *  reached through a dynamic import from the viewer instead. */

export type ModelFormat = "obj" | "fbx" | "step" | "3dm";

/** Extension -> format. Mirrors MODEL_FORMATS in backend/app/routers/uploads.py. */
const BY_EXTENSION: Record<string, ModelFormat> = {
  obj: "obj",
  fbx: "fbx",
  stp: "step",
  step: "step",
  "3dm": "3dm",
};

/** What the file picker offers. The server re-checks the leading bytes anyway. */
export const MODEL_ACCEPT = ".obj,.fbx,.stp,.step,.3dm";

export const MODEL_FORMAT_LABEL: Record<ModelFormat, string> = {
  obj: "OBJ",
  fbx: "FBX",
  step: "STEP",
  "3dm": "3DM",
};

export function detectModelFormat(name: string | null | undefined): ModelFormat | null {
  if (!name) return null;
  const extension = name.split(".").pop()?.toLowerCase() ?? "";
  return BY_EXTENSION[extension] ?? null;
}

/** "2.6 MB" — the card labels the slot without downloading the geometry. */
export function formatModelSize(bytes: number | null | undefined): string | null {
  if (!bytes || bytes < 0) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} kB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
