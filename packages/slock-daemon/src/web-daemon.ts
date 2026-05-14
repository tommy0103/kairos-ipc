import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { getModel, type Api, type Model } from "@mariozechner/pi-ai";
import { createMockAgent } from "../../agent-adapter-mock/src/index.ts";
import { createPiAgent, createPiSlockTools } from "../../agent-adapter-pi/src/index.ts";
import { createDifyBridge, type DifyBridge } from "../../dify-bridge/src/index.ts";
import { AllowAllCapabilityGate } from "../../kernel/src/capability.ts";
import type { Connection } from "../../kernel/src/registry.ts";
import { EndpointRegistry } from "../../kernel/src/registry.ts";
import { Router } from "../../kernel/src/router.ts";
import { TraceWriter } from "../../kernel/src/trace.ts";
import { createUnixNdjsonKernel } from "../../kernel/src/transport/unix-ndjson.ts";
import { createMattermostBridge, type MattermostBridge } from "../../mattermost-bridge/src/index.ts";
import { createBrowserPlugin, createCalculatorPlugin, createReMeMemoryPlugin, createShellPlugin, createWorkspacePlugin } from "../../plugins-demo/src/index.ts";
import type { ClientFrame, EndpointUri, KernelFrame } from "../../protocol/src/index.ts";
import type { IpcNode } from "../../sdk/src/index.ts";
import type { IpcTransport } from "../../sdk/src/transport.ts";
import { createSessionManager } from "../../session-manager/src/index.ts";
import { createSlockChannel, createSlockGrantStore } from "../../slock-channel/src/index.ts";
import { createSlockHuman } from "../../slock-human/src/index.ts";
import { createSlockUiBridge, type SlockUiBridge } from "../../slock-ui-bridge/src/index.ts";
import { resolveSlockWebDaemonConfig, type SlockWebAgentConfig, type SlockWebDaemonConfig } from "./config.ts";
import { createSlockRegistry, SLOCK_REGISTRY_URI, type SlockRegistryEndpoint } from "./registry-node.ts";

export interface SlockWebDaemon {
  config: SlockWebDaemonConfig;
  url?: string;
  dify_bridge_url?: string;
  mattermost_bridge_url?: string;
  socket_path: string;
  trace_path: string;
  ipc_address: string;
  registry_uri: string;
  session_manager_uri?: string;
  agent_uri: string;
  agent_uris: string[];
  channel_uri: string;
  channel_uris: string[];
  workspace_root: string;
  close(): Promise<void>;
}

