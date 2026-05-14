import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { AllowAllCapabilityGate } from "../packages/kernel/src/capability.ts";
import type { Connection } from "../packages/kernel/src/registry.ts";
import { EndpointRegistry } from "../packages/kernel/src/registry.ts";
import { Router } from "../packages/kernel/src/router.ts";
import { TraceWriter } from "../packages/kernel/src/trace.ts";
import type { ClientFrame, KernelFrame } from "../packages/protocol/src/index.ts";
import {
  artifactReadyCard,
  buildMattermostSourceRef,
  createMattermostBridge,
  createMattermostBridgeFetchHandler,
  createMattermostBridgeService,
  createMattermostCallbackToken,
  createMattermostBotClient,
  errorResponse,
  mattermostActionUri,
  mattermostChannelUri,
  mattermostPostUri,
  MattermostRestError,
  sourceRefFromMattermost,
} from "../packages/mattermost-bridge/src/index.ts";
import { createNode, type IpcNode, type IpcTransport } from "../packages/sdk/src/index.ts";
import { createSessionManager, KAIROS_DASHBOARD_EVENT_MIME } from "../packages/session-manager/src/index.ts";

test("Mattermost source refs are stable for posts, channels, and user actions", () => {
  assert.equal(mattermostPostUri("team 1", "channel/1", "post?1"), "mattermost://team/team%201/channel/channel%2F1/post/post%3F1");
  assert.equal(mattermostChannelUri("team 1", "channel/1"), "mattermost://team/team%201/channel/channel%2F1");
  assert.equal(
    mattermostActionUri({ team_id: "team 1", channel_id: "channel/1", post_id: "post?1", user_id: "user 1", action: "approve/tool" }),
    "mattermost://team/team%201/channel/channel%2F1/post/post%3F1/user/user%201/action/approve%2Ftool",
  );

  assert.deepEqual(sourceRefFromMattermost({ team_id: "team_1", channel_id: "channel_1", post_id: "post_1" }, "Mattermost post"), {
    kind: "external",
    uri: "mattermost://team/team_1/channel/channel_1/post/post_1",
    label: "Mattermost post",
  });

  assert.equal(buildMattermostSourceRef({ team_id: "team_1", channel_id: "channel_1" }, "Mattermost channel").uri, "mattermost://team/team_1/channel/channel_1");
  assert.equal(
    buildMattermostSourceRef({ team_id: "team_1", channel_id: "channel_1", user_id: "user_1", action: "answer_question" }, "Mattermost action").uri,
    "mattermost://team/team_1/channel/channel_1/user/user_1/action/answer_question",
  );
});

test("artifact ready card omits raw artifact body content", () => {
  const secretBody = "SECRET_MARKDOWN_BODY ".repeat(40);
  const card = artifactReadyCard({
    artifact: {
      id: "artifact_1",
      session_id: "session_1",
      author: "agent://local/alice",
      kind: "research_note",
      title: "Architecture notes",
      content: secretBody,
      status: "submitted",
      source_refs: [],
      created_at: "2026-05-13T00:00:00.000Z",
    },
    summary: "A concise human-readable artifact summary.",
    trace_url: "https://kairos.local/trace/session_1",
  });

  const serialized = JSON.stringify(card);
  assert.equal(serialized.includes("SECRET_MARKDOWN_BODY"), false);
  assert.equal(serialized.includes(secretBody), false);
  assert.match(serialized, /Architecture notes/);
  assert.match(serialized, /A concise human-readable artifact summary/);
});

test("artifact and trace links render as compact fields instead of callback actions", () => {
  const card = artifactReadyCard({
    artifact: {
      id: "artifact_1",
      session_id: "session_1",
      author: "agent://local/alice",
      kind: "research_note",
      title: "Architecture notes",
      content: "Body must stay out of cards",
      status: "submitted",
      source_refs: [],
      created_at: "2026-05-13T00:00:00.000Z",
    },
    summary: "A concise human-readable artifact summary.",
    artifact_url: "https://kairos.local/artifacts/artifact_1",
    trace_url: "https://kairos.local/trace/session_1",
  });

  const attachment = card.attachments?.[0];
  assert.ok(attachment);
  assert.equal(attachment.actions?.some((action) => action.integration.url === "https://kairos.local/artifacts/artifact_1"), false);
  assert.equal(attachment.actions?.some((action) => action.integration.url === "https://kairos.local/trace/session_1"), false);
  assert.deepEqual(attachment.actions ?? [], []);
  assert.ok(attachment.fields?.some((field) => field.title === "Open artifact" && field.value === "https://kairos.local/artifacts/artifact_1"));
  assert.ok(attachment.fields?.some((field) => field.title === "Trace" && field.value === "https://kairos.local/trace/session_1"));
});

test("error response does not reflect raw internal error text into Mattermost payload", () => {
  const rawError = "sk-live-SECRET token failed in /private/tmp/internal-stack.ts:42";
  const response = errorResponse(rawError);
  const serialized = JSON.stringify(response);

  assert.equal(serialized.includes("sk-live-SECRET"), false);
  assert.equal(serialized.includes("/private/tmp/internal-stack.ts"), false);
  assert.equal(response.text, "Kairos error: The request could not be completed.");
  assert.equal(response.attachments?.[0]?.text, "The request could not be completed.");
});

test("Mattermost bot client creates posts with bearer auth, JSON body, and trimmed base URL", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const client = createMattermostBotClient({
    mattermost_base_url: "https://mattermost.local///",
    bot_token: "bot-secret",
    fetch: async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      return jsonResponse({ id: "post_1", channel_id: "channel_1", message: "hello" });
    },
  });

  const result = await client.createPost({ channel_id: "channel_1", message: "hello" });

  assert.equal(result.id, "post_1");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "https://mattermost.local/api/v4/posts");
  assert.equal(calls[0]?.init.method, "POST");
  assert.equal(headerValue(calls[0]!.init.headers, "Authorization"), "Bearer bot-secret");
  assert.equal(headerValue(calls[0]!.init.headers, "Content-Type"), "application/json");
  assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), { channel_id: "channel_1", message: "hello" });
});

test("Mattermost bot client updates posts and forces body id to URL post id", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const client = createMattermostBotClient({
    mattermost_base_url: "https://mattermost.local/",
    bot_token: "bot-secret",
    fetch: async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      return jsonResponse({ id: "post_1", channel_id: "channel_1", message: "updated" });
    },
  });

  await client.updatePost("post_1", { id: "different_post", message: "updated" });

  assert.equal(calls[0]?.url, "https://mattermost.local/api/v4/posts/post_1");
  assert.equal(calls[0]?.init.method, "PUT");
  assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), { id: "post_1", message: "updated" });
});

test("Mattermost bot client opens dialogs with JSON body", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const client = createMattermostBotClient({
    mattermost_base_url: "https://mattermost.local",
    bot_token: "bot-secret",
    fetch: async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      return jsonResponse({ ok: true });
    },
  });

  await client.openDialog({
    trigger_id: "trigger_1",
    url: "https://bridge.local/mattermost/dialog",
    dialog: { title: "Answer question", elements: [{ display_name: "Answer", name: "answer", type: "textarea" }] },
  });

  assert.equal(calls[0]?.url, "https://mattermost.local/api/v4/actions/dialogs/open");
  assert.equal(calls[0]?.init.method, "POST");
  assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), {
    trigger_id: "trigger_1",
    url: "https://bridge.local/mattermost/dialog",
    dialog: { title: "Answer question", elements: [{ display_name: "Answer", name: "answer", type: "textarea" }] },
  });
});

