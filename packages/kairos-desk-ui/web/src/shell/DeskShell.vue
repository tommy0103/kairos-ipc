<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { ChevronDown, Search, X } from "lucide-vue-next";
import type { DeskSnapshot, InspectorProjection, Surface } from "@/api/types";
import AgentsPage from "@/agents/AgentsPage.vue";
import ArtifactReader from "@/artifacts/ArtifactReader.vue";
import DiffReader from "@/diff/DiffReader.vue";
import ObservePage from "@/observe/ObservePage.vue";
import ProjectsDashboard from "@/projects/ProjectsDashboard.vue";
import WorkDetailPage from "@/projects/WorkDetailPage.vue";
import RoomPage from "@/rooms/RoomPage.vue";
import DeskHeader from "./DeskHeader.vue";
import DeskSidebar from "./DeskSidebar.vue";
import RightInspector from "./RightInspector.vue";
import WorkspaceRail from "./WorkspaceRail.vue";

const props = defineProps<{
  snapshot: DeskSnapshot;
}>();

interface RouteState {
  surface: Surface;
  targetId: string;
  panelMode: InspectorProjection["mode"];
  panelId: string;
  focusId: string | null;
  returnArtifactId: string | null;
}

const routeState = readRouteState(props.snapshot);
const activeSurface = ref<Surface>(routeState.surface);
const activeTargetId = ref(routeState.targetId);
const panelMode = ref<InspectorProjection["mode"]>(routeState.panelMode);
const panelId = ref(routeState.panelId);
const activeFocusId = ref<string | null>(routeState.focusId);
const returnArtifactId = ref<string | null>(routeState.returnArtifactId);

const activeRoom = computed(() => props.snapshot.rooms.find((room) => room.id === activeTargetId.value) ?? props.snapshot.rooms[0]!);
const activeProject = computed(() => projectForTarget(props.snapshot, activeTargetId.value) ?? props.snapshot.projects[0]!);
const activePatchSet = computed(() => props.snapshot.patchSets.find((patchSet) => patchSet.id === activeTargetId.value) ?? props.snapshot.patchSets[0] ?? null);
const activeWorkCard = computed(() => cardForTarget(props.snapshot, activeTargetId.value) ?? (activePatchSet.value ? cardForTarget(props.snapshot, activePatchSet.value.workCardId) : null) ?? activeProject.value.cards[0] ?? null);
const activeArtifact = computed(() => props.snapshot.artifacts.find((artifact) => artifact.id === activeTargetId.value) ?? props.snapshot.artifacts[0]!);
const activeProjectArtifactTargetId = computed(() => activeProject.value.artifactIds.at(-1) ?? props.snapshot.artifacts[0]?.id ?? "");
const inspectorOpen = ref(false);
const inspectorAvailable = computed(() => activeSurface.value !== "work" && activeSurface.value !== "artifact" && activeSurface.value !== "diff");
const inspectorVisible = computed(() => inspectorAvailable.value && inspectorOpen.value);
const returnArtifact = computed(() => {
  if (activeSurface.value === "artifact" || !returnArtifactId.value) {
    return null;
  }

  return props.snapshot.artifacts.find((artifact) => artifact.id === returnArtifactId.value) ?? null;
});

watch(
  [activeSurface, activeTargetId, panelMode, panelId, activeFocusId, returnArtifactId],
  () => {
    persistRouteState({
      surface: activeSurface.value,
      targetId: activeTargetId.value,
      panelMode: panelMode.value,
      panelId: panelId.value,
      focusId: activeFocusId.value,
      returnArtifactId: returnArtifactId.value,
    });
  },
  { immediate: true },
);

function navigate(surface: Surface, targetId?: string, focusId?: string | null): void {
  applyNavigation(surface, targetId, focusId);
  returnArtifactId.value = null;
}

function navigateFromSourceRef(surface: Surface, targetId?: string, focusId?: string | null): void {
  const sourceArtifactId = activeArtifact.value?.id ?? null;
  applyNavigation(surface, targetId, focusId);
  returnArtifactId.value = sourceArtifactId && surface !== "artifact" ? sourceArtifactId : null;
}