export async function createSlockWebDaemon(config: SlockWebDaemonConfig = {}): Promise<SlockWebDaemon> {
  const resolved = resolveSlockWebDaemonConfig(config);
  const runtimeDir = resolved.runtime_dir ?? "/tmp";
  const dir = mkdtempSync(join(runtimeDir, "kairos-ipc-slock-web-"));
  const socketPath = join(dir, "kernel.sock");
  const tracePath = join(dir, "trace.jsonl");
  const ipcAddress = `unix://${socketPath}`;
  const channelConfigs = resolved.channels?.length
    ? resolved.channels
    : [{ uri: required(resolved.channel_uri, "channel_uri"), ...resolved.channel }];
  const channelUris = channelConfigs.map((channel) => required(channel.uri, "channels[].uri"));
  const channelUri = channelUris[0];
  const sessionManagerUri = resolved.collaboration?.enabled === false ? undefined : required(resolved.collaboration?.session_manager_uri, "collaboration.session_manager_uri");
  const humanUri = required(resolved.human_uri, "human_uri");
  const agentConfigs = resolved.agents?.length ? resolved.agents : [required(resolved.agent, "agent")];
  const agentUris = agentConfigs.map((agent) => required(agent.uri, "agents[].uri"));
  const agentUri = agentUris[0];
  const registryUri = SLOCK_REGISTRY_URI;
  const workspaceUri = required(resolved.plugins?.workspace?.uri, "plugins.workspace.uri");
  const shellUri = required(resolved.plugins?.shell?.uri, "plugins.shell.uri");
  const calculatorUri = required(resolved.plugins?.calculator?.uri, "plugins.calculator.uri");
  const browserUri = required(resolved.plugins?.browser?.uri, "plugins.browser.uri");
  const memoryUri = required(resolved.plugins?.memory?.uri, "plugins.memory.uri");
  const workspaceRoot = required(resolved.workspace_root, "workspace_root");
  const grantStore = createSlockGrantStore();
  const kernel = await createKernelRuntime(resolved.kernel?.transport ?? "unix", socketPath, tracePath);
  const connected: IpcNode[] = [];
  let uiBridge: SlockUiBridge | undefined;
  let difyBridge: DifyBridge | undefined;
  let mattermostBridge: MattermostBridge | undefined;

  try {
    const human = createSlockHuman({
      uri: humanUri,
      grant_store: grantStore,
      ...(resolved.approval?.auto_approve
        ? { auto_approval: async () => ({ approved: true, grant_ttl_ms: resolved.approval?.grant_ttl_ms ?? 60000 }) }
        : {}),
    });
    const channels = channelConfigs.map((channel) => createSlockChannel({
      uri: channel.uri,
      mention_aliases: channel.mention_aliases,
      default_mentions: channel.default_mentions,
      history_limit: channel.history_limit,
      session_manager_uri: sessionManagerUri,
    }));
    const sessionManager = sessionManagerUri
      ? createSessionManager({
        uri: sessionManagerUri,
        default_agent_ttl_ms: resolved.collaboration?.default_agent_ttl_ms,
        coordinator_uri: resolved.collaboration?.coordinator_uri,
        agent_event_channel_uri: channelUri,
      })
      : undefined;
    const agents = agentConfigs.map((agent) => createDaemonAgent(agent, resolved, registryUri, workspaceUri, shellUri, calculatorUri, browserUri, memoryUri, sessionManagerUri));
    const registry = createSlockRegistry({
      uri: registryUri,
      endpoints: registryEndpoints(
        resolved,
        humanUri,
        resolved.ui_uri,
        sessionManagerUri,
        resolved.mattermost_bridge?.enabled ? "app://kairos/mattermost-bridge" : undefined,
        channelConfigs,
        agentConfigs,
        workspaceUri,
        shellUri,
        calculatorUri,
        browserUri,
        memoryUri,
      ),
    });

    uiBridge = createSlockUiBridge({
      uri: resolved.ui_uri,
      channel_uri: channelUri,
      channels: channelConfigs.map((channel) => ({
        uri: channel.uri,
        label: channel.label,
        kind: channel.kind,
      })),
      session_manager_uri: sessionManagerUri,
      human_node: human.node,
      human_endpoint: human,
      trace_path: tracePath,
    });

    if (resolved.dify_bridge?.enabled) {
      if (!sessionManagerUri) {
        throw new Error("Dify bridge requires collaboration.enabled and collaboration.session_manager_uri");
      }
      difyBridge = createDifyBridge({
        human_node: human.node,
        human_endpoint: human,
        session_manager_uri: sessionManagerUri,
        trace_path: tracePath,
        auth_token: resolved.dify_bridge.auth_token,
        allow_unauthenticated: resolved.dify_bridge.allow_unauthenticated,
        allowed_origins: resolved.dify_bridge.allowed_origins,
        max_body_bytes: resolved.dify_bridge.max_body_bytes,
      });
    }

    if (resolved.mattermost_bridge?.enabled) {
      if (!sessionManagerUri) {
        throw new Error("Mattermost bridge requires collaboration.enabled and collaboration.session_manager_uri");
      }
      mattermostBridge = createMattermostBridge({
        human_node: human.node,
        session_manager_uri: sessionManagerUri,
        trace_path: tracePath,
        mattermost_base_url: required(resolved.mattermost_bridge.mattermost_base_url, "mattermost_bridge.mattermost_base_url"),
        bot_token: required(resolved.mattermost_bridge.bot_token, "mattermost_bridge.bot_token"),
        slash_command_token: resolved.mattermost_bridge.slash_command_token,
        allowed_team_ids: resolved.mattermost_bridge.allowed_team_ids,
        allowed_user_ids: resolved.mattermost_bridge.allowed_user_ids,
        allowed_origins: resolved.mattermost_bridge.allowed_origins,
        require_origin: resolved.mattermost_bridge.require_origin,
        bridge_public_url: resolved.mattermost_bridge.public_url,
        max_body_bytes: resolved.mattermost_bridge.max_body_bytes,
        mattermost_request_timeout_ms: resolved.mattermost_bridge.mattermost_request_timeout_ms,
        callback_token_ttl_ms: resolved.mattermost_bridge.callback_token_ttl_ms,
        max_projection_posts: resolved.mattermost_bridge.max_projection_posts,
        allowed_agent_uris: resolved.mattermost_bridge.allowed_agent_uris,
        default_agents: resolved.mattermost_bridge.default_agents,
        agent_aliases: resolved.mattermost_bridge.agent_aliases,
      });
    }

    const nodes: IpcNode[] = [
      registry.node,
      human.node,
      uiBridge.node,
      ...(difyBridge ? [difyBridge.node] : []),
      ...(mattermostBridge ? [mattermostBridge.node] : []),
      ...(sessionManager ? [sessionManager.node] : []),
      ...channels.map((channel) => channel.node),
      ...agents.map((agent) => agent.node),
    ];
    if (resolved.plugins?.workspace?.enabled) {
      nodes.push(createWorkspacePlugin({
        uri: workspaceUri,
        root: resolved.plugins.workspace.root ?? workspaceRoot,
        max_read_bytes: resolved.plugins.workspace.max_read_bytes,
        grant_store: grantStore,
      }).node);
    }
    if (resolved.plugins?.shell?.enabled) {
      nodes.push(createShellPlugin({
        uri: shellUri,
        cwd: workspaceRoot,
        allowed_commands: resolved.plugins.shell.allowed_commands,
        timeout_ms: resolved.plugins.shell.timeout_ms,
        max_buffer_bytes: resolved.plugins.shell.max_buffer_bytes,
        grant_store: grantStore,
      }).node);
    }
    if (resolved.plugins?.calculator?.enabled) {
      nodes.push(createCalculatorPlugin({ uri: calculatorUri }).node);
    }
    if (resolved.plugins?.browser?.enabled) {
      nodes.push(createBrowserPlugin({
        uri: browserUri,
        allowed_origins: resolved.plugins.browser.allowed_origins,
        timeout_ms: resolved.plugins.browser.timeout_ms,
        max_read_bytes: resolved.plugins.browser.max_read_bytes,
        user_agent: resolved.plugins.browser.user_agent,
      }).node);
    }
    if (resolved.plugins?.memory?.enabled) {
      nodes.push(createReMeMemoryPlugin({
        uri: memoryUri,
        provider: resolved.plugins.memory.provider,
        base_url: required(resolved.plugins.memory.base_url, "plugins.memory.base_url"),
        workspace_id: resolved.plugins.memory.workspace_id,
        timeout_ms: resolved.plugins.memory.timeout_ms,
        grant_store: grantStore,
      }).node);
    }

    for (const node of nodes) {
      await node.connect(kernel.connectAddress(`daemon_${connected.length + 1}`));
      connected.push(node);
    }

    for (const uri of channelUris) {
      await human.node.call(uri, "subscribe", {
        mime_type: "application/json",
        data: {},
      });
    }

    const listenResult = resolved.listen === false
      ? undefined
      : await uiBridge.listen({ host: resolved.host, port: resolved.port ?? 5173 });
    const difyListenResult = difyBridge
      ? await difyBridge.listen({ host: resolved.dify_bridge?.host, port: resolved.dify_bridge?.port ?? 5180 })
      : undefined;
    const mattermostListenResult = mattermostBridge
      ? await mattermostBridge.listen({ host: resolved.mattermost_bridge?.host, port: resolved.mattermost_bridge?.port ?? 5190 })
      : undefined;
    return {
      config: resolved,
      url: listenResult?.url,
      dify_bridge_url: difyListenResult?.url,
      mattermost_bridge_url: mattermostListenResult?.url,
      socket_path: socketPath,
      trace_path: tracePath,
      ipc_address: ipcAddress,
      registry_uri: registryUri,
      session_manager_uri: sessionManagerUri,
      agent_uri: agentUri,
      agent_uris: agentUris,
      channel_uri: channelUri,
      channel_uris: channelUris,
      workspace_root: workspaceRoot,
      close: () => closeDaemon(uiBridge, difyBridge, mattermostBridge, connected, kernel),
    };
  } catch (error) {
    await closeDaemon(uiBridge, difyBridge, mattermostBridge, connected, kernel);
    throw error;
  }
}

