import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import test from "node:test";
import { createNode } from "../packages/sdk/src/index.ts";
import { createSlockWebDaemon, createSlockWebDaemonRegistryEndpoints, loadSlockWebDaemonConfig } from "../packages/slock-daemon/src/index.ts";

test("Slock web daemon loads JSON config and starts mock agent mode", async () => {
  const root = mkdtempSync(join("/private/tmp", "kairos-ipc-daemon-mock-"));
  const configPath = join(root, "slock-web.json");
  writeFileSync(configPath, JSON.stringify({
    port: 0,
    listen: false,
    runtime_dir: root,
    kernel: { transport: "memory" },
    workspace_root: root,
    human: { user_id: "tomiya", device_id: "macbook" },
    channels: [
      { uri: "app://slock/channel/general", label: "general", kind: "channel" },
      { uri: "app://slock/dm/local-mock", label: "mock", kind: "dm" },
    ],
    agent: { mode: "mock" },
    plugins: {
      memory: {
        enabled: true,
        uri: "plugin://memory/reme",
        base_url: "http://127.0.0.1:8002",
        workspace_id: "kairos-ipc-test",
      },
      browser: {
        enabled: true,
        uri: "plugin://local/browser",
      },
    },
    approval: { auto_approve: true },
  }), "utf8");

  const config = loadSlockWebDaemonConfig({ argv: ["--config", configPath], env: {}, cwd: "/tmp/elsewhere" });
  assert.equal(config.workspace_root, root);
  assert.equal(config.human_uri, "human://user/tomiya/device/macbook");
  assert.deepEqual(config.channels?.map((channel) => channel.uri), [
    "app://slock/channel/general",
    "app://slock/dm/local-mock",
  ]);
  assert.deepEqual(config.channels?.[1]?.default_mentions, ["agent://local/mock"]);
  assert.equal(config.agent?.mode, "mock");
  assert.equal(config.plugins?.memory?.enabled, true);
  assert.equal(config.plugins?.memory?.uri, "plugin://memory/reme");
  assert.equal(config.plugins?.memory?.workspace_id, "kairos-ipc-test");
  assert.equal(config.plugins?.memory?.timeout_ms, 120000);
  assert.equal(config.plugins?.browser?.enabled, true);
  assert.equal(config.plugins?.browser?.uri, "plugin://local/browser");
  assert.equal(config.plugins?.browser?.allowed_origins, undefined);
  assert.equal(config.collaboration?.enabled, true);
  assert.equal(config.collaboration?.session_manager_uri, "app://kairos/session-manager");
  assert.deepEqual(config.channel?.mention_aliases, {
    mock: "agent://local/mock",
    agent: "agent://local/mock",
  });

  const daemon = await createSlockWebDaemon(config);
  try {
    assert.equal(daemon.url, undefined);
    assert.equal(daemon.registry_uri, "slock://registry");
    assert.equal(daemon.session_manager_uri, "app://kairos/session-manager");
    assert.equal(daemon.agent_uri, "agent://local/mock");
    assert.deepEqual(daemon.channel_uris, ["app://slock/channel/general", "app://slock/dm/local-mock"]);
    assert.equal(daemon.config.plugins?.calculator?.enabled, true);
    assert.equal(daemon.config.plugins?.memory?.enabled, true);
    assert.equal(daemon.config.plugins?.browser?.enabled, true);
  } finally {
    await daemon.close();
  }
});

test("Slock web daemon infers DM default mentions from DM URI aliases", () => {
  const root = mkdtempSync(join("/private/tmp", "kairos-ipc-daemon-dm-alias-"));
  const configPath = join(root, "slock-web.json");
  writeFileSync(configPath, JSON.stringify({
    channels: [
      { uri: "app://slock/dm/local-pi", kind: "dm" },
    ],
  }), "utf8");
  const config = loadSlockWebDaemonConfig({
    argv: ["--config", configPath],
    env: {
      KAIROS_IPC_PI_API_KEY: "test-key",
      KAIROS_IPC_PI_PROVIDER: "openai",
      KAIROS_IPC_PI_MODEL: "gpt-4o-mini",
    },
    cwd: root,
  });

  assert.equal(config.channels?.[0]?.label, "local-pi");
  assert.deepEqual(config.channels?.[0]?.default_mentions, ["agent://local/pi-assistant"]);
});