test("Mattermost bot client surfaces non-2xx responses as explicit errors", async () => {
  const secretBody = "database_password=SECRET server-side diagnostic";
  const client = createMattermostBotClient({
    mattermost_base_url: "https://mattermost.local",
    bot_token: "bot-secret",
    fetch: async () => new Response(secretBody, { status: 403, statusText: "Forbidden" }),
  });

  await assert.rejects(
    client.createPost({ channel_id: "channel_1", message: "hello" }),
    (error) => {
      assert.ok(error instanceof MattermostRestError);
      assert.equal(error.status, 403);
      assert.equal(error.statusText, "Forbidden");
      assert.equal(error.body, secretBody);
      assert.match(error.message, /Mattermost POST \/api\/v4\/posts failed with 403 Forbidden/);
      assert.equal(error.message.includes("SECRET"), false);
      assert.equal(error.message.includes("database_password"), false);
      return true;
    },
  );
});

test("Mattermost bot client times out hung REST calls", async () => {
  const client = createMattermostBotClient({
    mattermost_base_url: "https://mattermost.local",
    bot_token: "bot-secret",
    timeout_ms: 1,
    fetch: async () => new Promise<Response>(() => undefined),
  });

  await assert.rejects(
    client.createPost({ channel_id: "channel_1", message: "hello" }),
    (error) => error instanceof MattermostRestError && error.status === 504 && /timed out/.test(error.message),
  );
});

test("Mattermost bridge start creates a session and starts inferred agent delegations", async () => {
  const human = fakeHumanNode({
    create_session: { session_id: "session_1", session_uri: "session://session_1", state: { session: { status: "open" } } },
    start_delegations: { session_id: "session_1", task_id: "task_1", delegation_ids: ["delegation_1", "delegation_2"], mode: "parallel" },
  });
  const service = createService(human.node, { agent_aliases: { alice: "agent://local/alice", reviewer: "agent://local/reviewer" } });

  const response = await service.handleSlash(slashPayload("start alice reviewer Review the auth flow"));

  assert.equal(response.response_type, "ephemeral");
  assert.match(response.text ?? "", /Kairos session started/);
  assert.deepEqual(human.actions(), ["create_session", "start_delegations"]);
  assert.equal(human.calls[0]?.data.title, "Review the auth flow");
  assert.equal(human.calls[0]?.data.objective, "Review the auth flow");
  assert.deepEqual(human.calls[1]?.data.delegations, [{ assignee: "agent://local/alice" }, { assignee: "agent://local/reviewer" }]);
  assert.equal(human.calls[1]?.data.instruction, "Review the auth flow");
  assert.equal(JSON.stringify(response).includes("session_1"), true);
});

test("Mattermost bridge start ignores arbitrary explicit agent URIs unless allowlisted", async () => {
  const human = fakeHumanNode({
    create_session: { session_id: "session_1", session_uri: "session://session_1", state: { session: { status: "open" } } },
    start_delegations: { session_id: "session_1", task_id: "task_1", delegation_ids: ["delegation_1"], mode: "parallel" },
  });
  const service = createService(human.node, { allowed_agent_uris: ["agent://local/alice"] });

  const rejected = await service.handleSlash(slashPayload("start agent://evil/root agent://local/alice Inspect auth"));

  assert.equal(rejected.response_type, "ephemeral");
  assert.match(rejected.text ?? "", /not allowed/);
  assert.deepEqual(human.actions(), []);
});

test("Mattermost bridge can route explicit agent URIs only when allowlisted", async () => {
  const human = fakeHumanNode({
    create_session: { session_id: "session_1", session_uri: "session://session_1", state: { session: { status: "open" } } },
    start_delegations: { session_id: "session_1", task_id: "task_1", delegation_ids: ["delegation_1"], mode: "parallel" },
  });
  const service = createService(human.node, { allowed_agent_uris: ["agent://local/alice"] });

  await service.handleSlash(slashPayload("start agent://local/alice Inspect auth"));

  assert.deepEqual(human.actions(), ["create_session", "start_delegations"]);
  assert.deepEqual(human.calls[1]?.data.delegations, [{ assignee: "agent://local/alice" }]);
  assert.equal(human.calls[1]?.data.instruction, "Inspect auth");
});

test("Mattermost bridge aliases may expand to multiple allowed agents", async () => {
  const human = fakeHumanNode({
    create_session: { session_id: "session_1", session_uri: "session://session_1", state: { session: { status: "open" } } },
    start_delegations: { session_id: "session_1", task_id: "task_1", delegation_ids: ["delegation_1", "delegation_2"], mode: "parallel" },
  });
  const service = createService(human.node, {
    agent_aliases: { team: ["agent://local/alice", "agent://local/cindy"] },
    allowed_agent_uris: ["agent://local/alice", "agent://local/cindy"],
  });

  await service.handleSlash(slashPayload("start team Build a test plan"));

  assert.deepEqual(human.calls[1]?.data.delegations, [{ assignee: "agent://local/alice" }, { assignee: "agent://local/cindy" }]);
});

test("Mattermost bridge rejects aliases outside allowed agent uris without silent fallback", async () => {
  const human = fakeHumanNode({
    create_session: { session_id: "session_1", session_uri: "session://session_1", state: { session: { status: "open" } } },
    start_delegations: { session_id: "session_1", task_id: "task_1", delegation_ids: ["delegation_1"], mode: "parallel" },
  });
  const service = createService(human.node, { allowed_agent_uris: ["agent://local/alice"] });

  const response = await service.handleSlash(slashPayload("start alice cindy reviewer Compare options"));

  assert.equal(response.response_type, "ephemeral");
  assert.match(response.text ?? "", /cindy/);
  assert.match(response.text ?? "", /reviewer/);
  assert.deepEqual(human.actions(), []);
});

test("Mattermost bridge status without a session returns a helpful ephemeral response", async () => {
  const human = fakeHumanNode();
  const service = createService(human.node);

  const response = await service.handleSlash(slashPayload("status"));

  assert.equal(response.response_type, "ephemeral");
  assert.match(response.text ?? "", /session id/i);
  assert.deepEqual(human.actions(), []);
});

test("Mattermost bridge start without selected agents returns a helpful response instead of creating an idle session", async () => {
  const human = fakeHumanNode({
    create_session: { session_id: "session_1", session_uri: "session://session_1", state: { session: { status: "open" } } },
    start_delegations: { session_id: "session_1", task_id: "task_1", delegation_ids: ["delegation_1"], mode: "parallel" },
  });
  const service = createService(human.node, { agent_aliases: {}, default_agents: [] });

  const response = await service.handleSlash(slashPayload("start Research the repository"));

  assert.equal(response.response_type, "ephemeral");
  assert.match(response.text ?? "", /No Kairos agents selected/i);
  assert.deepEqual(human.actions(), []);
});

