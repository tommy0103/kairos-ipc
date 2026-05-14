import { unified } from "unified";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";

export type ArtifactMarkdownBlock =
  | { kind: "heading"; depth: 1 | 2 | 3 | 4 | 5 | 6; id: string; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "code"; language: string | null; value: string }
  | { kind: "quote"; text: string }
  | { kind: "table"; rows: string[][] }
  | { kind: "rule" };

interface MarkdownNode {
  type: string;
  value?: string;
  depth?: number;
  ordered?: boolean;
  lang?: string;
  children?: MarkdownNode[];
}

const parser = unified().use(remarkParse).use(remarkGfm);

export function markdownToBlocks(markdown: string): ArtifactMarkdownBlock[] {
  const root = parser.parse(markdown) as MarkdownNode;
  const headingIds = new Map<string, number>();
  return (root.children ?? []).flatMap((node) => blockFromNode(node, headingIds));
}

function blockFromNode(node: MarkdownNode, headingIds: Map<string, number>): ArtifactMarkdownBlock[] {
  if (node.type === "heading") {
    const text = extractText(node).trim();
    if (!text) {
      return [];
    }
    return [{ kind: "heading", depth: normalizeDepth(node.depth), id: uniqueHeadingId(text, headingIds), text }];
  }

  if (node.type === "paragraph") {
    const text = extractText(node).trim();
    return text ? [{ kind: "paragraph", text }] : [];
  }

  if (node.type === "list") {
    const items = (node.children ?? []).map(extractText).map((text) => text.trim()).filter(Boolean);
    return items.length > 0 ? [{ kind: "list", ordered: Boolean(node.ordered), items }] : [];
  }

  if (node.type === "code") {
    return [{ kind: "code", language: node.lang ?? null, value: node.value ?? "" }];
  }

  if (node.type === "blockquote") {
    const text = extractText(node).trim();
    return text ? [{ kind: "quote", text }] : [];
  }

  if (node.type === "table") {
    const rows = (node.children ?? [])
      .map((row) => (row.children ?? []).map((cell) => extractText(cell).trim()))
      .filter((row) => row.some(Boolean));
    return rows.length > 0 ? [{ kind: "table", rows }] : [];
  }

  if (node.type === "thematicBreak") {
    return [{ kind: "rule" }];
  }

  return [];
}

function extractText(node: MarkdownNode): string {
  if (node.type === "html") {
    return "";
  }

  if (typeof node.value === "string") {
    return node.value;
  }

  return (node.children ?? []).map(extractText).join(node.type === "listItem" ? " " : "");
}

function normalizeDepth(depth: number | undefined): 1 | 2 | 3 | 4 | 5 | 6 {
  if (depth === 1 || depth === 2 || depth === 3 || depth === 4 || depth === 5 || depth === 6) {
    return depth;
  }
  return 2;
}

function uniqueHeadingId(text: string, headingIds: Map<string, number>): string {
  const base = slugifyHeading(text) || "section";
  const count = headingIds.get(base) ?? 0;
  headingIds.set(base, count + 1);
  return count === 0 ? base : `${base}-${count + 1}`;
}

function slugifyHeading(text: string): string {
  return text
    .trim()
    .toLocaleLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
}