test("Slock web daemon loads pi API override from CLI", () => {
  const root = mkdtempSync(join("/private/tmp", "kairos-ipc-daemon-api-"));
  const config = loadSlockWebDaemonConfig({
    argv: ["--provider", "openai", "--model", "gpt-5.5", "--api", "openai-completions", "--base-url", "https://gateway.example.test/v1"],
    env: {},
    cwd: root,
  });

  assert.equal(config.agent?.provider, "openai");
  assert.equal(config.agent?.model, "gpt-5.5");
  assert.equal(config.agent?.api, "openai-completions");
  assert.equal(config.agent?.base_url, "https://gateway.example.test/v1");
});

test("Dify bridge config defaults disabled and resolves CLI/env auth", () => {
  const root = mkdtempSync(join("/private/tmp", "kairos-ipc-daemon-dify-config-"));
  const defaults = loadSlockWebDaemonConfig({ argv: [], env: {}, cwd: root });

  assert.equal(defaults.dify_bridge?.enabled, false);
  assert.equal(defaults.dify_bridge?.host, "127.0.0.1");
  assert.equal(defaults.dify_bridge?.port, 5180);
  assert.equal(defaults.dify_bridge?.auth_token, undefined);

  const config = loadSlockWebDaemonConfig({
    argv: ["--dify-bridge", "--dify-port", "0", "--dify-auth-token", "cli-token"],
    env: { KAIROS_DIFY_BRIDGE_TOKEN: "env-token" },
    cwd: root,
  });

  assert.equal(config.dify_bridge?.enabled, true);
  assert.equal(config.dify_bridge?.host, "127.0.0.1");
  assert.equal(config.dify_bridge?.port, 0);
  assert.equal(config.dify_bridge?.auth_token, "cli-token");

  const envTokenConfig = loadSlockWebDaemonConfig({
    argv: ["--dify-bridge"],
    env: { KAIROS_DIFY_BRIDGE_TOKEN: "env-token" },
    cwd: root,
  });

  assert.equal(envTokenConfig.dify_bridge?.enabled, true);
  assert.equal(envTokenConfig.dify_bridge?.auth_token, "env-token");
});

test("Dify bridge config resolves auth token from configured env var before default env", () => {
  const root = mkdtempSync(join("/private/tmp", "kairos-ipc-daemon-dify-env-"));
  const configPath = join(root, "slock-web.json");
  writeFileSync(configPath, JSON.stringify({
    dify_bridge: {
      enabled: true,
      auth_token_env: "CUSTOM_DIFY_TOKEN",
    },
  }), "utf8");

  const config = loadSlockWebDaemonConfig({
    argv: ["--config", configPath],
    env: {
      CUSTOM_DIFY_TOKEN: "custom-token",
      KAIROS_DIFY_BRIDGE_TOKEN: "default-token",
    },
    cwd: root,
  });

  assert.equal(config.dify_bridge?.enabled, true);
  assert.equal(config.dify_bridge?.auth_token_env, "CUSTOM_DIFY_TOKEN");
  assert.equal(config.dify_bridge?.auth_token, "custom-token");
});

test("Dify bridge daemon mounts and listens when Slock UI listen is false", async () => {
  const root = mkdtempSync(join("/private/tmp", "kairos-ipc-daemon-dify-mount-"));
  const port = await getFreePortIfAvailable();
  if (port === undefined) return;
  const config = loadSlockWebDaemonConfig({
    argv: [],
    env: {},
    cwd: root,
  });

  const daemon = await createSlockWebDaemonIfLocalBindAvailable({
    ...config,
    listen: false,
    runtime_dir: root,
    kernel: { transport: "unix" },
    workspace_root: root,
    agent: { mode: "mock" },
    agents: [{ mode: "mock", uri: "agent://local/mock" }],
    dify_bridge: {
      enabled: true,
      host: "127.0.0.1",
      port,
      auth_token: "test-token",
      allowed_origins: ["http://127.0.0.1:3000"],
    },
  });
  if (!daemon) return;

  try {
    assert.equal(daemon.url, undefined);
    assert.match(daemon.dify_bridge_url ?? "", /^http:\/\/127\.0\.0\.1:\d+$/);
    const response = await fetch(`${daemon.dify_bridge_url}/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });

    const unauthenticated = await fetch(`${daemon.dify_bridge_url}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "No token" }),
    });
    assert.equal(unauthenticated.status, 401);

    const session = await fetch(`${daemon.dify_bridge_url}/sessions`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ title: "Dify mounted through daemon" }),
    });
    assert.equal(session.status, 200);
    assert.match(((await session.json()) as { session_id: string }).session_id, /^session_/);
  } finally {
    await daemon.close();
  }
});

