import { describe, expect, test } from "bun:test";
import { markdownToBlocks } from "./ArtifactMarkdown";

describe("markdownToBlocks", () => {
  test("projects common Markdown from remark AST without HTML blocks", () => {
    const blocks = markdownToBlocks("# Title\n\nHello **agent**.\n\n<script>alert('x')</script>\n\n- one\n- two");

    expect(blocks).toEqual([
      { kind: "heading", depth: 1, id: "title", text: "Title" },
      { kind: "paragraph", text: "Hello agent." },
      { kind: "list", ordered: false, items: ["one", "two"] },
    ]);
  });

  test("creates stable unique heading ids for interactive outlines", () => {
    const blocks = markdownToBlocks("## Decision needed\n\n## Decision needed\n\n### Ship v1");

    expect(blocks).toEqual([
      { kind: "heading", depth: 2, id: "decision-needed", text: "Decision needed" },
      { kind: "heading", depth: 2, id: "decision-needed-2", text: "Decision needed" },
      { kind: "heading", depth: 3, id: "ship-v1", text: "Ship v1" },
    ]);
  });
});
