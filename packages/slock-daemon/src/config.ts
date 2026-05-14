import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { EndpointUri } from "../../protocol/src/index.ts";
import type { MentionAliases } from "../../slock-channel/src/index.ts";

export type SlockWebAgentMode = "pi" | "mock";
export type SlockWebChannelKind = "channel" | "dm";
export type SlockMemoryProvider = "reme-http";
export type SlockMemoryScope = "personal" | "task" | "tool";

export interface SlockWebAgentConfig {
  mode?: SlockWebAgentMode;
  uri?: EndpointUri;
  provider?: string;
  model?: string;
  api?: string;
  api_key?: string;
  api_key_env?: string;
  base_url?: string;
  base_url_env?: string;
  headers?: Record<string, string>;
  system_prompt?: string;
  context_history_limit?: number;
  context_history_scope?: "channel" | "thread";
}

export interface SlockWebChannelConfig {
  uri: EndpointUri;
  label?: string;
  kind?: SlockWebChannelKind;
  mention_aliases?: MentionAliases;
  default_mentions?: EndpointUri[];
  history_limit?: number;
}

export interface SlockWebDaemonConfig {
  host?: string;
  port?: number;
  listen?: boolean;
  runtime_dir?: string;
  workspace_root?: string;
  channel_uri?: EndpointUri;
  channels?: SlockWebChannelConfig[];
  human_uri?: EndpointUri;
  human?: {
    user_id?: string;
    device_id?: string;
  };
  ui_uri?: EndpointUri;
  kernel?: {
    transport?: "unix" | "memory";
  };
  channel?: {
    mention_aliases?: MentionAliases;
    history_limit?: number;
  };
  collaboration?: {
    enabled?: boolean;
    session_manager_uri?: EndpointUri;
    default_agent_ttl_ms?: number;
    coordinator_uri?: EndpointUri;
  };
  dify_bridge?: {
    enabled?: boolean;
    host?: string;
    port?: number;
    auth_token?: string;
    auth_token_env?: string;
    allowed_origins?: string[];
    max_body_bytes?: number;
    allow_unauthenticated?: boolean;
  };
  mattermost_bridge?: {
    enabled?: boolean;
    host?: string;
    port?: number;
    public_url?: string;
    mattermost_base_url?: string;
    bot_token?: string;
    bot_token_env?: string;
    slash_command_token?: string;
    slash_command_token_env?: string;
    allowed_team_ids?: string[];
    allowed_user_ids?: string[];
    allowed_origins?: string[];
    require_origin?: boolean;
    max_body_bytes?: number;
    mattermost_request_timeout_ms?: number;
    callback_token_ttl_ms?: number;
    max_projection_posts?: number;
    allowed_agent_uris?: EndpointUri[];
    default_agents?: EndpointUri[];
    agent_aliases?: Record<string, EndpointUri | EndpointUri[]>;
  };
  agent?: SlockWebAgentConfig;
  agents?: SlockWebAgentConfig[];
  plugins?: {
    workspace?: {
      enabled?: boolean;
      uri?: EndpointUri;
      root?: string;
      max_read_bytes?: number;
    };
    shell?: {
      enabled?: boolean;
      uri?: EndpointUri;
      allowed_commands?: string[] | null;
      timeout_ms?: number;
      max_buffer_bytes?: number;
    };
    calculator?: {
      enabled?: boolean;
      uri?: EndpointUri;
    };
    browser?: {
      enabled?: boolean;
      uri?: EndpointUri;
      allowed_origins?: string[] | null;
      timeout_ms?: number;
      max_read_bytes?: number;
      user_agent?: string;
    };
    memory?: {
      enabled?: boolean;
      uri?: EndpointUri;
      provider?: SlockMemoryProvider;
      base_url?: string;
      base_url_env?: string;
      workspace_id?: string;
      inject_context?: boolean;
      scopes?: SlockMemoryScope[];
      top_k?: number;
      timeout_ms?: number;
    };
  };
  approval?: {
    auto_approve?: boolean;
    grant_ttl_ms?: number;
  };
}