test("Dify bridge daemon requires collaboration", async () => {
  const root = mkdtempSync(join("/private/tmp", "kairos-ipc-daemon-dify-collab-"));

  await assert.rejects(
    () => createSlockWebDaemon({
      listen: false,
      runtime_dir: root,
      kernel: { transport: "memory" },
      workspace_root: root,
      collaboration: { enabled: false },
      agent: { mode: "mock" },
      agents: [{ mode: "mock", uri: "agent://local/mock" }],
      dify_bridge: {
        enabled: true,
        host: "127.0.0.1",
        port: 0,
        auth_token: "test-token",
      },
    }),
    /Dify bridge requires collaboration\.enabled and collaboration\.session_manager_uri/,
  );
});

test("Mattermost bridge config defaults disabled and resolves env credentials", () => {
  const root = mkdtempSync(join("/private/tmp", "kairos-ipc-daemon-mattermost-config-"));
  const defaults = loadSlockWebDaemonConfig({ argv: [], env: {}, cwd: root });

  assert.equal(defaults.mattermost_bridge?.enabled, false);
  assert.equal(defaults.mattermost_bridge?.host, "127.0.0.1");
  assert.equal(defaults.mattermost_bridge?.port, 5190);
  assert.equal(defaults.mattermost_bridge?.public_url, undefined);
  assert.equal(defaults.mattermost_bridge?.mattermost_base_url, undefined);
  assert.equal(defaults.mattermost_bridge?.bot_token, undefined);
  assert.equal(defaults.mattermost_bridge?.slash_command_token, undefined);

  const configPath = join(root, "slock-web.json");
  writeFileSync(configPath, JSON.stringify({
    mattermost_bridge: {
      enabled: true,
      host: "0.0.0.0",
      port: 0,
      public_url: "https://kairos.example.test",
      mattermost_base_url: "https://mattermost.example.test",
      bot_token_env: "CUSTOM_MATTERMOST_BOT_TOKEN",
      slash_command_token_env: "CUSTOM_MATTERMOST_SLASH_TOKEN",
      allowed_team_ids: ["team_1"],
      allowed_origins: ["https://mattermost.example.test"],
      allowed_user_ids: ["user_1"],
      max_body_bytes: 4096,
      allowed_agent_uris: ["agent://local/alice"],
      default_agents: ["agent://local/alice"],
      agent_aliases: { alice: "agent://local/alice" },
    },
  }), "utf8");

  const config = loadSlockWebDaemonConfig({
    argv: ["--config", configPath],
    env: {
      CUSTOM_MATTERMOST_BOT_TOKEN: "custom-bot-token",
      CUSTOM_MATTERMOST_SLASH_TOKEN: "custom-slash-token",
      KAIROS_MATTERMOST_BOT_TOKEN: "default-bot-token",
      KAIROS_MATTERMOST_SLASH_TOKEN: "default-slash-token",
    },
    cwd: root,
  });

  assert.equal(config.mattermost_bridge?.enabled, true);
  assert.equal(config.mattermost_bridge?.host, "0.0.0.0");
  assert.equal(config.mattermost_bridge?.port, 0);
  assert.equal(config.mattermost_bridge?.public_url, "https://kairos.example.test");
  assert.equal(config.mattermost_bridge?.mattermost_base_url, "https://mattermost.example.test");
  assert.equal(config.mattermost_bridge?.bot_token_env, "CUSTOM_MATTERMOST_BOT_TOKEN");
  assert.equal(config.mattermost_bridge?.bot_token, "custom-bot-token");
  assert.equal(config.mattermost_bridge?.slash_command_token_env, "CUSTOM_MATTERMOST_SLASH_TOKEN");
  assert.equal(config.mattermost_bridge?.slash_command_token, "custom-slash-token");
  assert.deepEqual(config.mattermost_bridge?.allowed_team_ids, ["team_1"]);
  assert.deepEqual(config.mattermost_bridge?.allowed_origins, ["https://mattermost.example.test"]);
  assert.deepEqual(config.mattermost_bridge?.allowed_user_ids, ["user_1"]);
  assert.equal(config.mattermost_bridge?.max_body_bytes, 4096);
  assert.deepEqual(config.mattermost_bridge?.allowed_agent_uris, ["agent://local/alice"]);
  assert.deepEqual(config.mattermost_bridge?.default_agents, ["agent://local/alice"]);
  assert.deepEqual(config.mattermost_bridge?.agent_aliases, { alice: "agent://local/alice" });
});