test("Mattermost bridge attach sends Mattermost source refs to session manager", async () => {
  const human = fakeHumanNode({ attach_source: { session_id: "session_1" } });
  const service = createService(human.node);

  const response = await service.handleSlash(slashPayload("attach session_1", { post_id: "post_1" }));

  assert.equal(response.response_type, "ephemeral");
  assert.match(response.text ?? "", /Attached Mattermost source/);
  assert.deepEqual(human.actions(), ["attach_source"]);
  assert.equal(human.calls[0]?.data.session_id, "session_1");
  assert.deepEqual(human.calls[0]?.data.source_ref, {
    kind: "external",
    uri: "mattermost://team/team_1/channel/channel_1/post/post_1",
    label: "Mattermost post",
  });
});

test("Mattermost bridge approve and reject resolve approvals through session manager", async () => {
  const human = fakeHumanNode({ resolve_approval: { session_id: "session_1", state: { approvals: {} } } });
  const service = createService(human.node);

  const approved = await service.handleAction(actionPayload("approve", { session_id: "session_1", approval_id: "approval_1" }));
  const rejected = await service.handleAction(actionPayload("reject", { session_id: "session_1", approval_id: "approval_2" }));

  assert.deepEqual(approved, { ephemeral_text: "Approval approved.", skip_slack_parsing: true });
  assert.deepEqual(rejected, { ephemeral_text: "Approval rejected.", skip_slack_parsing: true });
  assert.deepEqual(human.actions(), ["resolve_approval", "resolve_approval"]);
  assert.deepEqual(human.calls[0]?.data, {
    session_id: "session_1",
    approval_id: "approval_1",
    status: "approved",
    approved: true,
    resolved_by: "mattermost://team/team_1/channel/channel_1/post/post_1/user/user_1/action/approve",
    resolution_note: "Mattermost approve by user_1",
  });
  assert.equal(human.calls[1]?.data.status, "rejected");
  assert.equal(human.calls[1]?.data.approved, false);
});

test("Mattermost bridge artifact actions call review endpoints without local side effects", async () => {
  const human = fakeHumanNode({
    review_artifact: { session_id: "session_1", state: { artifacts: {} } },
    request_revision: { session_id: "session_1", state: { artifacts: {} } },
  });
  const service = createService(human.node);

  const accepted = await service.handleAction(actionPayload("accept_artifact", { session_id: "session_1", artifact_id: "artifact_1" }));
  const revision = await service.handleDialog(dialogPayload("request_revision", { session_id: "session_1", artifact_id: "artifact_1" }, { note: "Needs sources", revision_instruction: "Add citations" }));

  assert.deepEqual(accepted, { ephemeral_text: "Artifact accepted. See the artifact and trace links.", skip_slack_parsing: true });
  assert.deepEqual(revision, {});
  assert.deepEqual(human.actions(), ["review_artifact", "request_revision"]);
  assert.equal(human.calls[0]?.data.status, "accepted");
  assert.equal(human.calls[0]?.data.reviewer, "mattermost://team/team_1/channel/channel_1/post/post_1/user/user_1/action/accept_artifact");
  assert.equal(human.calls[1]?.data.status, "revision_requested");
  assert.equal(human.calls[1]?.data.note, "Needs sources");
  assert.equal(human.calls[1]?.data.revision_instruction, "Add citations");
});

test("Mattermost bridge action responses stay compact", async () => {
  const human = fakeHumanNode({ request_synthesis: { session_id: "session_1", state: { session: { status: "open" } } } });
  const service = createService(human.node);

  const response = await service.handleAction(actionPayload("request_synthesis", { session_id: "session_1" }));
  const serialized = JSON.stringify(response);

  assert.equal(response.ephemeral_text, "Synthesis requested. Full details will stay in Kairos links and trace.");
  assert.equal(response.skip_slack_parsing, true);
  assert.ok(serialized.length < 600);
  assert.equal(serialized.includes("artifacts"), false);
  assert.equal(serialized.includes("events"), false);
  assert.deepEqual(human.actions(), ["request_synthesis"]);
});

test("Mattermost bridge rejects dialog state action mismatches", async () => {
  const human = fakeHumanNode({ answer_question: { session_id: "session_1", state: { questions: {} } } });
  const service = createService(human.node);

  const response = await service.handleDialog({
    user_id: "user_1",
    team_id: "team_1",
    channel_id: "channel_1",
    callback_id: "answer_question",
    state: JSON.stringify({ action: "request_revision", session_id: "session_1", question_id: "question_1" }),
    submission: { answer: "Yes" },
  });

  assert.deepEqual(response, { error: "The request could not be completed." });
  assert.deepEqual(human.actions(), []);
});

test("Mattermost bridge uses bridge_public_url for artifact and trace links", async () => {
  const service = createService(fakeHumanNode().node, { bridge_public_url: "https://bridge.local/base/" });

  const artifact = await service.handleSlash(slashPayload("artifact artifact 1"));
  const trace = await service.handleSlash(slashPayload("trace session/1"));

  assert.match(artifact.text ?? "", /https:\/\/bridge\.local\/base\/artifacts\/artifact/);
  assert.match(trace.text ?? "", /https:\/\/bridge\.local\/base\/trace\/session%2F1/);
});

test("Mattermost bridge generated review action URLs carry signed callback tokens without exposing the secret", async () => {
  const posts: Array<{ url: string; body: any }> = [];
  const service = createService(fakeHumanNode().node, {
    bridge_public_url: "https://bridge.local/base/",
    slash_command_token: "slash-secret",
    fetch: async (url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      posts.push({ url: String(url), body });
      return jsonResponse({ id: body.id ?? `post_${posts.length}`, channel_id: body.channel_id, message: body.message });
    },
  });

  await service.publishSessionProjection({
    type: "session_updated",
    at: "2026-05-13T00:00:00.000Z",
    sequence: 1,
    session_id: "session_1",
    source_event: { id: "event_1", type: "session_updated", at: "2026-05-13T00:00:00.000Z" },
    sessions: [],
    review_queue: [{
      id: "artifact:artifact_1",
      kind: "artifact",
      session_id: "session_1",
      title: "Architecture notes",
      producer: "agent://local/alice",
      required_action: "Review artifact",
      consequence: "Accept or request revision.",
      source_refs: [],
      trace_refs: [],
      actions: [],
      created_at: "2026-05-13T00:00:00.000Z",
    }],
    agent_workload: [],
    session: sessionProjection("session_1", "channel_1", "root_1"),
  } as any);
  const artifactPost = posts.find((post) => /Artifact ready/.test(String(post.body.message)));
  const actionUrl = artifactPost?.body.props.attachments?.[0]?.actions?.[0]?.integration.url;

  assert.ok(actionUrl);
  const parsed = new URL(actionUrl);
  assert.equal(`${parsed.origin}${parsed.pathname}`, "https://bridge.local/base/mattermost/action");
  const callbackToken = parsed.searchParams.get("kairos_callback_token") ?? "";
  assert.match(callbackToken, /^kcb1\./);
  assert.notEqual(callbackToken, "slash-secret");
  assert.equal(JSON.stringify(artifactPost).includes("slash-secret"), false);
});

