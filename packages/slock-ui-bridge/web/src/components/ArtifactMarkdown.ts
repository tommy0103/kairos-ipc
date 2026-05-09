import type { Content, Heading, Link, List, ListItem, Nodes, Root, Table, TableCell, TableRow } from "mdast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { computed, defineComponent, h, type PropType, type VNodeChild } from "vue";

const markdownProcessor = unified().use(remarkParse).use(remarkGfm);

export default defineComponent({
  name: "ArtifactMarkdown",
  props: {
    source: {
      type: String,
      required: true,
    },
    compact: {
      type: Boolean,
      default: false,
    },
    labelledBy: {
      type: String as PropType<string | undefined>,
      default: undefined,
    },
  },
  setup(props) {
    const tree = computed(() => parseMarkdown(props.source));

    return () => h(
      "div",
      {
        class: ["artifact-markdown", props.compact ? "compact" : ""],
        "aria-labelledby": props.labelledBy,
      },
      renderChildren(tree.value.children),
    );
  },
});

export function parseMarkdown(source: string): Root {
  return markdownProcessor.parse(source || "") as Root;
}

function renderChildren(children: Nodes[] | undefined): VNodeChild[] {
  return (children ?? []).map((child, index) => renderNode(child, `md-${index}`)).filter(Boolean) as VNodeChild[];
}

function renderNode(node: Nodes, key: string): VNodeChild {
  switch (node.type) {
    case "root":
      return renderChildren((node as Root).children);
    case "heading":
      return renderHeading(node as Heading, key);
    case "paragraph":
      return h("p", { key }, renderChildren(node.children));
    case "text":
      return node.value;
    case "emphasis":
      return h("em", { key }, renderChildren(node.children));
    case "strong":
      return h("strong", { key }, renderChildren(node.children));
    case "delete":
      return h("del", { key }, renderChildren(node.children));
    case "inlineCode":
      return h("code", { key }, node.value);
    case "break":
      return h("br", { key });
    case "link":
      return renderLink(node as Link, key);
    case "list":
      return renderList(node as List, key);
    case "listItem":
      return renderListItem(node as ListItem, key);
    case "blockquote":
      return h("blockquote", { key }, renderChildren(node.children));
    case "code":
      return renderCodeBlock(node, key);
    case "thematicBreak":
      return h("hr", { key });
    case "table":
      return renderTable(node as Table, key);
    case "tableRow":
      return renderTableRow(node as TableRow, key, false);
    case "tableCell":
      return renderTableCell(node as TableCell, key, false);
    case "html":
      return h("code", { key, class: "markdown-html-literal" }, node.value);
    default:
      return "value" in node && typeof node.value === "string" ? node.value : h("span", { key }, renderChildren("children" in node ? node.children : []));
  }
}

function renderHeading(node: Heading, key: string): VNodeChild {
  const depth = Math.min(Math.max(node.depth, 1), 4);
  return h(`h${depth}`, { key }, renderChildren(node.children));
}

function renderLink(node: Link, key: string): VNodeChild {
  const href = safeHref(node.url);
  if (!href) return h("span", { key }, renderChildren(node.children));
  return h("a", { key, href, target: "_blank", rel: "noreferrer" }, renderChildren(node.children));
}

function renderList(node: List, key: string): VNodeChild {
  return h(node.ordered ? "ol" : "ul", { key }, renderChildren(node.children));
}

function renderListItem(node: ListItem, key: string): VNodeChild {
  const children = renderChildren(node.children);
  if (typeof node.checked === "boolean") {
    children.unshift(h("input", { type: "checkbox", checked: node.checked, disabled: true, "aria-label": node.checked ? "completed" : "not completed" }));
  }
  return h("li", { key, class: typeof node.checked === "boolean" ? "task-list-item" : undefined }, children);
}

function renderCodeBlock(node: Extract<Content, { type: "code" }>, key: string): VNodeChild {
  const language = node.lang?.trim();
  return h("figure", { key, class: "markdown-code-block" }, [
    language ? h("figcaption", language) : undefined,
    h("pre", [h("code", node.value)]),
  ]);
}

function renderTable(node: Table, key: string): VNodeChild {
  const [head, ...body] = node.children;
  return h("div", { key, class: "markdown-table-wrap" }, [
    h("table", [
      head ? h("thead", [renderTableRow(head, `${key}-head`, true)]) : undefined,
      body.length ? h("tbody", body.map((row, index) => renderTableRow(row, `${key}-row-${index}`, false))) : undefined,
    ]),
  ]);
}

function renderTableRow(node: TableRow, key: string, header: boolean): VNodeChild {
  return h("tr", { key }, node.children.map((cell, index) => renderTableCell(cell, `${key}-cell-${index}`, header)));
}

function renderTableCell(node: TableCell, key: string, header: boolean): VNodeChild {
  return h(header ? "th" : "td", { key }, renderChildren(node.children));
}

export function safeHref(value: string | undefined): string | undefined {
  const href = value?.trim();
  if (!href) return undefined;
  if (href.startsWith("#") || href.startsWith("/")) return href;
  try {
    const url = new URL(href);
    return ["http:", "https:", "mailto:", "tel:"].includes(url.protocol) ? href : undefined;
  } catch (_error) {
    return undefined;
  }
}
