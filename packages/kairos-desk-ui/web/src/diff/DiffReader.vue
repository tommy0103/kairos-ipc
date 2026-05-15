<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { ChevronDown, FileCode2, FileText, Folder, UnfoldVertical } from "lucide-vue-next";
import type { DiffExpandedLineProjection, DiffLineProjection, FileDiffProjection, PatchSetProjection, Surface } from "@/api/types";
import { findFileDiff, formatPatchSetSummary } from "./diffFormatting";

const props = defineProps<{
  patchSet: PatchSetProjection;
  activeFileId: string | null;
}>();

const emit = defineEmits<{
  navigate: [surface: Surface, targetId?: string, focusId?: string | null];
}>();

const activeFile = computed(() => findFileDiff(props.patchSet, props.activeFileId));
const expandedCollapsedIds = ref<Set<string>>(new Set());
const fileTreeRows = computed(() => buildFileTreeRows(props.patchSet.files));

interface FileTreeDirectory {
  name: string;
  path: string;
  directories: Map<string, FileTreeDirectory>;
  files: FileDiffProjection[];
}

type FileTreeRow =
  | { type: "directory"; id: string; name: string; depth: number }
  | { type: "file"; id: string; name: string; depth: number; file: FileDiffProjection };

watch(
  () => props.activeFileId,
  async (fileId) => {
    if (!fileId) return;
    await nextTick();
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    document.getElementById(fileSectionId(fileId))?.scrollIntoView({ block: "start", behavior: reducedMotion ? "auto" : "smooth" });
  },
);

function selectFile(fileId: string): void {
  emit("navigate", "diff", props.patchSet.id, fileId);
}

function linePrefix(line: DiffLineProjection): string {
  if (line.kind === "addition") return "+";
  if (line.kind === "deletion") return "-";
  return " ";
}

function fileSectionId(fileId: string): string {
  return `diff-file-${fileId}`;
}

function fileDeltaLabel(file: FileDiffProjection): string {
  return `+${file.addedLines} -${file.removedLines}`;
}

function fileStatusLabel(status: FileDiffProjection["status"]): string {
  if (status === "modified") return "M";
  if (status === "deleted") return "D";
  if (status === "added") return "A";
  return "R";
}

function changeBarClass(file: FileDiffProjection, index: number): string {
  const activeBars = Math.min(5, Math.max(1, Math.ceil(file.addedLines / Math.max(1, props.patchSet.addedLines / 5))));
  return index <= activeBars ? "added" : "quiet";
}

function buildFileTreeRows(files: FileDiffProjection[]): FileTreeRow[] {
  const root: FileTreeDirectory = { name: "", path: "", directories: new Map(), files: [] };

  for (const file of files) {
    const segments = file.path.split("/");
    segments.pop();
    let current = root;
    for (const segment of segments) {
      const nextPath = current.path ? `${current.path}/${segment}` : segment;
      let next = current.directories.get(segment);
      if (!next) {
        next = { name: segment, path: nextPath, directories: new Map(), files: [] };
        current.directories.set(segment, next);
      }
      current = next;
    }
    current.files.push(file);
  }

  const rows: FileTreeRow[] = [];
  appendDirectoryRows(root, 0, rows);
  return rows;
}

function appendDirectoryRows(directory: FileTreeDirectory, depth: number, rows: FileTreeRow[]): void {
  const directories = [...directory.directories.values()].sort((left, right) => left.name.localeCompare(right.name));
  const files = [...directory.files].sort((left, right) => fileName(left.path).localeCompare(fileName(right.path)));

  for (const child of directories) {
    rows.push({ type: "directory", id: child.path, name: child.name, depth });
    appendDirectoryRows(child, depth + 1, rows);
  }

  for (const file of files) {
    rows.push({ type: "file", id: file.id, name: fileName(file.path), depth, file });
  }
}

function fileName(path: string): string {
  return path.split("/").at(-1) ?? path;
}

function toggleCollapsed(lineId: string): void {
  const next = new Set(expandedCollapsedIds.value);
  if (next.has(lineId)) {
    next.delete(lineId);
  } else {
    next.add(lineId);
  }
  expandedCollapsedIds.value = next;
}

function isCollapsedExpanded(lineId: string): boolean {
  return expandedCollapsedIds.value.has(lineId);
}

function expandedContextLines(line: DiffLineProjection): DiffExpandedLineProjection[] {
  return isCollapsedExpanded(line.id) ? (line.expandedLines ?? []) : [];
}

function collapsedLineLabel(line: DiffLineProjection, hunkHeader: string): string {
  if (line.content.trim()) {
    return line.content;
  }

  return hunkHeader;
}
</script>