test("Mattermost bridge generated dialog URLs carry signed callback tokens", async () => {
  const dialogCalls: any[] = [];
  const service = createService(fakeHumanNode().node, {
    bridge_public_url: "https://bridge.local/base/",
    slash_command_token: "slash-secret",
    fetch: async (_url: string | URL | Request, init?: RequestInit) => {
      dialogCalls.push(JSON.parse(String(init?.body)));
      return jsonResponse({ ok: true });
    },
  });

  const response = await service.handleAction({ ...actionPayload("request_revision", { session_id: "session_1", artifact_id: "artifact_1" }), trigger_id: "trigger_1" });

  assert.match(response.ephemeral_text ?? "", /Opening revision dialog/);
  assert.equal(dialogCalls.length, 1);
  const parsed = new URL(dialogCalls[0]?.url);
  assert.equal(`${parsed.origin}${parsed.pathname}`, "https://bridge.local/base/mattermost/dialog");
  assert.match(parsed.searchParams.get("kairos_callback_token") ?? "", /^kcb1\./);
  assert.notEqual(parsed.searchParams.get("kairos_callback_token"), "slash-secret");
});

test("Mattermost HTTP rejects callbacks from users outside the allowed user id list before session calls", async () => {
  const human = fakeHumanNode({
    create_session: { session_id: "session_1", session_uri: "session://session_1", state: { session: { status: "open" } } },
    resolve_approval: { session_id: "session_1", state: { approvals: {} } },
    request_revision: { session_id: "session_1", state: { artifacts: {} } },
  });
  const options = {
    human_node: human.node,
    session_manager_uri: "app://kairos/session-manager",
    mattermost_base_url: "https://mattermost.local",
    bot_token: "bot-secret",
    slash_command_token: "slash-secret",
    allowed_team_ids: ["team_1"],
    allowed_user_ids: ["user_allowed"],
  };
  const bridge = createMattermostBridge(options);
  const handleRequest = createMattermostBridgeFetchHandler(options, bridge.service);

  try {
    const url = "https://bridge.local";
    const actionCallbackToken = createMattermostCallbackToken("slash-secret", { path: "/mattermost/action" });
    const dialogCallbackToken = createMattermostCallbackToken("slash-secret", { path: "/mattermost/dialog" });
    const rejectedSlash = await postForm(handleRequest, `${url}/mattermost/slash`, { ...slashPayload("start Build something"), token: "slash-secret", user_id: "user_blocked" });
    assert.equal(rejectedSlash.status, 403);
    const slashBody = await rejectedSlash.json();
    assert.match(slashBody.text, /not allowed/i);
    assert.equal(JSON.stringify(slashBody).includes("user_blocked"), false);

    const rejectedAction = await postJson(
      handleRequest,
      `${url}/mattermost/action?kairos_callback_token=${encodeURIComponent(actionCallbackToken)}`,
      { ...actionPayload("approve", { session_id: "session_1", approval_id: "approval_1" }), user_id: "user_blocked" },
    );
    assert.equal(rejectedAction.status, 403);
    assert.equal(JSON.stringify(await rejectedAction.json()).includes("user_blocked"), false);

    const rejectedDialog = await postJson(
      handleRequest,
      `${url}/mattermost/dialog?kairos_callback_token=${encodeURIComponent(dialogCallbackToken)}`,
      { ...dialogPayload("request_revision", { session_id: "session_1", artifact_id: "artifact_1" }, { note: "Needs work" }), user_id: "user_blocked" },
    );
    assert.equal(rejectedDialog.status, 403);
    assert.equal(JSON.stringify(await rejectedDialog.json()).includes("user_blocked"), false);

    assert.deepEqual(human.actions(), []);
  } finally {
    await bridge.close().catch(() => undefined);
  }
});

test("Mattermost HTTP allows callbacks from configured allowed user ids", async () => {
  const human = fakeHumanNode({
    create_session: { session_id: "session_1", session_uri: "session://session_1", state: { session: { status: "open" } } },
    start_delegations: { session_id: "session_1", task_id: "task_1", delegation_ids: ["delegation_1"], mode: "parallel" },
    resolve_approval: { session_id: "session_1", state: { approvals: {} } },
  });
  const options = {
    human_node: human.node,
    session_manager_uri: "app://kairos/session-manager",
    mattermost_base_url: "https://mattermost.local",
    bot_token: "bot-secret",
    slash_command_token: "slash-secret",
    allowed_user_ids: ["user_1"],
    default_agents: ["agent://local/alice"],
  };
  const bridge = createMattermostBridge(options);
  const handleRequest = createMattermostBridgeFetchHandler(options, bridge.service);

  try {
    const url = "https://bridge.local";
    const actionCallbackToken = createMattermostCallbackToken("slash-secret", { path: "/mattermost/action" });
    const started = await postForm(handleRequest, `${url}/mattermost/slash`, { ...slashPayload("start Build something"), token: "slash-secret" });
    assert.equal(started.status, 200);

    const approved = await postJson(
      handleRequest,
      `${url}/mattermost/action?kairos_callback_token=${encodeURIComponent(actionCallbackToken)}`,
      actionPayload("approve", { session_id: "session_1", approval_id: "approval_1" }),
    );
    assert.equal(approved.status, 200);
    assert.deepEqual(human.actions(), ["create_session", "start_delegations", "resolve_approval"]);
  } finally {
    await bridge.close().catch(() => undefined);
  }
});

test("Mattermost bridge publishes dashboard session projections by creating then updating a compact post", async () => {
  const posts: Array<{ url: string; body: any }> = [];
  const human = fakeHumanNode();
  const service = createService(human.node, {
    fetch: async (url: string | URL | Request, init?: RequestInit) => {
      posts.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return jsonResponse({ id: "post_1", channel_id: "channel_1", message: "posted" });
    },
  });

  const event = {
    type: "session_updated",
    at: "2026-05-13T00:00:00.000Z",
    sequence: 1,
    session_id: "session_1",
    source_event: { id: "event_1", type: "session_updated", at: "2026-05-13T00:00:00.000Z" },
    sessions: [],
    review_queue: [],
    agent_workload: [],
    session: {
      session_id: "session_1",
      title: "Mattermost project",
      acceptance_criteria: [],
      phase: "open",
      phase_label: "Open",
      phase_reason: "Manual session",
      owner: "agent://human/mattermost",
      status: "open",
      agents: [],
      blockers: [],
      actions: [],
      origin: { kind: "external", uri: "mattermost://team/team_1/channel/channel_1/post/root_1", label: "Mattermost post" },
      source_refs: [],
      trace_refs: [],
    },
  } as any;
  const response = await service.publishSessionProjection(event);
  await service.publishSessionProjection({ ...event, sequence: 2 });

  assert.equal(response?.response_type, "ephemeral");
  assert.equal(posts.length, 2);
  assert.equal(posts[0]?.url, "https://mattermost.local/api/v4/posts");
  assert.equal(posts[0]?.body.channel_id, "channel_1");
  assert.equal(posts[0]?.body.root_id, "root_1");
  assert.match(posts[0]?.body.message, /Project status/);
  assert.equal(posts[1]?.url, "https://mattermost.local/api/v4/posts/post_1");
  assert.equal(posts[1]?.body.id, "post_1");
  assert.match(posts[1]?.body.message, /Project status/);
});