export function createSlockWebDaemonRegistryEndpoints(config: SlockWebDaemonConfig = {}): SlockRegistryEndpoint[] {
  const resolved = resolveSlockWebDaemonConfig(config);
  const channelConfigs = resolved.channels?.length
    ? resolved.channels
    : [{ uri: required(resolved.channel_uri, "channel_uri"), ...resolved.channel }];
  const sessionManagerUri = resolved.collaboration?.enabled === false ? undefined : required(resolved.collaboration?.session_manager_uri, "collaboration.session_manager_uri");
  const humanUri = required(resolved.human_uri, "human_uri");
  const agentConfigs = resolved.agents?.length ? resolved.agents : [required(resolved.agent, "agent")];
  const workspaceUri = required(resolved.plugins?.workspace?.uri, "plugins.workspace.uri");
  const shellUri = required(resolved.plugins?.shell?.uri, "plugins.shell.uri");
  const calculatorUri = required(resolved.plugins?.calculator?.uri, "plugins.calculator.uri");
  const browserUri = required(resolved.plugins?.browser?.uri, "plugins.browser.uri");
  const memoryUri = required(resolved.plugins?.memory?.uri, "plugins.memory.uri");
  return registryEndpoints(
    resolved,
    humanUri,
    resolved.ui_uri,
    sessionManagerUri,
    resolved.mattermost_bridge?.enabled ? "app://kairos/mattermost-bridge" : undefined,
    channelConfigs,
    agentConfigs,
    workspaceUri,
    shellUri,
    calculatorUri,
    browserUri,
    memoryUri,
  );
}

