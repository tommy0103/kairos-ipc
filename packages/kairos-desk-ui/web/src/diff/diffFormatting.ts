import type { PatchSetProjection } from "@/api/types";

export function formatPatchSetSummary(patchSet: Pick<PatchSetProjection, "filesChanged" | "addedLines" | "removedLines">): string {
  const fileLabel = patchSet.filesChanged === 1 ? "file" : "files";
  return `${patchSet.filesChanged} ${fileLabel} · +${patchSet.addedLines} -${patchSet.removedLines}`;
}

export function findFileDiff(patchSet: PatchSetProjection | null | undefined, fileId: string | null | undefined) {
  if (!patchSet) {
    return null;
  }

  return patchSet.files.find((file) => file.id === fileId) ?? patchSet.files[0] ?? null;
}
