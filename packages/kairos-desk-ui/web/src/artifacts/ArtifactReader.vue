<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { MessageSquareText, MoreHorizontal } from "lucide-vue-next";
import type { ArtifactDetailProjection, Surface } from "@/api/types";
import { markdownToBlocks, type ArtifactMarkdownBlock } from "./ArtifactMarkdown";

const props = defineProps<{
  artifact: ArtifactDetailProjection;
}>();

const emit = defineEmits<{
  navigate: [surface: Surface, targetId: string, focusId?: string | null];
}>();

const blocks = computed(() => markdownToBlocks(props.artifact.markdown));
const toc = computed(() => blocks.value.filter(isHeading));
const roomSourceRef = computed(() => props.artifact.sourceRefs.find((ref) => ref.targetSurface === "rooms") ?? null);
const articleRef = ref<HTMLElement | null>(null);
const activeHeadingId = ref<string | null>(null);
let scrollRoot: Element | null = null;

const currentHeadingId = computed(() => activeHeadingId.value ?? toc.value[0]?.id ?? null);

type HeadingBlock = Extract<ArtifactMarkdownBlock, { kind: "heading" }>;
type SourceRef = ArtifactDetailProjection["sourceRefs"][number];

function isHeading(block: ArtifactMarkdownBlock): block is Extract<ArtifactMarkdownBlock, { kind: "heading" }> {
  return block.kind === "heading";
}

function headingTag(depth: number): string {
  return `h${Math.min(Math.max(depth, 1), 6)}`;
}

function headingDepthClass(depth: number): string {
  return `depth-${Math.min(Math.max(depth, 1), 6)}`;
}

function selectHeading(heading: HeadingBlock): void {
  activeHeadingId.value = heading.id;
  const target = document.getElementById(heading.id);
  if (!target) {
    return;
  }

  target.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "start" });
  target.focus({ preventScroll: true });
}

function selectSourceRef(ref: SourceRef): void {
  emit("navigate", ref.targetSurface, ref.targetId, ref.targetAnchorId ?? null);
}

function discussInRoom(): void {
  if (roomSourceRef.value) {
    selectSourceRef(roomSourceRef.value);
    return;
  }

  emit("navigate", "rooms", props.artifact.sourceRoomId, null);
}

function sourceRefKind(ref: SourceRef): string {
  if (ref.targetSurface === "projects") {
    return "board";
  }
  if (ref.targetSurface === "rooms") {
    return "message";
  }
  if (ref.targetSurface === "observe") {
    return "trace";
  }
  return ref.targetSurface;
}

function tableHead(rows: string[][]): string[] {
  return rows[0] ?? [];
}

function tableBody(rows: string[][]): string[][] {
  return rows.slice(1);
}

function setupHeadingTracking(): void {
  scrollRoot?.removeEventListener("scroll", updateActiveHeading);
  const article = articleRef.value;
  if (!article) {
    activeHeadingId.value = toc.value[0]?.id ?? null;
    return;
  }

  scrollRoot = article.closest(".content-scroll");
  scrollRoot?.addEventListener("scroll", updateActiveHeading, { passive: true });
  updateActiveHeading();
}

function updateActiveHeading(): void {
  const rootTop = scrollRoot?.getBoundingClientRect().top ?? 0;
  const headings = toc.value.map((heading) => document.getElementById(heading.id)).filter((element): element is HTMLElement => element !== null);
  if (headings.length === 0) {
    activeHeadingId.value = null;
    return;
  }

  const anchorLine = rootTop + 112;
  const current = headings.reduce((active, heading) => (heading.getBoundingClientRect().top <= anchorLine ? heading : active), headings[0]!);
  activeHeadingId.value = current.id;
}

function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

watch(blocks, () => nextTick(setupHeadingTracking), { immediate: true });
onBeforeUnmount(() => scrollRoot?.removeEventListener("scroll", updateActiveHeading));
</script>

<template>
  <div class="content-scroll">
    <div class="artifact-page">
      <div class="artifact-shell">
        <div class="artifact-toolbar">
          <div>
            <div class="kicker">Artifact reader</div>
            <div class="panel-title">{{ artifact.title }}</div>
            <div class="dashboard-subtitle">By @{{ artifact.authorName }} · Source {{ artifact.sourceRoomId }}</div>
          </div>
          <div class="artifact-actions" aria-label="Artifact actions">
            <span class="pill">{{ artifact.status }}</span>
            <button class="secondary-button" type="button" @click="discussInRoom">
              <MessageSquareText :size="14" aria-hidden="true" />
              Discuss in room
            </button>
            <details class="artifact-more-menu">
              <summary class="icon-button" aria-label="More artifact actions" title="More artifact actions">
                <MoreHorizontal :size="16" aria-hidden="true" />
              </summary>
              <div class="artifact-more-panel" role="menu">
                <button type="button" role="menuitem">Copy artifact link</button>
              </div>
            </details>
          </div>
        </div>

        <div class="artifact-layout">
          <article ref="articleRef" class="artifact-body" aria-label="Rendered artifact">
            <template v-for="(block, index) in blocks" :key="`${block.kind}-${index}`">
              <component :is="headingTag(block.depth)" v-if="block.kind === 'heading'" :id="block.id" data-artifact-heading tabindex="-1">{{ block.text }}</component>
              <p v-else-if="block.kind === 'paragraph'">{{ block.text }}</p>
              <ol v-else-if="block.kind === 'list' && block.ordered">
                <li v-for="item in block.items" :key="item">{{ item }}</li>
              </ol>
              <ul v-else-if="block.kind === 'list'">
                <li v-for="item in block.items" :key="item">{{ item }}</li>
              </ul>
              <pre v-else-if="block.kind === 'code'"><code>{{ block.value }}</code></pre>
              <blockquote v-else-if="block.kind === 'quote'">{{ block.text }}</blockquote>
              <table v-else-if="block.kind === 'table'">
                <thead>
                  <tr>
                    <th v-for="cell in tableHead(block.rows)" :key="cell">{{ cell }}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="(row, rowIndex) in tableBody(block.rows)" :key="rowIndex">
                    <td v-for="cell in row" :key="cell">{{ cell }}</td>
                  </tr>
                </tbody>
              </table>
              <hr v-else-if="block.kind === 'rule'" />
            </template>
          </article>

          <aside class="artifact-outline" aria-label="Artifact outline">
            <div class="artifact-outline-section">
              <div class="kicker">Outline</div>
              <button
                v-for="heading in toc"
                :key="heading.id"
                class="outline-heading"
                :class="[headingDepthClass(heading.depth), { active: currentHeadingId === heading.id }]"
                type="button"
                @click="selectHeading(heading)"
              >
                <span>{{ heading.text }}</span>
              </button>
            </div>
            <div class="artifact-outline-meta">
              <div class="kicker">Source refs</div>
              <button v-for="ref in artifact.sourceRefs" :key="`${ref.targetSurface}:${ref.targetId}:${ref.targetAnchorId ?? ''}`" class="source-ref-link" type="button" @click="selectSourceRef(ref)">
                <span>{{ ref.label }}</span>
                <span>{{ sourceRefKind(ref) }}</span>
              </button>
            </div>
          </aside>
        </div>
      </div>
    </div>
  </div>
</template>