test("Mattermost bridge projects every session in dashboard snapshots and updates mapped posts", async () => {
  const posts: Array<{ url: string; body: any }> = [];
  const createdIds = ["post_1", "post_2"];
  const service = createService(fakeHumanNode().node, {
    fetch: async (url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      posts.push({ url: String(url), body });
      const id = body.id ?? createdIds.shift() ?? "post_next";
      return jsonResponse({ id, channel_id: body.channel_id, message: body.message });
    },
  });

  const snapshot = {
    type: "dashboard_snapshot",
    at: "2026-05-13T00:00:00.000Z",
    sequence: 1,
    sessions: [
      sessionProjection("session_1", "channel_1", "root_1"),
      sessionProjection("session_2", "channel_2", "root_2"),
    ],
    review_queue: [],
    agent_workload: [],
  } as any;

  await service.publishSessionProjection(snapshot);
  await service.publishSessionProjection({ ...snapshot, sequence: 2 });
  await service.publishSessionProjection({
    type: "session_updated",
    at: "2026-05-13T00:00:01.000Z",
    sequence: 3,
    session_id: "session_2",
    source_event: { id: "event_2", type: "session_updated", at: "2026-05-13T00:00:01.000Z" },
    sessions: [],
    review_queue: [],
    agent_workload: [],
    session: sessionProjection("session_2", "channel_2", "root_2"),
  } as any);

  assert.deepEqual(posts.map((post) => post.url), [
    "https://mattermost.local/api/v4/posts",
    "https://mattermost.local/api/v4/posts",
    "https://mattermost.local/api/v4/posts/post_1",
    "https://mattermost.local/api/v4/posts/post_2",
    "https://mattermost.local/api/v4/posts/post_2",
  ]);
  assert.equal(posts[0]?.body.channel_id, "channel_1");
  assert.equal(posts[1]?.body.channel_id, "channel_2");
  assert.equal(posts[2]?.body.id, "post_1");
  assert.equal(posts[3]?.body.id, "post_2");
  assert.equal(posts[4]?.body.id, "post_2");
});

test("Mattermost bridge does not create duplicate projection posts for non-stale update failures", async () => {
  const posts: Array<{ url: string; body: any }> = [];
  const service = createService(fakeHumanNode().node, {
    fetch: async (url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      posts.push({ url: String(url), body });
      if (String(url).endsWith("/api/v4/posts/post_1")) {
        return new Response("database_password=SECRET", { status: 500, statusText: "Internal Server Error" });
      }
      return jsonResponse({ id: "post_1", channel_id: body.channel_id, message: body.message });
    },
  });

  const event = {
    type: "session_updated",
    at: "2026-05-13T00:00:00.000Z",
    sequence: 1,
    session_id: "session_1",
    source_event: { id: "event_1", type: "session_updated", at: "2026-05-13T00:00:00.000Z" },
    sessions: [],
    review_queue: [],
    agent_workload: [],
    session: sessionProjection("session_1", "channel_1", "root_1"),
  } as any;

  await service.publishSessionProjection(event);
  await assert.rejects(service.publishSessionProjection({ ...event, sequence: 2 }), MattermostRestError);

  assert.deepEqual(posts.map((post) => post.url), [
    "https://mattermost.local/api/v4/posts",
    "https://mattermost.local/api/v4/posts/post_1",
  ]);
});

test("Mattermost bridge disables projection updates when editing a mapped post is forbidden", async () => {
  const posts: Array<{ url: string; body: any }> = [];
  let nextPostId = 1;
  const service = createService(fakeHumanNode().node, {
    fetch: async (url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      posts.push({ url: String(url), body });
      if (String(url).endsWith("/api/v4/posts/post_1")) {
        return new Response("missing edit_post permission", { status: 403, statusText: "Forbidden" });
      }
      return jsonResponse({ id: body.id ?? `post_${nextPostId++}`, channel_id: body.channel_id, message: body.message });
    },
  });

  const event = {
    type: "session_updated",
    at: "2026-05-13T00:00:00.000Z",
    sequence: 1,
    session_id: "session_1",
    source_event: { id: "event_1", type: "session_updated", at: "2026-05-13T00:00:00.000Z" },
    sessions: [],
    review_queue: [],
    agent_workload: [],
    session: sessionProjection("session_1", "channel_1", "root_1"),
  } as any;

  await service.publishSessionProjection(event);
  await assert.rejects(service.publishSessionProjection({ ...event, sequence: 2 }), MattermostRestError);
  await service.publishSessionProjection({ ...event, sequence: 3 });

  assert.deepEqual(posts.map((post) => post.url), [
    "https://mattermost.local/api/v4/posts",
    "https://mattermost.local/api/v4/posts/post_1",
  ]);
});

test("Mattermost bridge creates one replacement projection post when a mapped post is gone", async () => {
  const posts: Array<{ url: string; body: any }> = [];
  let nextPostId = 1;
  const service = createService(fakeHumanNode().node, {
    fetch: async (url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      posts.push({ url: String(url), body });
      if (String(url).endsWith("/api/v4/posts/post_1")) {
        return new Response("post is gone", { status: 404, statusText: "Not Found" });
      }
      return jsonResponse({ id: body.id ?? `post_${nextPostId++}`, channel_id: body.channel_id, message: body.message });
    },
  });

  const event = {
    type: "session_updated",
    at: "2026-05-13T00:00:00.000Z",
    sequence: 1,
    session_id: "session_1",
    source_event: { id: "event_1", type: "session_updated", at: "2026-05-13T00:00:00.000Z" },
    sessions: [],
    review_queue: [],
    agent_workload: [],
    session: sessionProjection("session_1", "channel_1", "root_1"),
  } as any;

  await service.publishSessionProjection(event);
  await service.publishSessionProjection({ ...event, sequence: 2 });
  await service.publishSessionProjection({ ...event, sequence: 3 });

  assert.deepEqual(posts.map((post) => post.url), [
    "https://mattermost.local/api/v4/posts",
    "https://mattermost.local/api/v4/posts/post_1",
    "https://mattermost.local/api/v4/posts",
    "https://mattermost.local/api/v4/posts/post_2",
  ]);
  assert.equal(posts[2]?.body.channel_id, "channel_1");
  assert.equal(posts[2]?.body.root_id, "root_1");
  assert.equal(posts[3]?.body.id, "post_2");
});

test("Mattermost HTTP serves trace and artifact bridge links instead of returning 404", async () => {
  const options = {
    human_node: fakeHumanNode().node,
    session_manager_uri: "app://kairos/session-manager",
    mattermost_base_url: "https://mattermost.local",
    bot_token: "bot-secret",
    slash_command_token: "slash-secret",
  };
  const bridge = createMattermostBridge(options);
  const handleRequest = createMattermostBridgeFetchHandler(options, bridge.service);

  try {
    const trace = await handleRequest(new Request("https://bridge.local/trace/session_1"));
    assert.equal(trace.status, 200);
    assert.match(trace.headers.get("content-type") ?? "", /text\/html/);
    assert.match(await trace.text(), /session_1/);

    const artifact = await handleRequest(new Request("https://bridge.local/artifacts/artifact_1"));
    assert.equal(artifact.status, 200);
    assert.match(artifact.headers.get("content-type") ?? "", /text\/html/);
    assert.match(await artifact.text(), /artifact_1/);
  } finally {
    await bridge.close().catch(() => undefined);
  }
});