function applyNavigation(surface: Surface, targetId?: string, focusId?: string | null): void {
  const normalizedTargetId = normalizeTargetId(surface, targetId ?? defaultTargetId(surface), props.snapshot);
  activeSurface.value = surface;
  activeTargetId.value = normalizedTargetId;
  activeFocusId.value = focusId ?? null;
  const nextPanel = panelForTarget(surface, normalizedTargetId, props.snapshot);
  panelMode.value = nextPanel.panelMode;
  panelId.value = nextPanel.panelId;
}

function returnToArtifact(): void {
  if (!returnArtifactId.value) {
    return;
  }

  navigate("artifact", returnArtifactId.value);
}

function dismissReturnArtifact(): void {
  returnArtifactId.value = null;
}

function toggleInspector(): void {
  if (!inspectorAvailable.value) {
    return;
  }

  inspectorOpen.value = !inspectorOpen.value;
}

function closeInspector(): void {
  inspectorOpen.value = false;
}

function defaultTargetId(surface: Surface): string {
  if (surface === "rooms") {
    return activeProject.value.roomIds[0] ?? props.snapshot.rooms[0]?.id ?? "";
  }
  if (surface === "projects") {
    return activeProject.value.id;
  }
  if (surface === "work") {
    return activeProject.value.cards[0]?.id ?? props.snapshot.projects[0]?.cards[0]?.id ?? "";
  }
  if (surface === "artifact") {
    return activeProject.value.artifactIds.at(-1) ?? props.snapshot.artifacts[0]?.id ?? "";
  }
  if (surface === "diff") {
    return activeWorkCard.value?.patchSetIds[0] ?? props.snapshot.patchSets[0]?.id ?? "";
  }
  if (surface === "agents") {
    return activeProject.value.agentIds[0] ?? props.snapshot.agents[0]?.id ?? "";
  }
  if (surface === "observe") {
    return props.snapshot.observe.traceGroups.find((trace) => trace.linkedProjectId === activeProject.value.id)?.id ?? props.snapshot.observe.traceGroups[0]?.id ?? "";
  }
  return "settings";
}

function readRouteState(snapshot: DeskSnapshot): RouteState {
  const fallbackSurface: Surface = "rooms";
  const stored = readStoredRouteState();
  const params = typeof window === "undefined" ? new URLSearchParams() : new URLSearchParams(window.location.search);
  const surface = coerceSurface(params.get("surface") ?? stored?.surface, fallbackSurface);
  const targetId = normalizeTargetId(surface, params.get("target") ?? stored?.targetId ?? firstTargetId(surface, snapshot), snapshot);
  const panel = panelForTarget(surface, targetId, snapshot);
  const requestedPanelMode = coercePanelMode(params.get("panel") ?? stored?.panelMode, panel.panelMode);
  const requestedPanelId = params.get("panelId") ?? stored?.panelId ?? panel.panelId;
  const focusId = params.get("focus") ?? stored?.focusId ?? null;
  const returnArtifactId = normalizeReturnArtifactId(params.get("returnArtifact") ?? stored?.returnArtifactId ?? null, surface, snapshot);
  const normalizedPanel = normalizePanelState(surface, targetId, requestedPanelMode, requestedPanelId, snapshot);
  return {
    surface,
    targetId,
    panelMode: normalizedPanel.panelMode,
    panelId: normalizedPanel.panelId,
    focusId,
    returnArtifactId,
  };
}

function readStoredRouteState(): Partial<RouteState> | null {
  if (typeof window === "undefined") {
    return null;
  }

  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem("kairos-desk-ui.route");
  } catch {
    return null;
  }

  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw) as Partial<RouteState>;
  } catch {
    return null;
  }
}

