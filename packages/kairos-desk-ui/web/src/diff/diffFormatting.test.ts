import { describe, expect, test } from "bun:test";
import type { PatchSetProjection } from "@/api/types";
import { findFileDiff, formatPatchSetSummary } from "./diffFormatting";

const patchSet: PatchSetProjection = {
  id: "patch-fibonacci-cli",
  workCardId: "card-build-cli",
  projectId: "project-fibonacci-cli",
  title: "Fibonacci CLI implementation",
  createdAtLabel: "10:46",
  traceId: "trace-run-42",
  agentReply: {
    actorName: "alice",
    actorInitials: "A",
    sentAt: "10:46",
    body: "The patch is ready for review.",
  },
  artifactLinks: [],
  filesChanged: 3,
  addedLines: 136,
  removedLines: 137,
  files: [
    {
      id: "file-src-fibonacci",
      path: "src/fibonacci.ts",
      status: "modified",
      addedLines: 24,
      removedLines: 18,
      hunks: [],
    },
  ],
};

describe("diff formatting", () => {
  test("formats board-sized patch summaries from typed projections", () => {
    expect(formatPatchSetSummary(patchSet)).toBe("3 files · +136 -137");
  });

  test("finds a focused file and falls back to the first changed file", () => {
    expect(findFileDiff(patchSet, "file-src-fibonacci")?.path).toBe("src/fibonacci.ts");
    expect(findFileDiff(patchSet, "missing")?.path).toBe("src/fibonacci.ts");
  });
});