interface KernelRuntime {
  close(): Promise<void>;
  connectAddress(id: string): string | IpcTransport;
}

async function createKernelRuntime(transport: "unix" | "memory", socketPath: string, tracePath: string): Promise<KernelRuntime> {
  if (transport === "unix") {
    const kernel = await createUnixNdjsonKernel({ socketPath, tracePath });
    return {
      close: () => kernel.close(),
      connectAddress: () => `unix://${socketPath}`,
    };
  }

  return createMemoryKernelRuntime(tracePath);
}

async function closeDaemon(
  uiBridge: SlockUiBridge | undefined,
  difyBridge: DifyBridge | undefined,
  mattermostBridge: MattermostBridge | undefined,
  nodes: IpcNode[],
  kernel: KernelRuntime,
): Promise<void> {
  if (mattermostBridge) {
    await mattermostBridge.close().catch(() => undefined);
  }

  if (difyBridge) {
    await difyBridge.close().catch(() => undefined);
  }

  if (uiBridge) {
    await uiBridge.close().catch(() => undefined);
  }

  for (const node of [...nodes].reverse()) {
    if ((uiBridge && node === uiBridge.node) || (difyBridge && node === difyBridge.node) || (mattermostBridge && node === mattermostBridge.node)) {
      continue;
    }
    await node.close().catch(() => undefined);
  }

  await kernel.close().catch(() => undefined);
}