test("Mattermost bridge config requires slash command token when enabled", () => {
  const root = mkdtempSync(join("/private/tmp", "kairos-ipc-daemon-mattermost-token-"));

  assert.throws(
    () => loadSlockWebDaemonConfig({
      argv: ["--mattermost-bridge", "--mattermost-base-url", "https://mattermost.local", "--mattermost-bot-token", "bot-token"],
      env: {},
      cwd: root,
    }),
    /mattermost_bridge\.slash_command_token is required when mattermost_bridge\.enabled is true/,
  );

  const config = loadSlockWebDaemonConfig({
    argv: ["--mattermost-bridge", "--mattermost-base-url", "https://mattermost.local", "--mattermost-bot-token", "bot-token"],
    env: { KAIROS_MATTERMOST_SLASH_TOKEN: "env-slash-token" },
    cwd: root,
  });
  assert.equal(config.mattermost_bridge?.slash_command_token, "env-slash-token");
});

test("Mattermost bridge appears in Slock registry endpoints when enabled", () => {
  const root = mkdtempSync(join("/private/tmp", "kairos-ipc-daemon-mattermost-registry-"));
  const endpoints = createSlockWebDaemonRegistryEndpoints({
    listen: false,
    runtime_dir: root,
    kernel: { transport: "memory" },
    workspace_root: root,
    agent: { mode: "mock" },
    agents: [{ mode: "mock", uri: "agent://local/mock" }],
    mattermost_bridge: {
      enabled: true,
      mattermost_base_url: "https://mattermost.local",
      bot_token: "bot-token",
      slash_command_token: "slash-token",
    },
  });

  assert.ok(endpoints.some((endpoint) => endpoint.uri === "app://kairos/mattermost-bridge" && endpoint.kind === "app" && endpoint.label === "Mattermost bridge" && endpoint.internal === true));
});