test("Mattermost bridge records sanitized projection delivery errors in IPC status", async () => {
  const ipc = createContext();
  const bridge = createMattermostBridge({
    uri: "app://kairos/mattermost-bridge-error-status-test",
    human_node: fakeHumanNode().node,
    session_manager_uri: "app://kairos/session-manager",
    mattermost_base_url: "https://mattermost.local",
    bot_token: "bot-secret",
    slash_command_token: "slash-secret",
    fetch: async () => new Response("database_password=SECRET", { status: 403, statusText: "Forbidden" }),
  });
  const emitter = createNode("test://mattermost/projection-emitter");

  try {
    await bridge.node.connect(ipc.createTransport("bridge-error-status"));
    await emitter.connect(ipc.createTransport("emitter-error-status"));

    emitter.emit("app://kairos/mattermost-bridge-error-status-test", "dashboard", {
      mime_type: KAIROS_DASHBOARD_EVENT_MIME,
      data: {
        type: "session_updated",
        at: "2026-05-13T00:00:00.000Z",
        sequence: 1,
        session_id: "session_1",
        source_event: { id: "event_1", type: "session_updated", at: "2026-05-13T00:00:00.000Z" },
        sessions: [],
        review_queue: [],
        agent_workload: [],
        session: sessionProjection("session_1", "channel_1", "root_1"),
      },
    });

    let status: any;
    await waitForAsync(async () => {
      status = await emitter.call("app://kairos/mattermost-bridge-error-status-test", "status", {
        mime_type: "application/json",
        data: {},
      });
      return status.data.projection_error_count === 1;
    });

    assert.equal(status.data.last_projection_error.includes("SECRET"), false);
    assert.equal(status.data.last_projection_error.includes("database_password"), false);
    assert.match(status.data.last_projection_error, /Mattermost PUT|Mattermost POST|projection/i);
  } finally {
    await bridge.close().catch(() => undefined);
    await emitter.close().catch(() => undefined);
  }
});

test("Mattermost bridge projection subscription start is idempotent and close unsubscribes once", async () => {
  const ipc = createContext();
  const human = fakeHumanNode().node;
  const sessionManager = createNode("app://kairos/session-manager");
  const calls: string[] = [];
  sessionManager.action("subscribe_dashboard", async () => {
    calls.push("subscribe_dashboard");
    return { mime_type: "application/json", data: { ok: true } };
  });
  sessionManager.action("unsubscribe_dashboard", async () => {
    calls.push("unsubscribe_dashboard");
    return { mime_type: "application/json", data: { ok: true } };
  });
  const bridge = createMattermostBridge({
    uri: "app://kairos/mattermost-bridge-subscription-test",
    human_node: human,
    session_manager_uri: "app://kairos/session-manager",
    mattermost_base_url: "https://mattermost.local",
    bot_token: "bot-secret",
    slash_command_token: "slash-secret",
  });

  try {
    await sessionManager.connect(ipc.createTransport("session-subscription"));
    await bridge.node.connect(ipc.createTransport("bridge-subscription"));

    await Promise.all([bridge.startProjectionSubscription(), bridge.startProjectionSubscription()]);
    await bridge.startProjectionSubscription();
    await bridge.close();
    await bridge.close();

    assert.deepEqual(calls, ["subscribe_dashboard", "unsubscribe_dashboard"]);
  } finally {
    await bridge.close().catch(() => undefined);
    await sessionManager.close().catch(() => undefined);
  }
});

test("Mattermost bridge subscribes through its node and publishes real dashboard events to Mattermost", async () => {
  const ipc = createContext();
  const human = createNode("human://user/mattermost-projection-test");
  const sessionManager = createSessionManager({ uri: "app://kairos/session-manager" });
  const posts: Array<{ url: string; body: any }> = [];
  let nextPostId = 1;
  const bridge = createMattermostBridge({
    uri: "app://kairos/mattermost-bridge-test",
    human_node: human,
    session_manager_uri: "app://kairos/session-manager",
    mattermost_base_url: "https://mattermost.local",
    bot_token: "bot-secret",
    slash_command_token: "slash-secret",
    bridge_public_url: "https://bridge.local",
    fetch: async (url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      posts.push({ url: String(url), body });
      return jsonResponse({ id: body.id ?? `post_${nextPostId++}`, channel_id: body.channel_id, message: body.message });
    },
  });

  try {
    await human.connect(ipc.createTransport("human-mattermost-projection"));
    await sessionManager.node.connect(ipc.createTransport("session-mattermost-projection"));
    await bridge.node.connect(ipc.createTransport("bridge-mattermost-projection"));

    await bridge.startProjectionSubscription();
    await human.call("app://kairos/session-manager", "create_session", {
      mime_type: "application/json",
      data: {
        session_id: "session_mattermost_projection",
        title: "Mattermost projection",
        objective: "Publish dashboard events into Mattermost posts.",
        source_ref: {
          kind: "external",
          uri: "mattermost://team/team_1/channel/channel_1/post/root_1",
          label: "Mattermost post",
        },
      },
    });
    await waitFor(() => posts.some((post) => post.url === "https://mattermost.local/api/v4/posts" && post.body.root_id === "root_1"));

    const projectCreate = posts.find((post) => post.url === "https://mattermost.local/api/v4/posts" && post.body.root_id === "root_1");
    assert.ok(projectCreate);
    assert.match(projectCreate.body.message, /Project status/);
    assert.equal(projectCreate.body.props.kairos.session_id, "session_mattermost_projection");

    await human.call("app://kairos/session-manager", "request_approval", {
      mime_type: "application/json",
      data: {
        session_id: "session_mattermost_projection",
        requester: "agent://local/alice",
        tool_endpoint: "plugin://local/workspace",
        action: "edit",
        risk: "medium",
        payload_summary: "Update Mattermost bridge projection wiring.",
        source_refs: [{ kind: "external", uri: "mattermost://team/team_1/channel/channel_1/post/root_1", label: "Mattermost post" }],
      },
    });

    await waitFor(() => posts.some((post) => /Approval needed/.test(String(post.body.message))));
    await waitFor(() => posts.some((post) => post.url === "https://mattermost.local/api/v4/posts/post_1"));

    const approvalCreate = posts.find((post) => /Approval needed/.test(String(post.body.message)));
    assert.ok(approvalCreate);
    assert.equal(approvalCreate.body.channel_id, "channel_1");
    assert.equal(approvalCreate.body.root_id, "root_1");
    assert.equal(approvalCreate.body.props.kairos.session_id, "session_mattermost_projection");
    assert.equal(approvalCreate.body.props.kairos.card, "approval");
    assert.deepEqual(approvalCreate.body.props.attachments[0]?.actions?.map((action: any) => action.name), ["Approve", "Reject"]);
    assert.match(new URL(approvalCreate.body.props.attachments[0]?.actions?.[0]?.integration?.url).searchParams.get("kairos_callback_token") ?? "", /^kcb1\./);

    const projectUpdate = posts.find((post) => post.url === "https://mattermost.local/api/v4/posts/post_1");
    assert.ok(projectUpdate);
    assert.equal(projectUpdate.body.id, "post_1");
    assert.match(projectUpdate.body.message, /Project status/);
  } finally {
    await bridge.close().catch(() => undefined);
    await human.close().catch(() => undefined);
    await sessionManager.node.close().catch(() => undefined);
  }
});