function createDaemonAgent(
  agent: SlockWebAgentConfig,
  config: SlockWebDaemonConfig,
  registryUri: string,
  workspaceUri: string,
  shellUri: string,
  calculatorUri: string,
  browserUri: string,
  memoryUri: string,
  sessionManagerUri?: EndpointUri,
): { node: IpcNode } {
  const uri = required(agent.uri, "agents[].uri");
  if (agent.mode === "mock") {
    return createMockAgent({ uri, calculator_uri: calculatorUri, shell_uri: shellUri });
  }

  return createPiAgent({
    uri,
    model: resolvePiModel(agent),
    api_key: agent.api_key,
    api_key_env: agent.api_key_env,
    base_url: agent.base_url,
    base_url_env: agent.base_url_env,
    headers: agent.headers,
    system_prompt: agent.system_prompt,
    context_history_limit: agent.context_history_limit,
    context_history_scope: agent.context_history_scope,
    memory: memoryContextConfig(config, memoryUri),
    ...createPiSlockTools({
      registry_uri: registryUri,
      workspace_uri: workspaceUri,
      shell_uri: shellUri,
      memory_uri: memoryUri,
      ipc_call_targets: [registryUri, ...enabledPluginUris(config, workspaceUri, shellUri, calculatorUri, browserUri, memoryUri), ...(sessionManagerUri ? [sessionManagerUri] : [])],
    }),
  });
}

function resolvePiModel(agent: SlockWebAgentConfig): Model<Api> {
  const provider = agent.provider ?? "openai";
  const model = agent.model ?? "gpt-4o-mini";
  const resolved = getModel(provider as never, model as never) as Model<Api> | undefined;
  if (!resolved) {
    throw new Error(`unknown pi-ai model: provider=${provider} model=${model}`);
  }
  return agent.api ? { ...resolved, api: agent.api as Api } : resolved;
}

function enabledPluginUris(
  config: SlockWebDaemonConfig,
  workspaceUri: string,
  shellUri: string,
  calculatorUri: string,
  browserUri: string,
  memoryUri: string,
): string[] {
  return [
    config.plugins?.workspace?.enabled ? workspaceUri : undefined,
    config.plugins?.shell?.enabled ? shellUri : undefined,
    config.plugins?.calculator?.enabled ? calculatorUri : undefined,
    config.plugins?.browser?.enabled ? browserUri : undefined,
    config.plugins?.memory?.enabled ? memoryUri : undefined,
  ].filter((uri): uri is string => Boolean(uri));
}

function registryEndpoints(
  config: SlockWebDaemonConfig,
  humanUri: string,
  uiUri: string | undefined,
  sessionManagerUri: EndpointUri | undefined,
  mattermostBridgeUri: EndpointUri | undefined,
  channels: Array<{ uri: string; label?: string; kind?: string }>,
  agents: SlockWebAgentConfig[],
  workspaceUri: string,
  shellUri: string,
  calculatorUri: string,
  browserUri: string,
  memoryUri: string,
): SlockRegistryEndpoint[] {
  return [
    config.plugins?.workspace?.enabled
      ? {
        uri: workspaceUri,
        kind: "plugin",
        label: "workspace",
        description: "Workspace file discovery, reads, and approved writes.",
      }
      : undefined,
    config.plugins?.shell?.enabled
      ? {
        uri: shellUri,
        kind: "plugin",
        label: "shell",
        description: "Approved local shell execution.",
      }
      : undefined,
    config.plugins?.calculator?.enabled
      ? {
        uri: calculatorUri,
        kind: "plugin",
        label: "calculator",
        description: "Demo calculator plugin.",
      }
      : undefined,
    config.plugins?.browser?.enabled
      ? {
        uri: browserUri,
        kind: "plugin",
        label: "browser",
        description: "Read-only browser/page inspection for allowlisted HTTP(S) origins.",
      }
      : undefined,
    config.plugins?.memory?.enabled
      ? {
        uri: memoryUri,
        kind: "plugin",
        label: "memory",
        description: "Long-term memory backed by the configured provider.",
      }
      : undefined,
    { uri: humanUri, kind: "human", label: "human", internal: true },
    uiUri ? { uri: uiUri, kind: "app", label: "Slock UI", internal: true } : undefined,
    sessionManagerUri
      ? {
        uri: sessionManagerUri,
        kind: "app",
        label: "collaboration session manager",
        description: "Owns collaboration sessions, delegations, artifacts, barriers, short agent reports, and agent context rendering.",
      }
      : undefined,
    mattermostBridgeUri
      ? {
        uri: mattermostBridgeUri,
        kind: "app",
        label: "Mattermost bridge",
        description: "Mattermost slash command, interactive action, dialog, and projection bridge.",
        internal: true,
      }
      : undefined,
    ...channels.map((channel) => ({
      uri: channel.uri,
      kind: "channel" as const,
      label: channel.label ?? channel.kind ?? "channel",
      internal: true,
    })),
    ...agents.map((agent) => ({
      uri: required(agent.uri, "agents[].uri"),
      kind: "agent" as const,
      label: agent.mode ?? "agent",
      internal: true,
    })),
  ].filter((endpoint): endpoint is SlockRegistryEndpoint => Boolean(endpoint));
}