<template>
  <div class="content-scroll diff-content-scroll">
    <div class="diff-reader-page">
      <div class="diff-reader-topline">
        <button class="ghost-link" type="button" @click="emit('navigate', 'work', patchSet.workCardId)">Back to work</button>
        <span>{{ patchSet.title }}</span>
      </div>

      <section class="diff-commit-panel" aria-label="Patch review note">
        <div class="diff-commit-message">
          <div class="diff-agent-avatar" aria-hidden="true">{{ patchSet.agentReply.actorInitials }}</div>
          <div class="diff-agent-copy">
            <div class="diff-commit-meta">
              <strong>{{ patchSet.agentReply.actorName }}</strong>
              <span>{{ patchSet.agentReply.sentAt }}</span>
              <span>{{ formatPatchSetSummary(patchSet) }}</span>
            </div>
            <p>{{ patchSet.agentReply.body }}</p>
          </div>
        </div>

        <nav v-if="patchSet.artifactLinks.length" class="diff-artifact-nav" aria-label="Artifacts for this change">
          <button v-for="artifact in patchSet.artifactLinks" :key="artifact.id" class="diff-artifact-link" type="button" @click="emit('navigate', 'artifact', artifact.id)">
            <FileText :size="15" aria-hidden="true" />
            <span class="diff-artifact-copy">
              <strong>{{ artifact.title }}</strong>
              <span>{{ artifact.summary }}</span>
            </span>
            <span class="diff-artifact-meta">{{ artifact.status }}</span>
          </button>
        </nav>
      </section>

      <div class="diff-reader-layout">
        <aside class="diff-file-list" aria-label="Changed files">
          <div class="diff-file-tree" role="tree">
            <template v-for="row in fileTreeRows" :key="row.id">
              <div v-if="row.type === 'directory'" class="diff-tree-directory" :style="{ paddingLeft: `${row.depth * 14 + 4}px` }" role="treeitem" aria-expanded="true">
                <ChevronDown :size="13" aria-hidden="true" />
                <Folder :size="15" aria-hidden="true" />
                <span>{{ row.name }}</span>
              </div>
              <button
                v-else
                class="diff-tree-file"
                :class="{ active: activeFile?.id === row.file.id }"
                :style="{ paddingLeft: `${row.depth * 14 + 4}px` }"
                :aria-current="activeFile?.id === row.file.id ? 'true' : undefined"
                role="treeitem"
                type="button"
                @click="selectFile(row.file.id)"
              >
                <FileCode2 :size="14" aria-hidden="true" />
                <span class="diff-file-name">{{ row.name }}</span>
              </button>
            </template>
          </div>
        </aside>

        <main class="diff-main" aria-label="File diffs">
          <article v-for="file in patchSet.files" :id="fileSectionId(file.id)" :key="file.id" class="diff-file-block" :class="{ active: activeFile?.id === file.id }">
            <div class="diff-file-header">
              <div class="diff-file-title-row">
                <ChevronDown class="diff-collapse-mark" :size="16" aria-hidden="true" />
                <FileCode2 :size="15" aria-hidden="true" />
                <h2>{{ file.path }}</h2>
                <span class="diff-file-status" :aria-label="file.status">{{ fileStatusLabel(file.status) }}</span>
              </div>
              <div class="diff-file-actions">
                <span class="changed-file-stat added">+{{ file.addedLines }}</span>
                <span class="changed-file-stat removed">-{{ file.removedLines }}</span>
                <span class="diff-change-bars" :aria-label="fileDeltaLabel(file)">
                  <span v-for="index in 5" :key="index" class="diff-change-bar" :class="changeBarClass(file, index)"></span>
                </span>
              </div>
              <p v-if="file.previousPath">Previously {{ file.previousPath }}</p>
            </div>

            <div class="diff-hunk-list">
              <section v-for="hunk in file.hunks" :key="hunk.id" class="diff-hunk">
                <div class="diff-hunk-header">{{ hunk.header }}</div>
                <div class="diff-lines" role="table" :aria-label="`${file.path} ${hunk.header}`">
                  <template v-for="line in hunk.lines" :key="line.id">
                    <div class="diff-line" :class="line.kind" role="row">
                      <template v-if="line.kind === 'collapsed'">
                        <button
                          class="diff-line-expand"
                          type="button"
                          role="cell"
                          :aria-expanded="isCollapsedExpanded(line.id)"
                          :aria-label="isCollapsedExpanded(line.id) ? 'Hide expanded unchanged lines' : `Expand ${line.collapsedLines ?? 0} unchanged lines`"
                          @click="toggleCollapsed(line.id)"
                        >
                          <span class="diff-fold-gutter" aria-hidden="true">
                            <UnfoldVertical :size="17" />
                          </span>
                          <span class="diff-collapsed-header">{{ collapsedLineLabel(line, hunk.header) }}</span>
                        </button>
                      </template>
                      <template v-else>
                        <span class="diff-line-number" role="cell">{{ line.oldLine ?? '' }}</span>
                        <span class="diff-line-number" role="cell">{{ line.newLine ?? '' }}</span>
                        <span class="diff-line-prefix" role="cell">{{ linePrefix(line) }}</span>
                        <code class="diff-line-content" role="cell">{{ line.content }}</code>
                      </template>
                    </div>
                    <div v-for="expandedLine in expandedContextLines(line)" :key="expandedLine.id" class="diff-line context expanded-context" role="row">
                      <span class="diff-line-number" role="cell">{{ expandedLine.oldLine ?? '' }}</span>
                      <span class="diff-line-number" role="cell">{{ expandedLine.newLine ?? '' }}</span>
                      <span class="diff-line-prefix" role="cell"> </span>
                      <code class="diff-line-content" role="cell">{{ expandedLine.content }}</code>
                    </div>
                  </template>
                </div>
              </section>
            </div>
          </article>
        </main>
      </div>
    </div>
  </div>
</template>