test("Mattermost HTTP routes validate callbacks and return Mattermost JSON responses", async () => {
  const human = fakeHumanNode({
    create_session: { session_id: "session_1", session_uri: "session://session_1", state: { session: { status: "open" } } },
    start_delegations: { session_id: "session_1", task_id: "task_1", delegation_ids: ["delegation_1"], mode: "parallel" },
    resolve_approval: { session_id: "session_1", state: { approvals: {} } },
    request_revision: { session_id: "session_1", state: { artifacts: {} } },
  });
  const options = {
    human_node: human.node,
    session_manager_uri: "app://kairos/session-manager",
    mattermost_base_url: "https://mattermost.local",
    bot_token: "bot-secret",
    slash_command_token: "slash-secret",
    allowed_team_ids: ["team_1"],
    allowed_origins: ["https://mattermost.local"],
    max_json_body_bytes: 512,
    agent_aliases: { alice: "agent://local/alice" },
  };
  const bridge = createMattermostBridge(options);
  const handleRequest = createMattermostBridgeFetchHandler(options, bridge.service);

  try {
    const url = "https://bridge.local";
    const actionCallbackToken = createMattermostCallbackToken("slash-secret", { path: "/mattermost/action" });
    const dialogCallbackToken = createMattermostCallbackToken("slash-secret", { path: "/mattermost/dialog" });

    const health = await handleRequest(new Request(`${url}/health`));
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true });

    const unknown = await handleRequest(new Request(`${url}/missing`));
    assert.equal(unknown.status, 404);
    assert.match((await unknown.json()).text, /not found/i);

    const rejectedToken = await postForm(handleRequest, `${url}/mattermost/slash`, { ...slashPayload("start alice Review auth"), token: "wrong" });
    assert.equal(rejectedToken.status, 401);
    assert.match((await rejectedToken.json()).text, /unauthorized/i);

    const rejectedActionToken = await postJson(handleRequest, `${url}/mattermost/action`, actionPayload("approve", { session_id: "session_1", approval_id: "approval_1" }), {
      origin: "https://mattermost.local",
    });
    assert.equal(rejectedActionToken.status, 401);
    assert.deepEqual(await rejectedActionToken.json(), { error: { message: "Unauthorized Mattermost callback." } });

    const rejectedDialogToken = await postJson(handleRequest, `${url}/mattermost/dialog`, dialogPayload("request_revision", { session_id: "session_1", artifact_id: "artifact_1" }, { note: "Needs work" }), {
      origin: "https://mattermost.local",
    });
    assert.equal(rejectedDialogToken.status, 401);
    assert.match(JSON.stringify(await rejectedDialogToken.json()), /unauthorized/i);

    const rejectedTeam = await postJson(handleRequest, `${url}/mattermost/action`, actionPayload("approve", { session_id: "session_1", approval_id: "approval_1" }), {
      origin: "https://mattermost.local",
      authorization: "Token slash-secret",
      team_id: "team_2",
    });
    assert.equal(rejectedTeam.status, 403);
    assert.deepEqual(await rejectedTeam.json(), { error: { message: "Mattermost team is not allowed." } });

    const strictOriginRequest = await postJson(
      createMattermostBridgeFetchHandler({ ...options, require_origin: true }, bridge.service),
      `${url}/mattermost/action`,
      actionPayload("approve", { session_id: "session_1", approval_id: "approval_1" }),
      { authorization: "Token slash-secret" },
    );
    assert.equal(strictOriginRequest.status, 403);
    assert.deepEqual(await strictOriginRequest.json(), { error: { message: "Origin is not allowed." } });

    const tooLarge = await handleRequest(new Request(`${url}/mattermost/action`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://mattermost.local", authorization: "Token slash-secret" },
      body: JSON.stringify({ ...actionPayload("approve", { session_id: "session_1", approval_id: "approval_1" }), padding: "x".repeat(600) }),
    }));
    assert.equal(tooLarge.status, 413);
    assert.deepEqual(await tooLarge.json(), { error: { message: "Callback body is too large." } });

    const tooLargeWithoutLength = await handleRequest(new Request(`${url}/mattermost/action`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://mattermost.local", authorization: "Token slash-secret" },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(JSON.stringify({ ...actionPayload("approve", { session_id: "session_1", approval_id: "approval_1" }), padding: "x".repeat(600) })));
          controller.close();
        },
      }),
    }));
    assert.equal(tooLargeWithoutLength.status, 413);
    assert.deepEqual(await tooLargeWithoutLength.json(), { error: { message: "Callback body is too large." } });

    const malformedPath = await handleRequest(new Request(`${url}/mattermost/%E0%A4%A`));
    assert.equal(malformedPath.status, 400);
    assert.match((await malformedPath.json()).text, /invalid request path/i);

    const started = await postForm(
      handleRequest,
      `${url}/mattermost/slash`,
      { ...slashPayload("start alice Review auth") },
      { authorization: "Token slash-secret", origin: "https://mattermost.local" },
    );
    assert.equal(started.status, 200);
    const startedBody = await started.json();
    assert.equal(startedBody.response_type, "ephemeral");
    assert.match(startedBody.text, /Kairos session started/);

    const resolved = await postJson(
      handleRequest,
      `${url}/mattermost/action?kairos_callback_token=${encodeURIComponent(actionCallbackToken)}`,
      actionPayload("approve", { session_id: "session_1", approval_id: "approval_1" }),
      { origin: "https://mattermost.local" },
    );
    assert.equal(resolved.status, 200);
    assert.deepEqual(await resolved.json(), { ephemeral_text: "Approval approved.", skip_slack_parsing: true });

    const dialog = await postJson(
      handleRequest,
      `${url}/mattermost/dialog?kairos_callback_token=${encodeURIComponent(dialogCallbackToken)}`,
      dialogPayload("request_revision", { session_id: "session_1", artifact_id: "artifact_1" }, { note: "Needs work" }),
      { origin: "https://mattermost.local" },
    );
    assert.equal(dialog.status, 200);
    assert.deepEqual(await dialog.json(), {});

    const resolvedWithContextToken = await postJson(
      handleRequest,
      `${url}/mattermost/action`,
      actionPayload("approve", { session_id: "session_1", approval_id: "approval_2", kairos_callback_token: actionCallbackToken }),
      { origin: "https://mattermost.local" },
    );
    assert.equal(resolvedWithContextToken.status, 200);
    assert.deepEqual(await resolvedWithContextToken.json(), { ephemeral_text: "Approval approved.", skip_slack_parsing: true });

    const dialogWithStateToken = await postJson(
      handleRequest,
      `${url}/mattermost/dialog`,
      dialogPayload("request_revision", { session_id: "session_1", artifact_id: "artifact_2", kairos_callback_token: dialogCallbackToken }, { note: "Needs work" }),
      { origin: "https://mattermost.local" },
    );
    assert.equal(dialogWithStateToken.status, 200);
    assert.deepEqual(await dialogWithStateToken.json(), {});

    const rejectedWrongQueryToken = await postJson(
      handleRequest,
      `${url}/mattermost/action?kairos_callback_token=wrong`,
      actionPayload("approve", { session_id: "session_1", approval_id: "approval_3" }),
      { origin: "https://mattermost.local" },
    );
    assert.equal(rejectedWrongQueryToken.status, 401);
    assert.deepEqual(await rejectedWrongQueryToken.json(), { error: { message: "Unauthorized Mattermost callback." } });

    const rejectedRawContextToken = await postJson(
      handleRequest,
      `${url}/mattermost/action`,
      actionPayload("approve", { session_id: "session_1", approval_id: "approval_4", kairos_callback_token: "slash-secret" }),
      { origin: "https://mattermost.local" },
    );
    assert.equal(rejectedRawContextToken.status, 401);

    const expiredActionToken = createMattermostCallbackToken("slash-secret", { path: "/mattermost/action", ttl_ms: -1 });
    const rejectedExpiredToken = await postJson(
      handleRequest,
      `${url}/mattermost/action?kairos_callback_token=${encodeURIComponent(expiredActionToken)}`,
      actionPayload("approve", { session_id: "session_1", approval_id: "approval_5" }),
      { origin: "https://mattermost.local" },
    );
    assert.equal(rejectedExpiredToken.status, 401);

    const rejectedPathMismatchToken = await postJson(
      handleRequest,
      `${url}/mattermost/action?kairos_callback_token=${encodeURIComponent(dialogCallbackToken)}`,
      actionPayload("approve", { session_id: "session_1", approval_id: "approval_6" }),
      { origin: "https://mattermost.local" },
    );
    assert.equal(rejectedPathMismatchToken.status, 401);

    assert.deepEqual(human.actions(), ["create_session", "start_delegations", "resolve_approval", "request_revision", "resolve_approval", "request_revision"]);
  } finally {
    await bridge.close().catch(() => undefined);
  }
});