test("Mattermost bridge daemon mounts, registers, and listens when Slock UI listen is false", async () => {
  const root = mkdtempSync(join("/private/tmp", "kairos-ipc-daemon-mattermost-mount-"));
  const port = await getFreePortIfAvailable();
  if (port === undefined) return;

  const daemon = await createSlockWebDaemonIfLocalBindAvailable({
    listen: false,
    runtime_dir: root,
    kernel: { transport: "memory" },
    workspace_root: root,
    agent: { mode: "mock" },
    agents: [{ mode: "mock", uri: "agent://local/mock" }],
    mattermost_bridge: {
      enabled: true,
      host: "127.0.0.1",
      port,
      public_url: "http://127.0.0.1:5190",
      mattermost_base_url: "https://mattermost.local",
      bot_token: "bot-token",
      slash_command_token: "slash-token",
      allowed_team_ids: ["team_1"],
      allowed_origins: ["https://mattermost.local"],
      allowed_agent_uris: ["agent://local/mock"],
      default_agents: ["agent://local/mock"],
      agent_aliases: { mock: "agent://local/mock" },
    },
  });
  if (!daemon) return;
  const registryClient = createNode("test://slock-daemon/mattermost-registry-client");

  try {
    await registryClient.connect(daemon.ipc_address);
    const registry = await registryClient.call<any, { endpoints: Array<{ uri: string; kind: string; label?: string; internal?: boolean }> }>(daemon.registry_uri, "list_endpoints", {
      mime_type: "application/json",
      data: { include_internal: true, kind: "app" },
    });
    assert.ok(registry.data.endpoints.some((endpoint) => endpoint.uri === "app://kairos/mattermost-bridge" && endpoint.kind === "app" && endpoint.label === "Mattermost bridge" && endpoint.internal === true));

    assert.equal(daemon.url, undefined);
    assert.match(daemon.mattermost_bridge_url ?? "", /^http:\/\/127\.0\.0\.1:\d+$/);
    const response = await fetch(`${daemon.mattermost_bridge_url}/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });

    const rejectedTeam = await fetch(`${daemon.mattermost_bridge_url}/mattermost/slash`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://mattermost.local" },
      body: new URLSearchParams({
        token: "slash-token",
        team_id: "team_2",
        channel_id: "channel_1",
        user_id: "user_1",
        command: "/kairos",
        text: "status session_1",
      }),
    });
    assert.equal(rejectedTeam.status, 403);
  } finally {
    await registryClient.close().catch(() => undefined);
    await daemon.close();
  }
});

test("Mattermost bridge daemon requires collaboration", async () => {
  const root = mkdtempSync(join("/private/tmp", "kairos-ipc-daemon-mattermost-collab-"));

  await assert.rejects(
    () => createSlockWebDaemon({
      listen: false,
      runtime_dir: root,
      kernel: { transport: "memory" },
      workspace_root: root,
      collaboration: { enabled: false },
      agent: { mode: "mock" },
      agents: [{ mode: "mock", uri: "agent://local/mock" }],
      mattermost_bridge: {
        enabled: true,
        host: "127.0.0.1",
        port: 0,
        mattermost_base_url: "https://mattermost.local",
        bot_token: "bot-token",
        slash_command_token: "slash-token",
      },
    }),
    /Mattermost bridge requires collaboration\.enabled and collaboration\.session_manager_uri/,
  );
});

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === "object") {
          resolve(address.port);
        } else {
          reject(new Error("failed to allocate a local test port"));
        }
      });
    });
  });
}

async function getFreePortIfAvailable(): Promise<number | undefined> {
  try {
    return await getFreePort();
  } catch (error) {
    if (isLocalBindUnavailable(error)) {
      return undefined;
    }
    throw error;
  }
}

async function createSlockWebDaemonIfLocalBindAvailable(config: Parameters<typeof createSlockWebDaemon>[0]) {
  try {
    return await createSlockWebDaemon(config);
  } catch (error) {
    if (isLocalBindUnavailable(error)) {
      return undefined;
    }
    throw error;
  }
}

function isLocalBindUnavailable(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { code?: unknown; syscall?: unknown; message?: unknown };
  const code = typeof candidate.code === "string" ? candidate.code : undefined;
  const syscall = typeof candidate.syscall === "string" ? candidate.syscall : undefined;
  const message = typeof candidate.message === "string" ? candidate.message : "";
  return (code === "EPERM" || code === "EACCES") && (syscall === "listen" || /listen|bind/i.test(message));
}

test("Slock web daemon defaults general to all built-in agents online", async () => {
  const root = mkdtempSync(join("/private/tmp", "kairos-ipc-daemon-all-agents-"));
  const config = loadSlockWebDaemonConfig({
    argv: [],
    env: {
      KAIROS_IPC_PI_API_KEY: "test-key",
      KAIROS_IPC_PI_PROVIDER: "openai",
      KAIROS_IPC_PI_MODEL: "gpt-4o-mini",
    },
    cwd: root,
  });

  assert.deepEqual(config.agents?.map((agent) => agent.uri), [
    "agent://local/pi-assistant",
    "agent://local/mock",
  ]);
  assert.deepEqual(config.channel?.mention_aliases, {
    pi: "agent://local/pi-assistant",
    "pi-assistant": "agent://local/pi-assistant",
    mock: "agent://local/mock",
    agent: ["agent://local/pi-assistant", "agent://local/mock"],
  });
  assert.equal(config.plugins?.workspace?.enabled, true);
  assert.equal(config.plugins?.calculator?.enabled, true);

  const daemon = await createSlockWebDaemon({
    ...config,
    listen: false,
    runtime_dir: root,
    kernel: { transport: "memory" },
  });
  try {
    assert.deepEqual(daemon.agent_uris, ["agent://local/pi-assistant", "agent://local/mock"]);
  } finally {
    await daemon.close();
  }
});

test("Slock web daemon can start pi agent mode from a config object", async () => {
  const root = mkdtempSync(join("/private/tmp", "kairos-ipc-daemon-pi-"));
  const daemon = await createSlockWebDaemon({
    port: 0,
    listen: false,
    runtime_dir: root,
    kernel: { transport: "memory" },
    workspace_root: root,
    agent: {
      mode: "pi",
      api_key: "test-key",
      provider: "openai",
      model: "gpt-4o-mini",
    },
  });

  try {
    assert.equal(daemon.agent_uri, "agent://local/pi-assistant");
    assert.equal(daemon.config.agent?.mode, "pi");
    assert.equal(daemon.config.plugins?.workspace?.enabled, true);
    assert.equal(daemon.config.plugins?.shell?.enabled, true);
  } finally {
    await daemon.close();
  }
});
