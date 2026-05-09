import { z } from "../../sdk/src/index.ts";

const endpointUriSchema = z.string().min(1).describe("Kairos IPC endpoint URI.");
const idSchema = z.string().min(1);

const sourceRefSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("channel_message"),
    channel: endpointUriSchema,
    message_id: idSchema,
  }),
  z.object({
    kind: z.literal("artifact"),
    artifact_id: idSchema,
  }),
  z.object({
    kind: z.literal("ipc_envelope"),
    trace_id: idSchema.optional(),
    correlation_id: idSchema.optional(),
    msg_id: idSchema.optional(),
  }),
  z.object({
    kind: z.literal("file"),
    uri: idSchema,
    version: z.string().optional(),
  }),
  z.object({
    kind: z.literal("external"),
    uri: idSchema,
    label: z.string().optional(),
  }),
]).describe("Reference to source material in the collaboration session.");

const traceRefSchema = z.object({
  trace_id: idSchema.optional(),
  correlation_id: idSchema.optional(),
  msg_id: idSchema.optional(),
  endpoint: endpointUriSchema.optional(),
  action: z.string().optional(),
  label: idSchema,
  severity: z.enum(["info", "warning", "error"]).optional(),
  object_ref: z.string().optional(),
}).describe("Reference to IPC trace evidence.");

const artifactStatusSchema = z.enum(["draft", "submitted", "accepted", "superseded", "rejected", "revision_requested"]);
const artifactKindSchema = z.enum(["evaluation", "summary", "research_note", "patch", "decision_record", "question_answer", "validation_result", "final_synthesis"]);

const commonArtifactFields = {
  id: idSchema.optional(),
  session_id: idSchema.optional(),
  title: z.string().optional(),
  status: artifactStatusSchema.optional(),
  relates_to: z.array(idSchema).optional(),
  supersedes: idSchema.optional(),
  source_refs: z.array(sourceRefSchema).optional(),
  trace_refs: z.array(traceRefSchema).optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
} as const;

const submittedArtifactSchema = z.object({
  ...commonArtifactFields,
  author: endpointUriSchema,
  kind: artifactKindSchema,
  content: z.unknown().describe("Durable artifact body. Markdown is allowed here."),
}).passthrough().describe("Durable deliverable submitted by an agent.");

const answerArtifactSchema = z.object({
  ...commonArtifactFields,
  author: endpointUriSchema,
  kind: artifactKindSchema.optional(),
  content: z.unknown().describe("Question answer body. Markdown is allowed here."),
}).passthrough().describe("Optional durable answer artifact.");

export const sessionManagerSessionSnapshotSchema = z.object({
  session_id: idSchema,
  session_uri: endpointUriSchema,
  events: z.array(z.unknown()),
  state: z.unknown(),
  compactions: z.array(z.unknown()),
}).describe("Current collaboration session snapshot.");

export const sessionManagerSubmitArtifactRequestSchema = z.object({
  session_id: idSchema.describe("Collaboration session id."),
  delegation_id: idSchema.optional().describe("Delegation this artifact completes."),
  artifact: submittedArtifactSchema,
  project: z.boolean().optional().describe("When false, store without projecting a compact IM artifact row."),
}).describe("Submit a durable artifact to a collaboration session.");

export const sessionManagerAskQuestionRequestSchema = z.object({
  session_id: idSchema.describe("Collaboration session id."),
  to: endpointUriSchema.describe("Endpoint that should answer the question."),
  from: endpointUriSchema.optional().describe("Question author. Defaults to the calling endpoint."),
  question: z.string().min(1).describe("Question text."),
  about_refs: z.array(sourceRefSchema).optional().describe("Source refs the question is about."),
}).describe("Ask a structured question inside a collaboration session.");

export const sessionManagerAskQuestionResultSchema = z.object({
  question: z.unknown(),
  delegation_id: idSchema.optional(),
}).describe("Created question and optional answering delegation.");

export const sessionManagerAnswerQuestionRequestSchema = z.object({
  session_id: idSchema.describe("Collaboration session id."),
  question_id: idSchema.describe("Question id to answer."),
  artifact: answerArtifactSchema.optional(),
  answer: z.string().optional().describe("Plain answer text used when no artifact is supplied."),
  project: z.boolean().optional().describe("When false, store without projecting a compact IM artifact row."),
}).describe("Answer a structured collaboration question.");

export const sessionManagerReportMessageRequestSchema = z.object({
  session_id: idSchema.describe("Collaboration session id."),
  text: z.string().trim().min(1).describe("Brief IM status pulse. Human-visible text must stay under the session-manager runtime limit."),
  delegation_id: idSchema.optional().describe("Delegation this status belongs to."),
  to: z.array(endpointUriSchema).optional().describe("Target agents for agent-visible coordination notes."),
  visibility: z.enum(["human", "agents", "all"]).optional().describe("Audience for this note. Defaults to human unless to is set."),
  source_refs: z.array(sourceRefSchema).optional(),
  project: z.boolean().optional().describe("When false, record the note without projecting it into IM."),
}).describe("Send a brief IM status pulse before final agent output.");

export const sessionManagerReportMessageResultSchema = z.object({
  session_id: idSchema,
  note: z.unknown(),
  projected_message_id: idSchema.optional(),
}).describe("Recorded collaboration note and optional projected IM message id.");

export const sessionManagerRecordDecisionRequestSchema = z.object({
  session_id: idSchema.describe("Collaboration session id."),
  decision: z.unknown().describe("Structured decision payload."),
  source_refs: z.array(sourceRefSchema).optional(),
  trace_refs: z.array(traceRefSchema).optional(),
  decider: endpointUriSchema.optional().describe("Decision maker. Defaults to session reducer policy when omitted."),
  relates_to: z.array(idSchema).optional(),
  supersedes: idSchema.optional(),
}).describe("Record a durable collaboration decision.");
