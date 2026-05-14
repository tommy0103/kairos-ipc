<script setup lang="ts">
import { computed } from "vue";
import type { AgentProjection, ProjectProjection } from "@/api/types";

const props = defineProps<{
  agents: AgentProjection[];
  project: ProjectProjection;
}>();

const projectAgents = computed(() => props.agents.filter((agent) => props.project.agentIds.includes(agent.id) || agent.linkedProjectId === props.project.id));

function formatLabel(value: string): string {
  return value.replaceAll("-", " ");
}

function stateTone(state: AgentProjection["state"]): string {
  if (state === "blocked") return "bad";
  if (state === "waiting") return "warn";
  if (state === "running") return "success";
  return "";
}

function capabilitySummary(capabilities: string[]): string {
  if (capabilities.length === 0) return "No declared capabilities";
  return capabilities.join(", ");
}
</script>

<template>
  <div class="content-scroll">
    <div class="agents-page">
      <div class="lens-header">
        <div>
          <h1 class="dashboard-title">Agents</h1>
          <div class="dashboard-subtitle">Assigned responsibilities, latest reports, blockers, and capabilities.</div>
        </div>
      </div>

      <section class="agent-grid" aria-label="Agent actor lens">
        <article v-for="agent in projectAgents" :key="agent.id" class="agent-card">
          <div class="agent-card-header">
            <div>
              <div class="kicker">{{ agent.role }}</div>
              <h3>@{{ agent.name }}</h3>
            </div>
            <div class="agent-state" :class="stateTone(agent.state)">
              <span class="agent-state-dot" aria-hidden="true" />
              <span>{{ formatLabel(agent.state) }}</span>
            </div>
          </div>
          <p>{{ agent.currentDelegation }}</p>
          <div class="mini-grid">
            <div class="mini-cell">
              <div class="mini-label">Health</div>
              <div class="mini-value">{{ agent.healthLabel }}</div>
            </div>
            <div class="mini-cell">
              <div class="mini-label">Artifacts</div>
              <div class="mini-value">{{ agent.recentArtifactIds.length }} recent</div>
            </div>
          </div>
          <p>{{ agent.latestReport }}</p>
          <div v-if="agent.latestIpcAction" class="status-line">
            <strong>@{{ agent.name }}</strong>
            <span>{{ agent.latestIpcAction.endpoint }}</span>
            <code>{{ agent.latestIpcAction.action }} {{ agent.latestIpcAction.argsPreview }}</code>
          </div>
          <div v-if="agent.blockers.length > 0" class="agent-blockers">
            <div class="agent-section-label">Blocked by</div>
            <ul>
              <li v-for="blocker in agent.blockers" :key="blocker">{{ blocker }}</li>
            </ul>
          </div>
          <div class="capability-list">
            <span class="agent-section-label">Can use</span>
            <span>{{ capabilitySummary(agent.capabilities) }}</span>
          </div>
        </article>
        <div v-if="projectAgents.length === 0" class="compact-empty">No agents are assigned to this work yet.</div>
      </section>
    </div>
  </div>
</template>