export interface LoadSlockWebDaemonConfigOptions {
  argv?: string[];
  env?: Record<string, string | undefined>;
  cwd?: string;
}

export const DEFAULT_PI_SYSTEM_PROMPT = [
  "You are pi-assistant running behind Slock IPC.",
  "Use ipc_call for plugin actions: call slock://registry list_endpoints to discover mounted root endpoints, call the root manifest, call list_children when the manifest exposes deeper endpoints or namespaces, then call a child endpoint's manifest before child-specific actions.",
  "Do not set ipc_call timeout_ms or ttl_ms casually; leave them unset unless the user asks for a limit, the manifest requires it, or a previous default wait timed out.",
  "For repo/workspace questions, use ipc_call against plugin://local/workspace list/search/read before considering shell execution.",
  "For local web page inspection, use registry-discovered browser plugin read_page when it is configured.",
  "Workspace write/edit and shell exec are high-risk; ipc_call will request human approval before forwarding those actions.",
  "Keep final answers concise and mention which files or commands were used.",
].join("\n");

export function loadSlockWebDaemonConfig(options: LoadSlockWebDaemonConfigOptions = {}): SlockWebDaemonConfig {
  const argv = options.argv ?? process.argv.slice(2);
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const configPath = readOption(argv, "--config") ?? env.KAIROS_IPC_CONFIG;
  const fileConfig = configPath ? readSlockWebDaemonConfigFile(resolve(cwd, configPath)) : {};
  return resolveSlockWebDaemonConfig(mergeSlockWebDaemonConfig(fileConfig, configFromCliAndEnv(argv, env)), cwd, env);
}

export function readSlockWebDaemonConfigFile(path: string): Partial<SlockWebDaemonConfig> {
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(parsed)) {
    throw new Error("Slock daemon config must be a JSON object");
  }
  return parsed as Partial<SlockWebDaemonConfig>;
}

export function mergeSlockWebDaemonConfig(...configs: Array<Partial<SlockWebDaemonConfig> | undefined>): SlockWebDaemonConfig {
  let merged: Record<string, unknown> = {};
  for (const config of configs) {
    if (config) {
      merged = mergeRecord(merged, config as Record<string, unknown>);
    }
  }
  return merged as SlockWebDaemonConfig;
}

