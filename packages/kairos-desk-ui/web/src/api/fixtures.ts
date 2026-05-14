import type { DeskSnapshot, PatchSetProjection } from "./types";

const fibonacciRequirementMarkdown = `# Fibonacci CLI requirement note

Alice captured the current product constraint before implementation starts. This draft is intentionally longer than a room reply so the Artifact Reader can prove that outline navigation, source references, and trace links all stay usable as the artifact grows.

## Summary

Build a small command-line program that prints Fibonacci numbers with predictable behavior. The first pass should optimize for correctness, testability, and a narrow surface area rather than clever recursion or a reusable library shape.

### Recommended path

Use an iterative CLI with O(n) time and O(1) memory. It is easy for Alice to implement, easy for Cindy to review, and easy for the human reviewer to validate from terminal output.

### Non-goals

- Do not build a package API unless the next session explicitly asks for reuse.
- Do not optimize with matrix exponentiation in the first pass.
- Do not accept negative input silently.

## User request

The user asked for a Fibonacci program, then asked whether the implementation shape should be decided before the build starts. This artifact records the decision surface so the room does not have to carry the full Markdown report.

### Room evidence

The relevant room messages are the human request, Alice's short summary, and the draft artifact projection. The source refs in the reader should open those messages without making the source list look like another action panel.

### Agent interpretation

Alice interpreted the request as a build task with one human decision in front of it. Cindy is waiting for an implementation artifact before reviewing edge cases and test coverage.

## Implementation shape

Choose one implementation shape before code is written.

### Option A: Iterative CLI

Iterative CLI is the recommended path. It keeps the command behavior direct, avoids stack growth, and gives tests a simple set of expected outputs.

#### Complexity

- Time: O(n)
- Memory: O(1)
- Fit: best first implementation

#### Review impact

Cindy can verify the loop, input parsing, invalid input handling, and output format without reviewing unnecessary abstractions.

### Option B: Recursive example

Recursive implementation is compact, but it becomes unsafe for larger inputs and makes performance behavior harder to explain. It is useful as a teaching snippet, not as the default build output.

### Option C: Memoized library function

Memoization keeps O(n) time, but it adds API shape and storage behavior that the first user request did not ask for. It can become a follow-up artifact if the CLI later needs library reuse.

## Acceptance checks

1. CLI accepts a non-negative integer.
2. Output is deterministic.
3. Tests cover zero, one, normal values, and invalid input.
4. Error output is understandable in an interactive terminal.
5. The final artifact links back to test output and IPC trace evidence.

### Input cases

| Input | Expected result | Notes |
| --- | --- | --- |
| 0 | 0 | Base case |
| 1 | 1 | Base case |
| 7 | 13 | Normal path |
| -1 | error | Reject negative input |
| abc | error | Reject non-numeric input |

### Output contract

The CLI should print only the value on success. On failure it should print a short error and exit non-zero so shell scripts and validation runs can detect the failure.

## Trace expectations

Trace evidence should show the room request, session decision request, draft artifact creation, repo inspection, file patch, test run, and final artifact submission.

### Tool evidence

The Observe surface should remain the audit view for endpoint and action details. The reader should only link to the trace group and avoid repeating the whole trace timeline.

### Handoff evidence

When Alice submits the build artifact, Cindy should receive enough context to review tests and edge cases without rereading the whole room conversation.

## Review checkpoint

The implementation-shape decision has been accepted. The current user action is to review Alice's file diff before accepting the implementation artifact and handing the patch to Cindy for code-quality review.
`;

const fibonacciImplementationMarkdown = `# Fibonacci CLI implementation artifact

Alice produced the first build patch for the accepted iterative CLI direction. This artifact is the durable review note for the patch, while the room reply stays short enough to read in chat.

## Summary

The recursive example was replaced with an iterative Fibonacci implementation, CLI input handling was tightened, and tests were added for success and failure paths.

## Changed files

### src/fibonacci.ts

Exports a validated Fibonacci function and a dedicated input error. The implementation runs in O(n) time and O(1) memory, matching the accepted decision.

### src/cli.ts

Parses one command-line argument, rejects missing, negative, and non-integer values, then prints only the computed value on success.

### tests/fibonacci.test.ts

Covers base cases, a normal input, invalid values, and CLI behavior so Cindy can review behavior without reconstructing the whole session from chat.

## Review request

Please inspect the three-file diff first. If the patch shape looks right, hand the implementation artifact to Cindy for the quality pass and trace validation.
`;