test("Mattermost action errors use safe interactive response bodies", async () => {
  const human = fakeHumanNode({ resolve_approval: new Error("database_password=SECRET stack /private/tmp/internal.ts:42") });
  const service = createService(human.node);
  const response = await service.handleAction(actionPayload("approve", { session_id: "session_1", approval_id: "approval_1" }));

  assert.deepEqual(response, { error: { message: "The request could not be completed." } });
  assert.equal(JSON.stringify(response).includes("SECRET"), false);
  assert.equal(JSON.stringify(response).includes("/private/tmp"), false);
});

test("Mattermost bridge close is idempotent and prevents listen after close", async () => {
  const bridge = createMattermostBridge({
    human_node: fakeHumanNode().node,
    session_manager_uri: "app://kairos/session-manager",
    mattermost_base_url: "https://mattermost.local",
    bot_token: "bot-secret",
    slash_command_token: "slash-secret",
  });

  await bridge.close();
  await bridge.close();
  await assert.rejects(bridge.listen({ port: 0 }), /closed/);
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

function headerValue(headers: RequestInit["headers"], name: string): string | null {
  return new Headers(headers).get(name);
}

function postForm(handleRequest: (request: Request) => Promise<Response>, url: string, body: Record<string, string | undefined>, headers: Record<string, string> = {}): Promise<Response> {
  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(body)) {
    if (value !== undefined) form.set(key, value);
  }
  return handleRequest(new Request(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: form,
  }));
}

function postJson(handleRequest: (request: Request) => Promise<Response>, url: string, body: Record<string, unknown>, options: { authorization?: string; origin?: string; team_id?: string } = {}): Promise<Response> {
  return handleRequest(new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...(options.authorization ? { authorization: options.authorization } : {}), ...(options.origin ? { origin: options.origin } : {}) },
    body: JSON.stringify(options.team_id ? { ...body, team_id: options.team_id } : body),
  }));
}

function createService(humanNode: IpcNode, overrides: Record<string, unknown> = {}) {
  return createMattermostBridgeService({
    human_node: humanNode,
    session_manager_uri: "app://kairos/session-manager",
    mattermost_base_url: "https://mattermost.local",
    bot_token: "bot-secret",
    bridge_public_url: "https://bridge.local",
    ...overrides,
  });
}

function fakeHumanNode(responses: Record<string, unknown> = {}) {
  const calls: Array<{ target: string; action: string; data: any }> = [];
  const node = {
    async call(target: string, action: string, payload: { data: unknown }) {
      calls.push({ target, action, data: payload.data });
      if (action in responses) {
        if (responses[action] instanceof Error) throw responses[action];
        return { mime_type: "application/json", data: responses[action] };
      }
      throw new Error(`unexpected action: ${action}`);
    },
  } as unknown as IpcNode;
  return { node, calls, actions: () => calls.map((call) => call.action) };
}

function slashPayload(text: string, overrides: Partial<Record<string, string>> = {}) {
  return {
    token: "slash-token",
    team_id: "team_1",
    channel_id: "channel_1",
    user_id: "user_1",
    command: "/kairos",
    text,
    ...overrides,
  };
}

function actionPayload(action: string, context: Record<string, unknown>) {
  return {
    user_id: "user_1",
    team_id: "team_1",
    channel_id: "channel_1",
    post_id: "post_1",
    context: { action, ...context },
  };
}

function dialogPayload(action: string, context: Record<string, unknown>, submission: Record<string, string>) {
  return {
    user_id: "user_1",
    team_id: "team_1",
    channel_id: "channel_1",
    post_id: "post_1",
    callback_id: action,
    state: JSON.stringify({ action, ...context }),
    submission,
  };
}

function sessionProjection(sessionId: string, channelId: string, rootId: string) {
  return {
    session_id: sessionId,
    title: `Mattermost project ${sessionId}`,
    acceptance_criteria: [],
    phase: "open",
    phase_label: "Open",
    phase_reason: "Manual session",
    owner: "agent://human/mattermost",
    status: "open",
    agents: [],
    blockers: [],
    actions: [],
    origin: { kind: "external", uri: `mattermost://team/team_1/channel/${channelId}/post/${rootId}`, label: "Mattermost post" },
    source_refs: [],
    trace_refs: [],
  };
}

function createContext() {
  const dir = mkdtempSync(join("/tmp", "kairos-ipc-mattermost-bridge-test-"));
  const tracePath = join(dir, "trace.jsonl");
  const registry = new EndpointRegistry();
  const trace = new TraceWriter(tracePath);
  const router = new Router({ registry, capabilityGate: new AllowAllCapabilityGate(), trace });

  return {
    tracePath,
    createTransport(id: string): IpcTransport {
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

async function waitFor(condition: () => boolean, timeoutMs = 1000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function waitForAsync(condition: () => Promise<boolean>, timeoutMs = 1000): Promise<void> {
  const started = Date.now();
  while (!(await condition())) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