export function resolveSlockWebDaemonConfig(
  config: Partial<SlockWebDaemonConfig> = {},
  cwd = process.cwd(),
  env: Record<string, string | undefined> = process.env,
): SlockWebDaemonConfig {
  const agents = normalizeAgents(config);
  const primaryAgent = agents[0];
  const mode = primaryAgent.mode ?? "pi";
  const workspaceRoot = config.workspace_root ?? cwd;
  const workspaceUri = config.plugins?.workspace?.uri ?? "plugin://local/workspace";
  const shellUri = config.plugins?.shell?.uri ?? "plugin://local/shell";
  const calculatorUri = config.plugins?.calculator?.uri ?? "plugin://demo/calculator";
  const browserUri = config.plugins?.browser?.uri ?? "plugin://local/browser";
  const memoryUri = config.plugins?.memory?.uri ?? "plugin://memory/reme";
  const memoryBaseUrl = config.plugins?.memory?.base_url ?? readEnv(config.plugins?.memory?.base_url_env, env);
  const mentionAliases = config.channel?.mention_aliases ?? defaultMentionAliases(agents);
  const channels = normalizeChannels(config, mentionAliases);
  const channelUri = channels[0]?.uri ?? "app://slock/channel/general";
  const difyBridgeEnabled = config.dify_bridge?.enabled === true;
  const difyBridgeAuthToken = difyBridgeEnabled
    ? config.dify_bridge?.auth_token
      ?? readEnv(config.dify_bridge?.auth_token_env, env)
      ?? env.KAIROS_DIFY_BRIDGE_TOKEN
    : config.dify_bridge?.auth_token;
  const mattermostBridgeEnabled = config.mattermost_bridge?.enabled === true;
  const mattermostBotToken = mattermostBridgeEnabled
    ? config.mattermost_bridge?.bot_token
      ?? readEnv(config.mattermost_bridge?.bot_token_env, env)
      ?? env.KAIROS_MATTERMOST_BOT_TOKEN
    : config.mattermost_bridge?.bot_token;
  const mattermostSlashCommandToken = mattermostBridgeEnabled
    ? config.mattermost_bridge?.slash_command_token
      ?? readEnv(config.mattermost_bridge?.slash_command_token_env, env)
      ?? env.KAIROS_MATTERMOST_SLASH_TOKEN
    : config.mattermost_bridge?.slash_command_token;
  if (mattermostBridgeEnabled && !mattermostSlashCommandToken) {
    throw new Error("mattermost_bridge.slash_command_token is required when mattermost_bridge.enabled is true");
  }

  return {
    host: config.host ?? "127.0.0.1",
    port: config.port ?? 5173,
    listen: config.listen ?? true,
    runtime_dir: config.runtime_dir ?? "/tmp",
    workspace_root: workspaceRoot,
    channel_uri: channelUri,
    channels,
    human_uri: config.human_uri ?? defaultHumanUri(config.human),
    ui_uri: config.ui_uri ?? "app://slock/ui-bridge",
    kernel: {
      transport: config.kernel?.transport ?? "unix",
    },
    channel: {
      mention_aliases: mentionAliases,
      history_limit: config.channel?.history_limit,
    },
    collaboration: {
      enabled: config.collaboration?.enabled ?? true,
      session_manager_uri: config.collaboration?.session_manager_uri ?? "app://kairos/session-manager",
      default_agent_ttl_ms: config.collaboration?.default_agent_ttl_ms,
      coordinator_uri: config.collaboration?.coordinator_uri,
    },
    dify_bridge: {
      enabled: difyBridgeEnabled,
      host: config.dify_bridge?.host ?? "127.0.0.1",
      port: config.dify_bridge?.port ?? 5180,
      auth_token: difyBridgeAuthToken,
      auth_token_env: config.dify_bridge?.auth_token_env,
      allowed_origins: config.dify_bridge?.allowed_origins,
      max_body_bytes: config.dify_bridge?.max_body_bytes,
      allow_unauthenticated: config.dify_bridge?.allow_unauthenticated,
    },
    mattermost_bridge: {
      enabled: mattermostBridgeEnabled,
      host: config.mattermost_bridge?.host ?? "127.0.0.1",
      port: config.mattermost_bridge?.port ?? 5190,
      public_url: config.mattermost_bridge?.public_url,
      mattermost_base_url: config.mattermost_bridge?.mattermost_base_url,
      bot_token: mattermostBotToken,
      bot_token_env: config.mattermost_bridge?.bot_token_env,
      slash_command_token: mattermostSlashCommandToken,
      slash_command_token_env: config.mattermost_bridge?.slash_command_token_env,
      allowed_team_ids: config.mattermost_bridge?.allowed_team_ids,
      allowed_user_ids: config.mattermost_bridge?.allowed_user_ids,
      allowed_origins: config.mattermost_bridge?.allowed_origins,
      require_origin: config.mattermost_bridge?.require_origin,
      max_body_bytes: config.mattermost_bridge?.max_body_bytes,
      mattermost_request_timeout_ms: config.mattermost_bridge?.mattermost_request_timeout_ms,
      callback_token_ttl_ms: config.mattermost_bridge?.callback_token_ttl_ms,
      max_projection_posts: config.mattermost_bridge?.max_projection_posts,
      allowed_agent_uris: config.mattermost_bridge?.allowed_agent_uris,
      default_agents: config.mattermost_bridge?.default_agents,
      agent_aliases: config.mattermost_bridge?.agent_aliases,
    },
    agent: primaryAgent,
    agents,
    plugins: {
      workspace: {
        enabled: config.plugins?.workspace?.enabled ?? hasAgentMode(agents, "pi"),
        uri: workspaceUri,
        root: config.plugins?.workspace?.root ?? workspaceRoot,
        max_read_bytes: config.plugins?.workspace?.max_read_bytes,
      },
      shell: {
        enabled: config.plugins?.shell?.enabled ?? true,
        uri: shellUri,
        allowed_commands: config.plugins?.shell?.allowed_commands ?? (hasAgentMode(agents, "pi") ? null : ["pwd"]),
        timeout_ms: config.plugins?.shell?.timeout_ms,
        max_buffer_bytes: config.plugins?.shell?.max_buffer_bytes,
      },
      calculator: {
        enabled: config.plugins?.calculator?.enabled ?? hasAgentMode(agents, "mock"),
        uri: calculatorUri,
      },
      browser: {
        enabled: config.plugins?.browser?.enabled ?? false,
        uri: browserUri,
        allowed_origins: config.plugins?.browser?.allowed_origins,
        timeout_ms: config.plugins?.browser?.timeout_ms ?? 10000,
        max_read_bytes: config.plugins?.browser?.max_read_bytes ?? 1024 * 128,
        user_agent: config.plugins?.browser?.user_agent,
      },
      memory: {
        enabled: config.plugins?.memory?.enabled ?? Boolean(memoryBaseUrl),
        uri: memoryUri,
        provider: config.plugins?.memory?.provider ?? "reme-http",
        base_url: memoryBaseUrl,
        base_url_env: config.plugins?.memory?.base_url_env,
        workspace_id: config.plugins?.memory?.workspace_id ?? "kairos-ipc",
        inject_context: config.plugins?.memory?.inject_context ?? true,
        scopes: config.plugins?.memory?.scopes ?? ["personal", "task"],
        top_k: config.plugins?.memory?.top_k ?? 5,
        timeout_ms: config.plugins?.memory?.timeout_ms ?? 120000,
      },
    },
    approval: {
      auto_approve: config.approval?.auto_approve ?? false,
      grant_ttl_ms: config.approval?.grant_ttl_ms ?? 60000,
    },
  };
}