const fibonacciPatchSet: PatchSetProjection = {
  id: "patch-fibonacci-cli-run-1",
  workCardId: "card-review-patch-diff",
  projectId: "project-fibonacci-cli",
  title: "Iterative Fibonacci CLI patch",
  createdAtLabel: "10:46",
  traceId: "trace-run-42",
  agentReply: {
    actorName: "alice",
    actorInitials: "A",
    sentAt: "10:46",
    body: "I replaced the recursive example with an iterative CLI, added input validation, and covered the main success and failure paths with tests. The patch is ready for your file-by-file review; if it looks right, Cindy can take the quality pass next.",
  },
  artifactLinks: [
    {
      id: "artifact-implementation-patch",
      title: "Implementation artifact",
      status: "ready",
      summary: "Patch notes, changed files, review request, and handoff context.",
    },
    {
      id: "artifact-requirement-note",
      title: "Requirement note",
      status: "draft",
      summary: "Accepted CLI constraints and source messages.",
    },
  ],
  filesChanged: 3,
  addedLines: 136,
  removedLines: 137,
  files: [
    {
      id: "file-src-fibonacci",
      path: "src/fibonacci.ts",
      status: "modified",
      addedLines: 31,
      removedLines: 22,
      hunks: [
        {
          id: "hunk-fibonacci-export",
          oldStart: 1,
          oldLines: 27,
          newStart: 1,
          newLines: 36,
          header: "@@ -1,27 +1,36 @@",
          lines: [
            { id: "fib-1", kind: "deletion", oldLine: 1, newLine: null, content: "export function fibonacci(n: number): number {" },
            { id: "fib-2", kind: "deletion", oldLine: 2, newLine: null, content: "  if (n <= 1) return n;" },
            { id: "fib-3", kind: "deletion", oldLine: 3, newLine: null, content: "  return fibonacci(n - 1) + fibonacci(n - 2);" },
            { id: "fib-4", kind: "deletion", oldLine: 4, newLine: null, content: "}" },
            { id: "fib-5", kind: "addition", oldLine: null, newLine: 1, content: "export class FibonacciInputError extends Error {" },
            { id: "fib-6", kind: "addition", oldLine: null, newLine: 2, content: "  constructor(message: string) {" },
            { id: "fib-7", kind: "addition", oldLine: null, newLine: 3, content: "    super(message);" },
            { id: "fib-8", kind: "addition", oldLine: null, newLine: 4, content: "    this.name = \"FibonacciInputError\";" },
            { id: "fib-9", kind: "addition", oldLine: null, newLine: 5, content: "  }" },
            { id: "fib-10", kind: "addition", oldLine: null, newLine: 6, content: "}" },
            { id: "fib-11", kind: "context", oldLine: 6, newLine: 8, content: "" },
            { id: "fib-12", kind: "addition", oldLine: null, newLine: 9, content: "export function fibonacci(input: number): number {" },
            { id: "fib-13", kind: "addition", oldLine: null, newLine: 10, content: "  assertNonNegativeInteger(input);" },
            { id: "fib-14", kind: "addition", oldLine: null, newLine: 11, content: "  if (input < 2) return input;" },
            { id: "fib-15", kind: "addition", oldLine: null, newLine: 12, content: "" },
            { id: "fib-16", kind: "addition", oldLine: null, newLine: 13, content: "  let previous = 0;" },
            { id: "fib-17", kind: "addition", oldLine: null, newLine: 14, content: "  let current = 1;" },
            { id: "fib-18", kind: "addition", oldLine: null, newLine: 15, content: "  for (let index = 2; index <= input; index += 1) {" },
            { id: "fib-19", kind: "addition", oldLine: null, newLine: 16, content: "    const next = previous + current;" },
            { id: "fib-20", kind: "addition", oldLine: null, newLine: 17, content: "    previous = current;" },
            { id: "fib-21", kind: "addition", oldLine: null, newLine: 18, content: "    current = next;" },
            { id: "fib-22", kind: "addition", oldLine: null, newLine: 19, content: "  }" },
            { id: "fib-23", kind: "addition", oldLine: null, newLine: 20, content: "  return current;" },
            { id: "fib-24", kind: "addition", oldLine: null, newLine: 21, content: "}" },
            {
              id: "fib-25",
              kind: "collapsed",
              oldLine: null,
              newLine: null,
              content: "",
              collapsedLines: 11,
              expandedLines: [
                { id: "fib-expand-1", oldLine: 12, newLine: 22, content: "" },
                { id: "fib-expand-2", oldLine: 13, newLine: 23, content: "export function sequence(length: number): number[] {" },
                { id: "fib-expand-3", oldLine: 14, newLine: 24, content: "  return Array.from({ length }, (_, index) => fibonacci(index));" },
                { id: "fib-expand-4", oldLine: 15, newLine: 25, content: "}" },
              ],
            },
            { id: "fib-26", kind: "addition", oldLine: null, newLine: 33, content: "function assertNonNegativeInteger(value: number): void {" },
            { id: "fib-27", kind: "addition", oldLine: null, newLine: 34, content: "  if (!Number.isInteger(value) || value < 0) {" },
            { id: "fib-28", kind: "addition", oldLine: null, newLine: 35, content: "    throw new FibonacciInputError(\"Expected a non-negative integer.\");" },
            { id: "fib-29", kind: "addition", oldLine: null, newLine: 36, content: "  }" },
            { id: "fib-30", kind: "addition", oldLine: null, newLine: 37, content: "}" },
          ],
        },
      ],
    },
    {
      id: "file-src-cli",
      path: "src/cli.ts",
      status: "modified",
      addedLines: 67,
      removedLines: 95,
      hunks: [
        {
          id: "hunk-cli-parse",
          oldStart: 1,
          oldLines: 44,
          newStart: 1,
          newLines: 38,
          header: "@@ -1,44 +1,38 @@",
          lines: [
            { id: "cli-1", kind: "deletion", oldLine: 1, newLine: null, content: "import process from \"node:process\";" },
            { id: "cli-2", kind: "deletion", oldLine: 2, newLine: null, content: "" },
            { id: "cli-3", kind: "deletion", oldLine: 3, newLine: null, content: "const value = Number(process.argv[2]);" },
            { id: "cli-4", kind: "deletion", oldLine: 4, newLine: null, content: "if (Number.isNaN(value)) {" },
            { id: "cli-5", kind: "deletion", oldLine: 5, newLine: null, content: "  console.error(\"Pass a number\");" },
            { id: "cli-6", kind: "deletion", oldLine: 6, newLine: null, content: "  process.exit(1);" },
            { id: "cli-7", kind: "deletion", oldLine: 7, newLine: null, content: "}" },
            { id: "cli-8", kind: "addition", oldLine: null, newLine: 1, content: "import { FibonacciInputError, fibonacci } from \"./fibonacci\";" },
            { id: "cli-9", kind: "addition", oldLine: null, newLine: 2, content: "" },
            { id: "cli-10", kind: "addition", oldLine: null, newLine: 3, content: "export interface CliResult {" },
            { id: "cli-11", kind: "addition", oldLine: null, newLine: 4, content: "  exitCode: number;" },
            { id: "cli-12", kind: "addition", oldLine: null, newLine: 5, content: "  stdout: string;" },
            { id: "cli-13", kind: "addition", oldLine: null, newLine: 6, content: "  stderr: string;" },
            { id: "cli-14", kind: "addition", oldLine: null, newLine: 7, content: "}" },
            {
              id: "cli-15",
              kind: "collapsed",
              oldLine: null,
              newLine: null,
              content: "",
              collapsedLines: 26,
              expandedLines: [
                { id: "cli-expand-1", oldLine: 16, newLine: 8, content: "export function parseInput(raw: string | undefined): number {" },
                { id: "cli-expand-2", oldLine: 17, newLine: 9, content: "  if (!raw) throw new FibonacciInputError(\"Missing input.\");" },
                { id: "cli-expand-3", oldLine: 18, newLine: 10, content: "  const value = Number(raw);" },
                { id: "cli-expand-4", oldLine: 19, newLine: 11, content: "  if (!Number.isFinite(value)) throw new FibonacciInputError(\"Expected a number.\");" },
                { id: "cli-expand-5", oldLine: 20, newLine: 12, content: "  return value;" },
                { id: "cli-expand-6", oldLine: 21, newLine: 13, content: "}" },
              ],
            },
            { id: "cli-16", kind: "addition", oldLine: null, newLine: 34, content: "export function runCli(args: string[]): CliResult {" },
            { id: "cli-17", kind: "addition", oldLine: null, newLine: 35, content: "  try {" },
            { id: "cli-18", kind: "addition", oldLine: null, newLine: 36, content: "    const value = parseInput(args[0]);" },
            { id: "cli-19", kind: "addition", oldLine: null, newLine: 37, content: "    return { exitCode: 0, stdout: `${fibonacci(value)}\\n`, stderr: \"\" };" },
            { id: "cli-20", kind: "addition", oldLine: null, newLine: 38, content: "  } catch (error) {" },
            { id: "cli-21", kind: "addition", oldLine: null, newLine: 39, content: "    const message = error instanceof Error ? error.message : \"Unknown error\";" },
            { id: "cli-22", kind: "addition", oldLine: null, newLine: 40, content: "    return { exitCode: 1, stdout: \"\", stderr: `${message}\\n` };" },
            { id: "cli-23", kind: "addition", oldLine: null, newLine: 41, content: "  }" },
            { id: "cli-24", kind: "addition", oldLine: null, newLine: 42, content: "}" },
          ],
        },
        {
          id: "hunk-cli-entrypoint",
          oldStart: 78,
          oldLines: 22,
          newStart: 54,
          newLines: 23,
          header: "@@ -78,22 +54,23 @@",
          lines: [
            { id: "cli-entry-1", kind: "context", oldLine: 78, newLine: 54, content: "function printHelp(): string {" },
            { id: "cli-entry-2", kind: "context", oldLine: 79, newLine: 55, content: "  return \"Usage: fibonacci <n>\";" },
            { id: "cli-entry-3", kind: "context", oldLine: 80, newLine: 56, content: "}" },
            { id: "cli-entry-4", kind: "deletion", oldLine: 81, newLine: null, content: "main(process.argv);" },
            { id: "cli-entry-5", kind: "addition", oldLine: null, newLine: 57, content: "if (import.meta.main) {" },
            { id: "cli-entry-6", kind: "addition", oldLine: null, newLine: 58, content: "  const result = runCli(Bun.argv.slice(2));" },
            { id: "cli-entry-7", kind: "addition", oldLine: null, newLine: 59, content: "  if (result.stdout) process.stdout.write(result.stdout);" },
            { id: "cli-entry-8", kind: "addition", oldLine: null, newLine: 60, content: "  if (result.stderr) process.stderr.write(result.stderr);" },
            { id: "cli-entry-9", kind: "addition", oldLine: null, newLine: 61, content: "  process.exit(result.exitCode);" },
            { id: "cli-entry-10", kind: "addition", oldLine: null, newLine: 62, content: "}" },
          ],
        },
      ],
    },
    {
      id: "file-tests-fibonacci",
      path: "tests/fibonacci.test.ts",
      status: "added",
      addedLines: 38,
      removedLines: 20,
      hunks: [
        {
          id: "hunk-tests-main",
          oldStart: 1,
          oldLines: 20,
          newStart: 1,
          newLines: 38,
          header: "@@ -1,20 +1,38 @@",
          lines: [
            { id: "test-1", kind: "deletion", oldLine: 1, newLine: null, content: "import { test, expect } from \"bun:test\";" },
            { id: "test-2", kind: "deletion", oldLine: 2, newLine: null, content: "" },
            { id: "test-3", kind: "deletion", oldLine: 3, newLine: null, content: "test(\"placeholder\", () => {" },
            { id: "test-4", kind: "deletion", oldLine: 4, newLine: null, content: "  expect(true).toBe(true);" },
            { id: "test-5", kind: "deletion", oldLine: 5, newLine: null, content: "});" },
            { id: "test-6", kind: "addition", oldLine: null, newLine: 1, content: "import { describe, expect, test } from \"bun:test\";" },
            { id: "test-7", kind: "addition", oldLine: null, newLine: 2, content: "import { fibonacci } from \"../src/fibonacci\";" },
            { id: "test-8", kind: "addition", oldLine: null, newLine: 3, content: "import { runCli } from \"../src/cli\";" },
            { id: "test-9", kind: "addition", oldLine: null, newLine: 4, content: "" },
            { id: "test-10", kind: "addition", oldLine: null, newLine: 5, content: "describe(\"fibonacci\", () => {" },
            { id: "test-11", kind: "addition", oldLine: null, newLine: 6, content: "  test.each([" },
            { id: "test-12", kind: "addition", oldLine: null, newLine: 7, content: "    [0, 0]," },
            { id: "test-13", kind: "addition", oldLine: null, newLine: 8, content: "    [1, 1]," },
            { id: "test-14", kind: "addition", oldLine: null, newLine: 9, content: "    [7, 13]," },
            { id: "test-15", kind: "addition", oldLine: null, newLine: 10, content: "    [12, 144]," },
            { id: "test-16", kind: "addition", oldLine: null, newLine: 11, content: "  ])(\"returns %i for %i\", (input, expected) => {" },
            { id: "test-17", kind: "addition", oldLine: null, newLine: 12, content: "    expect(fibonacci(input)).toBe(expected);" },
            { id: "test-18", kind: "addition", oldLine: null, newLine: 13, content: "  });" },
            {
              id: "test-19",
              kind: "collapsed",
              oldLine: null,
              newLine: null,
              content: "",
              collapsedLines: 12,
              expandedLines: [
                { id: "test-expand-1", oldLine: null, newLine: 14, content: "" },
                { id: "test-expand-2", oldLine: null, newLine: 15, content: "  test(\"handles larger indexes without recursion\", () => {" },
                { id: "test-expand-3", oldLine: null, newLine: 16, content: "    expect(fibonacci(20)).toBe(6765);" },
                { id: "test-expand-4", oldLine: null, newLine: 17, content: "  });" },
              ],
            },
            { id: "test-20", kind: "addition", oldLine: null, newLine: 27, content: "  test(\"prints only the value on success\", () => {" },
            { id: "test-21", kind: "addition", oldLine: null, newLine: 28, content: "    expect(runCli([\"7\"])).toEqual({ exitCode: 0, stdout: \"13\\n\", stderr: \"\" });" },
            { id: "test-22", kind: "addition", oldLine: null, newLine: 29, content: "  });" },
            { id: "test-23", kind: "addition", oldLine: null, newLine: 30, content: "" },
            { id: "test-24", kind: "addition", oldLine: null, newLine: 31, content: "  test(\"rejects invalid input\", () => {" },
            { id: "test-25", kind: "addition", oldLine: null, newLine: 32, content: "    expect(runCli([\"abc\"]).exitCode).toBe(1);" },
            { id: "test-26", kind: "addition", oldLine: null, newLine: 33, content: "    expect(runCli([\"-1\"]).stderr).toContain(\"non-negative integer\");" },
            { id: "test-27", kind: "addition", oldLine: null, newLine: 34, content: "  });" },
            { id: "test-28", kind: "addition", oldLine: null, newLine: 35, content: "});" },
          ],
        },
      ],
    },
  ],
};