function memoryContextConfig(config: SlockWebDaemonConfig, memoryUri: string) {
  const memory = config.plugins?.memory;
  if (!memory?.enabled || memory.inject_context === false) {
    return undefined;
  }

  return {
    enabled: true,
    uri: memoryUri,
    workspace_id: memory.workspace_id,
    inject_context: memory.inject_context,
    scopes: memory.scopes,
    top_k: memory.top_k,
    timeout_ms: memory.timeout_ms,
  };
}

function createMemoryKernelRuntime(tracePath: string): KernelRuntime {
  const registry = new EndpointRegistry();
  const trace = new TraceWriter(tracePath);
  const router = new Router({ registry, capabilityGate: new AllowAllCapabilityGate(), trace });

  return {
    async close() {
      // Memory transports unregister themselves when their nodes close.
    },
    connectAddress(id: string) {
      return new MemoryKernelTransport(id, registry, router, trace);
    },
  };
}

class MemoryKernelTransport implements IpcTransport {
  private readonly connection: Connection;
  private readonly registry: EndpointRegistry;
  private readonly router: Router;
  private readonly trace: TraceWriter;
  private readonly listeners = new Set<(frame: KernelFrame) => void>();
  private closed = false;

  constructor(id: string, registry: EndpointRegistry, router: Router, trace: TraceWriter) {
    this.registry = registry;
    this.router = router;
    this.trace = trace;
    this.connection = {
      id,
      send: (frame) => this.emit(frame),
    };
  }

  send(frame: ClientFrame): void {
    if (this.closed) {
      throw new Error(`transport is closed: ${this.connection.id}`);
    }

    if (frame.type === "register") {
      const result = this.registry.register(frame.uri, this.connection);
      if (!result.ok) {
        this.emit({ type: "error", error: { code: "REGISTER_FAILED", message: result.error ?? "register failed" } });
        return;
      }
      this.trace.recordEvent({ event: "endpoint_registered", uri: frame.uri, connection_id: this.connection.id });
      this.emit({ type: "registered", uri: frame.uri });
      return;
    }

    this.router.route(frame.envelope, this.connection);
  }

  onFrame(listener: (frame: KernelFrame) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    this.closed = true;
    const removed = this.registry.unregisterConnection(this.connection);
    for (const uri of removed) {
      this.trace.recordEvent({ event: "endpoint_unregistered", uri, connection_id: this.connection.id });
    }
  }

  private emit(frame: KernelFrame): void {
    for (const listener of this.listeners) {
      listener(frame);
    }
  }
}

function required<T>(value: T | undefined, name: string): T {
  if (value === undefined || value === null || value === "") {
    throw new Error(`Slock daemon config is missing ${name}`);
  }
  return value;
}