function persistRouteState(state: RouteState): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem("kairos-desk-ui.route", JSON.stringify(state));
  } catch {
    // Storage can be blocked in private or restricted browser contexts. URL state remains authoritative.
  }

  try {
    const params = new URLSearchParams(window.location.search);
    params.set("surface", state.surface);
    params.set("target", state.targetId);
    params.set("panel", state.panelMode);
    params.set("panelId", state.panelId);
    if (state.focusId) {
      params.set("focus", state.focusId);
    } else {
      params.delete("focus");
    }
    if (state.returnArtifactId && state.surface !== "artifact") {
      params.set("returnArtifact", state.returnArtifactId);
    } else {
      params.delete("returnArtifact");
    }
    const nextUrl = `${window.location.pathname}?${params.toString()}${window.location.hash}`;
    window.history.replaceState(null, "", nextUrl);
  } catch {
    // Ignore history failures in nonstandard embedded browsers.
  }
}

function normalizeReturnArtifactId(value: string | null, surface: Surface, snapshot: DeskSnapshot): string | null {
  if (!value || surface === "artifact") {
    return null;
  }

  return snapshot.artifacts.some((artifact) => artifact.id === value) ? value : null;
}

function coerceSurface(value: string | undefined | null, fallback: Surface): Surface {
  if (value === "rooms" || value === "projects" || value === "work" || value === "artifact" || value === "diff" || value === "agents" || value === "observe" || value === "settings") {
    return value;
  }
  return fallback;
}

function coercePanelMode(value: string | undefined | null, fallback: InspectorProjection["mode"]): InspectorProjection["mode"] {
  if (value === "decision" || value === "artifact" || value === "work-card" || value === "trace" || value === "room-info") {
    return value;
  }
  return fallback;
}

function firstTargetId(surface: Surface, snapshot: DeskSnapshot): string {
  if (surface === "rooms") {
    return snapshot.rooms[0]?.id ?? "";
  }
  if (surface === "projects") {
    return snapshot.projects[0]?.id ?? "";
  }
  if (surface === "work") {
    return snapshot.projects[0]?.cards[0]?.id ?? "";
  }
  if (surface === "artifact") {
    return snapshot.artifacts[0]?.id ?? "";
  }
  if (surface === "diff") {
    return snapshot.patchSets[0]?.id ?? "";
  }
  if (surface === "agents") {
    return snapshot.agents[0]?.id ?? "";
  }
  if (surface === "observe") {
    return snapshot.observe.traceGroups[0]?.id ?? "";
  }
  return "settings";
}

function panelForTarget(surface: Surface, targetId: string, snapshot: DeskSnapshot): Pick<RouteState, "panelMode" | "panelId"> {
  if (surface === "artifact") {
    return { panelMode: "artifact", panelId: targetId || snapshot.artifacts[0]?.id || "" };
  }
  if (surface === "diff") {
    const patchSet = snapshot.patchSets.find((patch) => patch.id === targetId) ?? snapshot.patchSets[0];
    return { panelMode: "work-card", panelId: patchSet?.workCardId ?? snapshot.projects[0]?.cards[0]?.id ?? "" };
  }
  if (surface === "observe") {
    return { panelMode: "trace", panelId: targetId || snapshot.observe.traceGroups[0]?.id || "" };
  }
  if (surface === "work") {
    return { panelMode: "work-card", panelId: targetId || snapshot.projects[0]?.cards[0]?.id || "" };
  }
  if (targetId.startsWith("card-")) {
    return { panelMode: "work-card", panelId: targetId };
  }
  if (surface === "projects") {
    const project = projectForTarget(snapshot, targetId) ?? snapshot.projects[0];
    const card = project?.cards.find((candidate) => candidate.status === "needs-human") ?? project?.cards[0];
    return { panelMode: card?.id === "card-shape-decision" ? "decision" : "work-card", panelId: card?.id ?? targetId };
  }
  if (surface === "rooms") {
    return { panelMode: snapshot.inspector.mode, panelId: snapshot.inspector.decisionId ?? snapshot.inspector.cardId ?? targetId };
  }
  return { panelMode: "room-info", panelId: targetId };
}

