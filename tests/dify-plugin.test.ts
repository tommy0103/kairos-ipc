import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const pluginRoot = join(process.cwd(), "integrations/dify-kairos-plugin");

const expectedFiles = [
  "manifest.yaml",
  "main.py",
  "requirements.txt",
  "README.md",
  "privacy.md",
  "provider/kairos.yaml",
  "provider/kairos.py",
  "utils/bridge.py",
  "tools/start_collaboration.yaml",
  "tools/start_collaboration.py",
  "tools/start_run.yaml",
  "tools/start_run.py",
  "tools/get_session.yaml",
  "tools/get_session.py",
  "tools/list_artifacts.yaml",
  "tools/list_artifacts.py",
  "tools/read_artifact.yaml",
  "tools/read_artifact.py",
  "tools/review_artifact.yaml",
  "tools/review_artifact.py",
  "tools/list_approvals.yaml",
  "tools/list_approvals.py",
  "tools/resolve_approval.yaml",
  "tools/resolve_approval.py",
  "tools/get_trace.yaml",
  "tools/get_trace.py",
];

test("Dify Kairos plugin has a complete tool-plugin scaffold", () => {
  for (const relative of expectedFiles) {
    assert.equal(existsSync(join(pluginRoot, relative)), true, `${relative} should exist`);
  }

  const manifest = read("manifest.yaml");
  assert.match(manifest, /type:\s*plugin/);
  assert.match(manifest, /plugins:\s*\n\s*tools:\s*\n\s*-\s*provider\/kairos\.yaml/);
  assert.match(manifest, /resource:\s*\n\s*memory:\s*268435456\s*\n\s*permission:\s*\n\s*tool:\s*\n\s*enabled:\s*false/);
  assert.match(manifest, /meta:[\s\S]*runner:\s*\n\s*language:\s*python\s*\n\s*version:\s*"3\.12"\s*\n\s*entrypoint:\s*main/);
  assert.match(manifest, /privacy:\s*\.\/privacy\.md/);
  assert.doesNotMatch(manifest, /endpoint:\s*\n\s*enabled:\s*true/);

  const provider = read("provider/kairos.yaml");
  for (const tool of [
    "start_collaboration",
    "start_run",
    "get_session",
    "list_artifacts",
    "read_artifact",
    "review_artifact",
    "list_approvals",
    "resolve_approval",
    "get_trace",
  ]) {
    assert.match(provider, new RegExp(`tools/${tool}\\.yaml`), `${tool} should be registered`);
  }
  assert.match(provider, /bridge_url:/);
  assert.match(provider, /bridge_token:/);
});

test("Dify Kairos plugin only exposes safe Kairos bridge operations", () => {
  const combined = expectedFiles
    .filter((relative) => relative.endsWith(".py") || relative.endsWith(".yaml"))
    .map(read)
    .join("\n");

  assert.doesNotMatch(combined, /shell|exec|workspace\/edit|ipc_call|arbitrary/i);
  assert.doesNotMatch(combined, /\/kernel|\/sdk|\/plugins\//i);
  assert.match(combined, /\/chat/);
  assert.match(combined, /\/sessions\/\{session_id\}\/runs/);
  assert.match(combined, /\/artifacts\/\{artifact_id\}\/review/);
  assert.match(combined, /\/approvals\/\{approval_id\}\/resolve/);
});

function read(relative: string): string {
  return readFileSync(join(pluginRoot, relative), "utf8");
}