export const deskFixture: DeskSnapshot = {
  workspace: {
    id: "workspace-local",
    name: "Kairos Local",
    health: {
      status: "healthy",
      label: "IPC runtime healthy",
      detail: "Kernel, session manager, and local agent adapters are accepting envelopes.",
    },
  },
  nav: {
    needsYou: [
      {
        id: "need-review-patch-diff",
        label: "Review Fibonacci patch",
        icon: "!",
        surface: "work",
        targetId: "card-review-patch-diff",
        badge: "review",
        attention: "needs-human",
        quiet: false,
      },
    ],
    rooms: [
      {
        id: "room-fibonacci-cli",
        label: "fibonacci-cli",
        icon: "#",
        surface: "rooms",
        targetId: "room-fibonacci-cli",
        badge: "3",
        attention: "info",
        quiet: false,
      },
      {
        id: "room-repo-review",
        label: "repo-review",
        icon: "#",
        surface: "rooms",
        targetId: "room-repo-review",
        badge: null,
        attention: "none",
        quiet: false,
      },
      {
        id: "room-release-notes",
        label: "release-notes",
        icon: "#",
        surface: "rooms",
        targetId: "room-release-notes",
        badge: null,
        attention: "none",
        quiet: true,
      },
    ],
    projects: [
      {
        id: "project-fibonacci-cli",
        label: "Fibonacci CLI",
        icon: "□",
        surface: "projects",
        targetId: "project-fibonacci-cli",
        badge: "Review",
        attention: "needs-human",
        quiet: false,
      },
      {
        id: "project-trace-replay",
        label: "IPC trace replay",
        icon: "□",
        surface: "projects",
        targetId: "project-trace-replay",
        badge: "Build",
        attention: "info",
        quiet: false,
      },
    ],
    agents: [
      {
        id: "agent-alice",
        label: "alice",
        icon: "@",
        surface: "agents",
        targetId: "agent-alice",
        badge: "running",
        attention: "info",
        quiet: false,
      },
      {
        id: "agent-cindy",
        label: "cindy",
        icon: "@",
        surface: "agents",
        targetId: "agent-cindy",
        badge: "waiting",
        attention: "none",
        quiet: false,
      },
      {
        id: "agent-pi",
        label: "pi",
        icon: "@",
        surface: "agents",
        targetId: "agent-pi",
        badge: "idle",
        attention: "none",
        quiet: true,
      },
    ],
    observe: [
      {
        id: "observe-run-42",
        label: "Latest trace group",
        icon: "~",
        surface: "observe",
        targetId: "trace-run-42",
        badge: null,
        attention: "info",
        quiet: true,
      },
      {
        id: "observe-health",
        label: "Endpoint health",
        icon: "~",
        surface: "observe",
        targetId: "endpoint-health",
        badge: null,
        attention: "none",
        quiet: true,
      },
    ],
  },
  rooms: [
    {
      id: "room-fibonacci-cli",
      name: "fibonacci-cli",
      topic: "Build a small Fibonacci program with agents. Project state is tracked outside the chat stream.",
      projectIds: ["project-fibonacci-cli"],
      agentIds: ["agent-alice", "agent-cindy", "agent-pi"],
      latestIpcAction: {
        actorId: "agent-alice",
        actorName: "alice",
        endpoint: "app://repo.inspect",
        action: "read_tree",
        argsPreview: '{ path: "src" }',
        traceId: "trace-run-42",
      },
      messages: [
        {
          id: "msg-101",
          actorId: "human-tomiya",
          actorName: "tomiya",
          actorInitials: "T",
          actorKind: "human",
          sentAt: "10:41",
          body: "@alice write a Fibonacci program. @cindy review code quality once there is a patch.",
          projections: [],
        },
        {
          id: "msg-102",
          actorId: "agent-alice",
          actorName: "alice",
          actorInitials: "A",
          actorKind: "agent",
          sentAt: "10:42",
          body: "I need one product choice before I write code: should this be a tiny recursive example, an iterative CLI, or a memoized library function?",
          projections: [
            {
              kind: "decision",
              id: "decision-shape",
              title: "Choose implementation shape",
              status: "accepted",
              recommendation: "Iterative CLI, O(n) time, O(1) memory.",
              rationale: "It is easy to test, safe for larger n, and still simple enough for the first build.",
              primaryAction: "Accepted recommendation",
              cardId: "card-shape-decision",
              traceId: "trace-run-42",
            },
          ],
        },
        {
          id: "msg-103",
          actorId: "agent-cindy",
          actorName: "cindy",
          actorInitials: "C",
          actorKind: "agent",
          sentAt: "10:43",
          body: "I will wait for Alice's patch, then check tests, edge cases, and whether the implementation matches the requested complexity.",
          projections: [],
        },
        {
          id: "msg-104",
          actorId: "agent-alice",
          actorName: "alice",
          actorInitials: "A",
          actorKind: "agent",
          sentAt: "10:44",
          body: "I captured the requirement as a draft artifact. The full implementation note will appear after the build run.",
          projections: [
            {
              kind: "artifact",
              id: "artifact-requirement-note",
              title: "Fibonacci CLI requirement note",
              status: "draft",
              summary: "Markdown artifact with accepted constraints, source messages, and the implementation handoff.",
              projectId: "project-fibonacci-cli",
              roomId: "room-fibonacci-cli",
              traceId: "trace-run-42",
            },
            {
              kind: "work-card",
              id: "card-review-patch-diff",
              title: "Review Fibonacci patch diff",
              phase: "Review",
              status: "needs-human",
              owner: "human",
              summary: "Alice produced the first CLI patch. Review the changed files before accepting the implementation artifact.",
              projectId: "project-fibonacci-cli",
              diffSummary: { filesChanged: 3, addedLines: 136, removedLines: 137 },
              patchSetIds: ["patch-fibonacci-cli-run-1"],
            },
          ],
        },
      ],
    },
  ],
  projects: [
    {
      id: "project-fibonacci-cli",
      title: "Fibonacci CLI",
      summary: "Ship a small, testable Fibonacci command-line program with agent review and trace-backed evidence.",
      phase: "Review",
      owner: "human",
      roomIds: ["room-fibonacci-cli"],
      agentIds: ["agent-alice", "agent-cindy"],
      artifactIds: ["artifact-requirement-note", "artifact-implementation-patch"],
      blocker: "Patch diff review",
      cards: [
        {
          kind: "work-card",
          id: "card-shape-decision",
          title: "Choose implementation shape",
          phase: "Decide",
          status: "done",
          owner: "human",
          summary: "Decision accepted: use an iterative CLI because it is simple, safe for larger n, and easy to validate.",
          projectId: "project-fibonacci-cli",
          diffSummary: null,
          patchSetIds: [],
        },
        {
          kind: "work-card",
          id: "card-build-cli",
          title: "Implement iterative Fibonacci CLI",
          phase: "Build",
          status: "done",
          owner: "alice",
          summary: "Alice produced the first CLI patch and attached it to the review card as file-level evidence.",
          projectId: "project-fibonacci-cli",
          diffSummary: null,
          patchSetIds: [],
        },
        {
          kind: "work-card",
          id: "card-review-patch-diff",
          title: "Review Fibonacci patch diff",
          phase: "Review",
          status: "needs-human",
          owner: "human",
          summary: "Inspect the three changed files before accepting Alice's implementation artifact.",
          projectId: "project-fibonacci-cli",
          diffSummary: { filesChanged: 3, addedLines: 136, removedLines: 137 },
          patchSetIds: ["patch-fibonacci-cli-run-1"],
        },
        {
          kind: "work-card",
          id: "card-review-quality",
          title: "Review code quality and edge cases",
          phase: "Review",
          status: "none",
          owner: "cindy",
          summary: "Check tests, input validation, and requested complexity after Alice submits a patch.",
          projectId: "project-fibonacci-cli",
          diffSummary: null,
          patchSetIds: [],
        },
        {
          kind: "work-card",
          id: "card-validate-trace",
          title: "Validate run and trace evidence",
          phase: "Validate",
          status: "none",
          owner: "human",
          summary: "Confirm the final run, test output, and IPC evidence before accepting the artifact.",
          projectId: "project-fibonacci-cli",
          diffSummary: null,
          patchSetIds: [],
        },
      ],
    },
  ],
  patchSets: [fibonacciPatchSet],
  artifacts: [
    {
      id: "artifact-requirement-note",
      title: "Fibonacci CLI requirement note",
      authorAgentId: "agent-alice",
      authorName: "alice",
      projectId: "project-fibonacci-cli",
      sourceCardId: "card-shape-decision",
      sourceRoomId: "room-fibonacci-cli",
      status: "draft",
      markdown: fibonacciRequirementMarkdown,
      sourceRefs: [
        {
          label: "Human request",
          targetSurface: "rooms",
          targetId: "room-fibonacci-cli",
          targetAnchorId: "msg-101",
        },
        {
          label: "Alice draft note",
          targetSurface: "rooms",
          targetId: "room-fibonacci-cli",
          targetAnchorId: "msg-104",
        },
        {
          label: "Trace run_42",
          targetSurface: "observe",
          targetId: "trace-run-42",
        },
      ],
      relatedArtifactIds: [],
      supersedesArtifactId: null,
      traceId: "trace-run-42",
    },
    {
      id: "artifact-implementation-patch",
      title: "Fibonacci CLI implementation artifact",
      authorAgentId: "agent-alice",
      authorName: "alice",
      projectId: "project-fibonacci-cli",
      sourceCardId: "card-review-patch-diff",
      sourceRoomId: "room-fibonacci-cli",
      status: "ready",
      markdown: fibonacciImplementationMarkdown,
      sourceRefs: [
        {
          label: "Patch diff",
          targetSurface: "diff",
          targetId: "patch-fibonacci-cli-run-1",
          targetAnchorId: "file-src-fibonacci",
        },
        {
          label: "Requirement note",
          targetSurface: "artifact",
          targetId: "artifact-requirement-note",
        },
        {
          label: "Trace run_42",
          targetSurface: "observe",
          targetId: "trace-run-42",
        },
      ],
      relatedArtifactIds: ["artifact-requirement-note"],
      supersedesArtifactId: null,
      traceId: "trace-run-42",
    },
  ],
  agents: [
    {
      id: "agent-alice",
      name: "alice",
      role: "builder",
      state: "running",
      currentDelegation: "Prepare Fibonacci CLI implementation after human decision.",
      linkedProjectId: "project-fibonacci-cli",
      latestReport: "First patch is ready for human file review before Cindy checks quality.",
      latestIpcAction: {
        actorId: "agent-alice",
        actorName: "alice",
        endpoint: "app://repo.inspect",
        action: "read_tree",
        argsPreview: '{ path: "src" }',
        traceId: "trace-run-42",
      },
      recentArtifactIds: ["artifact-implementation-patch", "artifact-requirement-note"],
      blockers: ["Needs human review on patch diff"],
      healthLabel: "Adapter online",
      capabilities: ["repo.inspect", "file.patch", "bun.test"],
    },
    {
      id: "agent-cindy",
      name: "cindy",
      role: "reviewer",
      state: "waiting",
      currentDelegation: "Review Alice's patch once code exists.",
      linkedProjectId: "project-fibonacci-cli",
      latestReport: "Standing by for tests, edge cases, and complexity review.",
      latestIpcAction: null,
      recentArtifactIds: [],
      blockers: [],
      healthLabel: "Adapter online",
      capabilities: ["repo.inspect", "test.review", "artifact.review"],
    },
    {
      id: "agent-pi",
      name: "pi",
      role: "service",
      state: "idle",
      currentDelegation: "Service actor available for provider-backed reasoning.",
      linkedProjectId: null,
      latestReport: "No active delegation.",
      latestIpcAction: null,
      recentArtifactIds: [],
      blockers: [],
      healthLabel: "Provider healthy",
      capabilities: ["model.complete", "tool.summarize"],
    },
  ],
  observe: {
    traceGroups: [
      {
        id: "trace-run-42",
        title: "Fibonacci CLI room delegation",
        status: "needs-human",
        startedAt: "10:41",
        linkedRoomId: "room-fibonacci-cli",
        linkedProjectId: "project-fibonacci-cli",
        events: [
          {
            id: "trace-event-1",
            timestamp: "10:41:02",
            code: "room.message.created",
            actor: "tomiya",
            summary: "Human request captured in #fibonacci-cli.",
            severity: "info",
          },
          {
            id: "trace-event-2",
            timestamp: "10:42:18",
            code: "session.decision.requested",
            actor: "alice",
            summary: "Decision card opened for implementation shape.",
            severity: "warning",
          },
          {
            id: "trace-event-3",
            timestamp: "10:44:07",
            code: "artifact.draft.created",
            actor: "alice",
            summary: "Requirement note persisted as a draft artifact.",
            severity: "success",
          },
          {
            id: "trace-event-4",
            timestamp: "10:44:21",
            code: "ipc.call.started",
            actor: "alice",
            summary: "repo.inspect read_tree started against src.",
            severity: "info",
          },
        ],
      },
    ],
    endpointHealth: [
      {
        id: "endpoint-kernel",
        label: "kernel://router",
        status: "healthy",
        latencyMs: 8,
        detail: "Envelope validation and routing are nominal.",
      },
      {
        id: "endpoint-session",
        label: "app://session-manager",
        status: "healthy",
        latencyMs: 18,
        detail: "Projection readers are current through cursor 1184.",
      },
      {
        id: "endpoint-alice",
        label: "agent://alice",
        status: "healthy",
        latencyMs: 32,
        detail: "Adapter is running one delegated task.",
      },
    ],
    evidence: [
      {
        id: "evidence-decision",
        kind: "approval",
        title: "Implementation-shape decision",
        summary: "Human choice required before Alice mutates files.",
        traceId: "trace-run-42",
        linkedSurface: "projects",
        linkedId: "card-shape-decision",
        attention: "needs-human",
      },
      {
        id: "evidence-repo-inspect",
        kind: "tool-call",
        title: "repo.inspect read_tree",
        summary: "Alice is reading project structure before proposing file edits.",
        traceId: "trace-run-42",
        linkedSurface: "observe",
        linkedId: "trace-event-4",
        attention: "info",
      },
      {
        id: "evidence-artifact-draft",
        kind: "artifact",
        title: "Requirement note draft",
        summary: "Draft artifact persisted without rendering its Markdown into the room timeline.",
        traceId: "trace-run-42",
        linkedSurface: "artifact",
        linkedId: "artifact-requirement-note",
        attention: "info",
      },
    ],
  },
  inspector: {
    mode: "decision",
    title: "Context inspector",
    subtitle: "Decision card from #fibonacci-cli",
    decisionId: "decision-shape",
    artifactId: "artifact-requirement-note",
    cardId: "card-shape-decision",
    traceId: "trace-run-42",
  },
};