function normalizeTargetId(surface: Surface, targetId: string, snapshot: DeskSnapshot): string {
  if (surface === "rooms" && snapshot.rooms.some((room) => room.id === targetId)) {
    return targetId;
  }
  if (surface === "projects" && snapshot.projects.some((project) => project.id === targetId || project.cards.some((card) => card.id === targetId))) {
    return targetId;
  }
  if (surface === "work" && snapshot.projects.some((project) => project.cards.some((card) => card.id === targetId))) {
    return targetId;
  }
  if (surface === "artifact" && snapshot.artifacts.some((artifact) => artifact.id === targetId)) {
    return targetId;
  }
  if (surface === "diff" && snapshot.patchSets.some((patchSet) => patchSet.id === targetId)) {
    return targetId;
  }
  if (surface === "agents" && snapshot.agents.some((agent) => agent.id === targetId)) {
    return targetId;
  }
  if (surface === "observe" && (snapshot.observe.traceGroups.some((trace) => trace.id === targetId) || snapshot.observe.endpointHealth.some((endpoint) => endpoint.id === targetId))) {
    return targetId;
  }
  return firstTargetId(surface, snapshot);
}

function normalizePanelState(
  surface: Surface,
  targetId: string,
  mode: InspectorProjection["mode"],
  panelId: string,
  snapshot: DeskSnapshot,
): Pick<RouteState, "panelMode" | "panelId"> {
  if (isCompatiblePanel(surface, mode) && isValidPanelId(mode, panelId, snapshot, targetId)) {
    return { panelMode: mode, panelId };
  }

  return panelForTarget(surface, targetId, snapshot);
}

function isCompatiblePanel(surface: Surface, mode: InspectorProjection["mode"]): boolean {
  if (surface === "artifact") {
    return mode === "artifact";
  }
  if (surface === "diff") {
    return mode === "work-card";
  }
  if (surface === "work") {
    return mode === "work-card";
  }
  if (surface === "observe") {
    return mode === "trace";
  }
  if (surface === "agents" || surface === "settings") {
    return mode === "room-info";
  }
  return mode === "decision" || mode === "work-card" || mode === "artifact" || mode === "trace" || mode === "room-info";
}

function isValidPanelId(mode: InspectorProjection["mode"], panelId: string, snapshot: DeskSnapshot, targetId: string): boolean {
  if (mode === "artifact") {
    return snapshot.artifacts.some((artifact) => artifact.id === panelId);
  }
  if (mode === "trace") {
    return snapshot.observe.traceGroups.some((trace) => trace.id === panelId);
  }
  if (mode === "work-card") {
    return snapshot.projects.some((project) => project.cards.some((card) => card.id === panelId));
  }
  if (mode === "decision") {
    return snapshot.rooms.some((room) => room.messages.some((message) => message.projections.some((projection) => projection.kind === "decision" && (projection.id === panelId || projection.cardId === panelId))));
  }
  return Boolean(targetId);
}

function projectForTarget(snapshot: DeskSnapshot, targetId: string) {
  const directProject = snapshot.projects.find((project) => project.id === targetId || project.cards.some((card) => card.id === targetId));
  if (directProject) return directProject;

  const artifactProjectId = snapshot.artifacts.find((artifact) => artifact.id === targetId)?.projectId;
  if (artifactProjectId) return snapshot.projects.find((project) => project.id === artifactProjectId) ?? null;

  const patchProjectId = snapshot.patchSets.find((patchSet) => patchSet.id === targetId)?.projectId;
  if (patchProjectId) return snapshot.projects.find((project) => project.id === patchProjectId) ?? null;

  const traceProjectId = snapshot.observe.traceGroups.find((trace) => trace.id === targetId)?.linkedProjectId;
  if (traceProjectId) return snapshot.projects.find((project) => project.id === traceProjectId) ?? null;

  const agentProjectId = snapshot.agents.find((agent) => agent.id === targetId)?.linkedProjectId;
  if (agentProjectId) return snapshot.projects.find((project) => project.id === agentProjectId) ?? null;

  const roomProjectId = snapshot.rooms.find((room) => room.id === targetId)?.projectIds[0];
  if (roomProjectId) return snapshot.projects.find((project) => project.id === roomProjectId) ?? null;

  return null;
}