function normalizeAgents(config: Partial<SlockWebDaemonConfig>): SlockWebAgentConfig[] {
  const inherited = config.agent ?? {};
  const configured = Array.isArray(config.agents) && config.agents.length > 0
    ? config.agents
    : hasSingleAgentShortcut(inherited)
      ? [inherited]
      : [
        { ...inherited, mode: "pi", uri: inherited.uri ?? "agent://local/pi-assistant" },
        { mode: "mock", uri: "agent://local/mock" },
      ];
  const seen = new Set<EndpointUri>();

  return configured.map((agent) => {
    const normalized = normalizeAgent(agent, inherited);
    if (!normalized.uri) {
      throw new Error("Slock agent config is missing uri");
    }
    if (seen.has(normalized.uri)) {
      throw new Error(`duplicate Slock agent URI: ${normalized.uri}`);
    }
    seen.add(normalized.uri);
    return normalized;
  });
}

function normalizeAgent(agent: SlockWebAgentConfig, inherited: SlockWebAgentConfig): SlockWebAgentConfig {
  const mode = agent.mode ?? inherited.mode ?? "pi";
  const piDefaults = mode === "pi" ? inherited : {};
  return {
    mode,
    uri: agent.uri ?? defaultAgentUri(mode),
    provider: agent.provider ?? piDefaults.provider ?? "openai",
    model: agent.model ?? piDefaults.model ?? "gpt-4o-mini",
    api: agent.api ?? piDefaults.api,
    api_key: agent.api_key ?? piDefaults.api_key,
    api_key_env: agent.api_key_env ?? piDefaults.api_key_env,
    base_url: agent.base_url ?? piDefaults.base_url,
    base_url_env: agent.base_url_env ?? piDefaults.base_url_env,
    headers: agent.headers ?? piDefaults.headers,
    system_prompt: agent.system_prompt ?? piDefaults.system_prompt ?? DEFAULT_PI_SYSTEM_PROMPT,
    context_history_limit: agent.context_history_limit ?? piDefaults.context_history_limit,
    context_history_scope: agent.context_history_scope ?? piDefaults.context_history_scope ?? "thread",
  };
}

