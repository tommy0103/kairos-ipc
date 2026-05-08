import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createSlockWebDaemon, loadSlockWebDaemonConfig } from "../packages/slock-daemon/src/index.ts";

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