function cardForTarget(snapshot: DeskSnapshot, targetId: string) {
  const patchCardId = snapshot.patchSets.find((patchSet) => patchSet.id === targetId)?.workCardId;
  const normalizedTargetId = patchCardId ?? targetId;
  for (const project of snapshot.projects) {
    const card = project.cards.find((candidate) => candidate.id === normalizedTargetId);
    if (card) {
      return card;
    }
  }
  return null;
}
</script>

<template>
  <div class="desk-shell" :class="{ 'inspector-open': inspectorVisible, 'artifact-reader-mode': activeSurface === 'artifact', 'diff-reader-mode': activeSurface === 'diff' }">
    <header class="topbar">
      <button class="brand-mark" type="button" aria-label="Kairos Desk">K</button>
      <div class="workspace-menu">
        <span>{{ snapshot.workspace.name }}</span>
        <ChevronDown :size="15" aria-hidden="true" />
      </div>
      <div class="global-search" role="search">
        <Search :size="14" aria-hidden="true" />
        <span>Search rooms, projects, artifacts, traces</span>
      </div>
      <div class="runtime-health" :title="snapshot.workspace.health.detail">
        <span class="health-dot" />
        <span>{{ snapshot.workspace.health.label }}</span>
      </div>
    </header>

    <WorkspaceRail :active-surface="activeSurface" @navigate="navigate" />
    <DeskSidebar :active-surface="activeSurface" :active-target-id="activeTargetId" :active-project-id="activeProject.id" :nav="snapshot.nav" @navigate="navigate" />

    <main class="main-surface">
      <DeskHeader
        :active-surface="activeSurface"
        :room="activeRoom"
        :project="activeProject"
        :work-card="activeWorkCard"
        :artifact-target-id="activeProjectArtifactTargetId"
        :inspector-open="inspectorVisible"
        :inspector-available="inspectorAvailable"
        @navigate="navigate"
        @toggle-inspector="toggleInspector"
      />

      <RoomPage v-if="activeSurface === 'rooms'" :room="activeRoom" :project="activeProject" :highlighted-message-id="activeFocusId" @navigate="navigate" />
      <ProjectsDashboard v-else-if="activeSurface === 'projects'" :projects="snapshot.projects" :active-project="activeProject" :artifacts="snapshot.artifacts" @navigate="navigate" />
      <WorkDetailPage
        v-else-if="activeSurface === 'work' && activeWorkCard"
        :project="activeProject"
        :card="activeWorkCard"
        :artifacts="snapshot.artifacts"
        :patch-sets="snapshot.patchSets"
        :observe="snapshot.observe"
        @navigate="navigate"
      />
      <ArtifactReader v-else-if="activeSurface === 'artifact'" :artifact="activeArtifact" @navigate="navigateFromSourceRef" />
      <DiffReader v-else-if="activeSurface === 'diff' && activePatchSet" :patch-set="activePatchSet" :active-file-id="activeFocusId" @navigate="navigate" />
      <AgentsPage v-else-if="activeSurface === 'agents'" :agents="snapshot.agents" :project="activeProject" />
      <ObservePage v-else-if="activeSurface === 'observe'" :observe="snapshot.observe" :project="activeProject" :active-target-id="activeTargetId" @navigate="navigate" />
      <div v-else class="content-scroll">
        <div class="settings-page">
          <div class="empty-state">Settings will own local workspace preferences, runtime endpoints, and UI defaults.</div>
        </div>
      </div>
    </main>

    <RightInspector
      v-if="inspectorVisible"
      :snapshot="snapshot"
      :active-surface="activeSurface"
      :active-target-id="activeTargetId"
      :panel-mode="panelMode"
      :panel-id="panelId"
      @navigate="navigate"
      @close="closeInspector"
    />

    <aside v-if="returnArtifact" class="artifact-return-card" aria-label="Return to artifact reader">
      <div>
        <div class="kicker">Source ref opened</div>
        <strong>{{ returnArtifact.title }}</strong>
      </div>
      <div class="artifact-return-actions">
        <button class="secondary-button" type="button" @click="returnToArtifact">Back to artifact</button>
        <button class="icon-button" type="button" aria-label="Dismiss artifact return" @click="dismissReturnArtifact"><X :size="14" aria-hidden="true" /></button>
      </div>
    </aside>
  </div>
</template>