function hasSingleAgentShortcut(agent: SlockWebAgentConfig): boolean {
  return Boolean(agent.mode || agent.uri);
}

function defaultAgentUri(mode: SlockWebAgentMode): EndpointUri {
  return mode === "mock" ? "agent://local/mock" : "agent://local/pi-assistant";
}

function hasAgentMode(agents: SlockWebAgentConfig[], mode: SlockWebAgentMode): boolean {
  return agents.some((agent) => agent.mode === mode);
}

function configFromCliAndEnv(argv: string[], env: Record<string, string | undefined>): SlockWebDaemonConfig {
  return {
    host: readOption(argv, "--host"),
    port: readNumberOption(argv, "--port"),
    runtime_dir: readOption(argv, "--runtime-dir") ?? env.KAIROS_IPC_RUNTIME_DIR,
    workspace_root: readOption(argv, "--workspace"),
    human: {
      user_id: readOption(argv, "--user-id") ?? env.KAIROS_IPC_USER_ID,
      device_id: readOption(argv, "--device-id") ?? env.KAIROS_IPC_DEVICE_ID,
    },
    agent: {
      mode: readAgentMode(readOption(argv, "--agent")),
      provider: readOption(argv, "--provider") ?? env.KAIROS_IPC_PI_PROVIDER,
      model: readOption(argv, "--model") ?? env.KAIROS_IPC_PI_MODEL,
      api: readOption(argv, "--api") ?? env.KAIROS_IPC_PI_API,
      api_key: readOption(argv, "--api-key") ?? env.KAIROS_IPC_PI_API_KEY,
      api_key_env: readOption(argv, "--api-key-env"),
      base_url: readOption(argv, "--base-url") ?? env.KAIROS_IPC_PI_BASE_URL ?? env.OPENAI_BASE_URL,
      base_url_env: readOption(argv, "--base-url-env"),
    },
    plugins: {
      memory: {
        uri: readOption(argv, "--memory-uri") as EndpointUri | undefined,
        base_url: readOption(argv, "--reme-base-url") ?? env.KAIROS_IPC_REME_BASE_URL,
        workspace_id: readOption(argv, "--memory-workspace") ?? env.KAIROS_IPC_MEMORY_WORKSPACE_ID,
      },
    },
    dify_bridge: {
      enabled: readFlag(argv, "--dify-bridge"),
      port: readNumberOption(argv, "--dify-port"),
      auth_token: readOption(argv, "--dify-auth-token"),
    },
    mattermost_bridge: {
      enabled: readFlag(argv, "--mattermost-bridge"),
      host: readOption(argv, "--mattermost-host"),
      port: readNumberOption(argv, "--mattermost-port"),
      public_url: readOption(argv, "--mattermost-public-url") ?? env.KAIROS_MATTERMOST_BRIDGE_PUBLIC_URL,
      mattermost_base_url: readOption(argv, "--mattermost-base-url") ?? env.KAIROS_MATTERMOST_BASE_URL,
      bot_token: readOption(argv, "--mattermost-bot-token"),
      slash_command_token: readOption(argv, "--mattermost-slash-token"),
    },
  };
}

function normalizeChannels(
  config: Partial<SlockWebDaemonConfig>,
  fallbackMentionAliases: MentionAliases,
): SlockWebChannelConfig[] {
  const configured = Array.isArray(config.channels) && config.channels.length > 0
    ? config.channels
    : [{ uri: config.channel_uri ?? "app://slock/channel/general" }];
  const seen = new Set<EndpointUri>();

  return configured.map((channel) => {
    const uri = channel.uri;
    if (!uri) {
      throw new Error("Slock channel config is missing uri");
    }
    if (seen.has(uri)) {
      throw new Error(`duplicate Slock channel URI: ${uri}`);
    }
    seen.add(uri);
    const label = channel.label ?? labelFromUri(uri);
    const kind = channel.kind ?? kindFromUri(uri);
    const mentionAliases = channel.mention_aliases ?? config.channel?.mention_aliases ?? fallbackMentionAliases;

    return {
      uri,
      label,
      kind,
      mention_aliases: mentionAliases,
      default_mentions: channel.default_mentions ?? inferDmDefaultMentions(uri, label, kind, mentionAliases),
      history_limit: channel.history_limit ?? config.channel?.history_limit,
    };
  });
}

function inferDmDefaultMentions(
  uri: EndpointUri,
  label: string,
  kind: SlockWebChannelKind,
  aliases: MentionAliases,
): EndpointUri[] | undefined {
  if (kind !== "dm") {
    return undefined;
  }

  const mentions = new Set<EndpointUri>();
  for (const candidate of dmAliasCandidates(uri, label)) {
    const target = aliases[candidate];
    const uris = Array.isArray(target) ? target : target ? [target] : [];
    for (const targetUri of uris) {
      if (targetUri.startsWith("agent://")) {
        mentions.add(targetUri);
      }
    }
  }

  return mentions.size > 0 ? [...mentions] : undefined;
}

function dmAliasCandidates(uri: EndpointUri, label: string): string[] {
  const lastSegment = labelFromUri(uri);
  const values = [label, lastSegment];
  for (const value of [label, lastSegment]) {
    values.push(...value.split(/[^a-zA-Z0-9_.-]+/));
    values.push(...value.split(/[-_.]+/));
  }

  return [...new Set(values
    .map((value) => value.trim().replace(/^@+/, ""))
    .filter((value) => value.length > 0))];
}

function defaultHumanUri(config: SlockWebDaemonConfig["human"] | undefined): EndpointUri {
  const userId = encodeUriSegment(config?.user_id ?? "local");
  const deviceId = config?.device_id ? encodeUriSegment(config.device_id) : undefined;
  return deviceId ? `human://user/${userId}/device/${deviceId}` : `human://user/${userId}`;
}

function labelFromUri(uri: EndpointUri): string {
  const parts = uri.split("/").filter(Boolean);
  return decodeURIComponent(parts.at(-1) ?? uri);
}

function kindFromUri(uri: EndpointUri): SlockWebChannelKind {
  return uri.startsWith("app://slock/dm/") ? "dm" : "channel";
}

function encodeUriSegment(value: string): string {
  return encodeURIComponent(value.trim()).replace(/%2F/gi, "-");
}

function defaultMentionAliases(agents: SlockWebAgentConfig[]): MentionAliases {
  const aliases: MentionAliases = {};
  const agentUris = agents.map((agent) => agent.uri).filter((uri): uri is EndpointUri => Boolean(uri));

  for (const agent of agents) {
    if (!agent.uri) {
      continue;
    }
    if (agent.mode === "mock") {
      aliases.mock = agent.uri;
    } else {
      aliases.pi = agent.uri;
      aliases["pi-assistant"] = agent.uri;
    }
  }

  if (agentUris.length === 1) {
    aliases.agent = agentUris[0];
  } else if (agentUris.length > 1) {
    aliases.agent = agentUris;
  }

  return aliases;
}

function readAgentMode(value: string | undefined): SlockWebAgentMode | undefined {
  if (!value) {
    return undefined;
  }
  if (value !== "pi" && value !== "mock") {
    throw new Error(`unsupported Slock agent mode: ${value}`);
  }
  return value;
}

function readOption(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index < 0) {
    return undefined;
  }
  const value = argv[index + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

function readNumberOption(argv: string[], name: string): number | undefined {
  const raw = readOption(argv, name);
  if (!raw) {
    return undefined;
  }
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function readFlag(argv: string[], name: string): boolean | undefined {
  return argv.includes(name) ? true : undefined;
}

function readEnv(name: string | undefined, env: Record<string, string | undefined>): string | undefined {
  return name ? env[name] : undefined;
}

function mergeRecord(left: Record<string, unknown>, right: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = { ...left };
  for (const [key, value] of Object.entries(right)) {
    if (value === undefined) {
      continue;
    }
    const previous = next[key];
    next[key] = isRecord(previous) && isRecord(value)
      ? mergeRecord(previous, value)
      : value;
  }
  return next;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
