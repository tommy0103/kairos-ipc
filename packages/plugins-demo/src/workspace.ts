import { lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { createNode, z, type IpcNode } from "../../sdk/src/index.ts";
import type { SlockCapabilityGrant, SlockGrantStore } from "../../slock-channel/src/index.ts";

export interface WorkspaceListRequest {
  path?: string;
  recursive?: boolean;
  max_entries?: number;
  include_hidden?: boolean;
  include_ignored?: boolean;
}

export interface WorkspaceListEntry {
  path: string;
  name: string;
  type: "file" | "directory" | "symlink" | "other";
  bytes: number;
  mtime_ms: number;
}

export interface WorkspaceListResult {
  path: string;
  entries: WorkspaceListEntry[];
  truncated: boolean;
}

export interface WorkspaceReadRequest {
  path: string;
  max_bytes?: number;
}

export interface WorkspaceReadResult {
  path: string;
  content: string;
  bytes: number;
  truncated: boolean;
}

export interface WorkspaceWriteRequest {
  path: string;
  content: string;
  approval_grant?: SlockCapabilityGrant;
}

export interface WorkspaceWriteResult {
  path: string;
  bytes: number;
}

export interface WorkspaceEditRequest {
  path: string;
  old_text: string;
  new_text: string;
  approval_grant?: SlockCapabilityGrant;
}

export interface WorkspaceEditResult {
  path: string;
  replacements: number;
  bytes: number;
}

export interface WorkspaceSearchRequest {
  query: string;
  path?: string;
  case_sensitive?: boolean;
  max_matches?: number;
  max_files?: number;
  max_file_bytes?: number;
  include_hidden?: boolean;
  include_ignored?: boolean;
}

export interface WorkspaceSearchMatch {
  path: string;
  line_number: number;
  column: number;
  line: string;
}

export interface WorkspaceSearchResult {
  query: string;
  path: string;
  matches: WorkspaceSearchMatch[];
  searched_files: number;
  truncated: boolean;
}

export interface WorkspacePluginOptions {
  uri?: string;
  root?: string;
  max_read_bytes?: number;
  max_list_entries?: number;
  max_search_matches?: number;
  max_search_files?: number;
  max_search_file_bytes?: number;
  grant_store?: SlockGrantStore;
}

export interface WorkspacePlugin {
  node: IpcNode;
  root: string;
}

const workspacePathSchema = z.string().min(1).describe("Path relative to the configured workspace root. Absolute paths and parent-directory escapes are rejected.");
const capabilityGrantSchema = z.object({
  id: z.string().describe("Grant id."),
  token: z.string().describe("Opaque grant token."),
  source: z.string().describe("Endpoint URI that requested the grant."),
  target: z.string().describe("Endpoint URI the grant applies to."),
  actions: z.array(z.string()).describe("Allowed action names."),
  issued_at: z.string().describe("Grant issue timestamp."),
  expires_at: z.string().describe("Grant expiration timestamp."),
  approval_id: z.string().optional().describe("Human approval id that produced this grant."),
  risk: z.string().optional().describe("Approval risk label, when available."),
}).describe("Temporary Slock capability grant attached by ipc_call after human approval. Do not invent manually.");
const approvalGrantSchema = capabilityGrantSchema.optional();
const listRequestSchema = z.object({
  path: workspacePathSchema.optional().describe("Directory or file path to list. Defaults to the workspace root."),
  recursive: z.boolean().optional().describe("When true, recursively include nested entries."),
  max_entries: z.number().int().positive().optional().describe("Maximum number of entries to return. The plugin clamps this to its configured limit."),
  include_hidden: z.boolean().optional().describe("Include dotfiles and dot-directories when true."),
  include_ignored: z.boolean().optional().describe("Include default ignored names such as .git, node_modules, dist, build, and coverage when true."),
}).describe("List files and directories under the configured workspace root.");
const listEntrySchema = z.object({
  path: z.string().describe("Entry path relative to the workspace root."),
  name: z.string().describe("Base name of the entry."),
  type: z.enum(["file", "directory", "symlink", "other"]).describe("Filesystem entry type."),
  bytes: z.number().describe("Entry size in bytes."),
  mtime_ms: z.number().describe("Entry modification time as Unix epoch milliseconds."),
}).describe("One workspace listing entry.");
const listResultSchema = z.object({
  path: z.string().describe("Listed path relative to the workspace root."),
  entries: z.array(listEntrySchema).describe("Listed entries."),
  truncated: z.boolean().describe("True when results were cut off by max_entries or the configured limit."),
}).describe("Workspace list response.");
const readRequestSchema = z.object({
  path: workspacePathSchema.describe("UTF-8 file path to read, relative to the workspace root."),
  max_bytes: z.number().int().positive().optional().describe("Maximum UTF-8 bytes to return. The plugin clamps this to its configured limit."),
}).describe("Read a UTF-8 file under the configured workspace root.");
const readResultSchema = z.object({
  path: z.string().describe("Read path relative to the workspace root."),
  content: z.string().describe("UTF-8 file content, possibly truncated."),
  bytes: z.number().describe("Returned byte count."),
  truncated: z.boolean().describe("True when content was clipped by max_bytes or the configured limit."),
}).describe("Workspace read response.");
const writeRequestSchema = z.object({
  path: workspacePathSchema.describe("UTF-8 file path to write, relative to the workspace root."),
  content: z.string().describe("Complete UTF-8 file content to write."),
  approval_grant: approvalGrantSchema,
}).describe("Write a UTF-8 file under the configured workspace root.");
const writeResultSchema = z.object({
  path: z.string().describe("Written path relative to the workspace root."),
  bytes: z.number().describe("Written byte count."),
}).describe("Workspace write response.");
const editRequestSchema = z.object({
  path: workspacePathSchema.describe("UTF-8 file path to edit, relative to the workspace root."),
  old_text: z.string().min(1).describe("Exact UTF-8 text to replace. Must be non-empty and must appear in the file."),
  new_text: z.string().describe("Replacement UTF-8 text."),
  approval_grant: approvalGrantSchema,
}).describe("Replace exact UTF-8 text in a file under the configured workspace root.");
const editResultSchema = z.object({
  path: z.string().describe("Edited path relative to the workspace root."),
  replacements: z.number().int().describe("Number of replacements made."),
  bytes: z.number().describe("Final file size in bytes."),
}).describe("Workspace edit response.");
const searchRequestSchema = z.object({
  query: z.string().min(1).describe("Literal UTF-8 search string. This is not a regular expression."),
  path: workspacePathSchema.optional().describe("Directory or file path to search. Defaults to the workspace root."),
  case_sensitive: z.boolean().optional().describe("When true, search with case-sensitive matching."),
  max_matches: z.number().int().positive().optional().describe("Maximum number of matches to return. The plugin clamps this to its configured limit."),
  max_files: z.number().int().positive().optional().describe("Maximum number of files to scan. The plugin clamps this to its configured limit."),
  max_file_bytes: z.number().int().positive().optional().describe("Skip files larger than this byte count. The plugin clamps this to its configured limit."),
  include_hidden: z.boolean().optional().describe("Search dotfiles and dot-directories when true."),
  include_ignored: z.boolean().optional().describe("Search default ignored names such as .git, node_modules, dist, build, and coverage when true."),
}).describe("Search UTF-8 files under the configured workspace root for a literal string.");
const searchMatchSchema = z.object({
  path: z.string().describe("Matched file path relative to the workspace root."),
  line_number: z.number().int().positive().describe("1-based line number."),
  column: z.number().int().positive().describe("1-based column number."),
  line: z.string().describe("Matched line, clipped for display if very long."),
}).describe("One workspace search match.");
const searchResultSchema = z.object({
  query: z.string().describe("Search query."),
  path: z.string().describe("Searched path relative to the workspace root."),
  matches: z.array(searchMatchSchema).describe("Search matches."),
  searched_files: z.number().int().describe("Number of files scanned."),
  truncated: z.boolean().describe("True when results were cut off by match, file, or configured limits."),
}).describe("Workspace search response.");

export function createWorkspacePlugin(options: WorkspacePluginOptions = {}): WorkspacePlugin {
  const uri = options.uri ?? "plugin://local/workspace";
  const node = createNode(uri);
  const root = resolve(options.root ?? process.cwd());
  const maxReadBytes = options.max_read_bytes ?? 1024 * 128;
  const maxListEntries = options.max_list_entries ?? 200;
  const maxSearchMatches = options.max_search_matches ?? 50;
  const maxSearchFiles = options.max_search_files ?? 500;
  const maxSearchFileBytes = options.max_search_file_bytes ?? 1024 * 256;

  node.action<WorkspaceListRequest, WorkspaceListResult>(
    "list",
    {
      description: "List files and directories under the configured workspace root. Payload: { path?, recursive?, max_entries?, include_hidden?, include_ignored? }.",
      accepts: "application/json",
      returns: "application/json",
      input: listRequestSchema,
      output: listResultSchema,
      input_name: "WorkspaceListRequest",
      output_name: "WorkspaceListResult",
    },
    async ({ input }) => {
      const request = input;
      const startPath = resolveWorkspacePath(root, request.path ?? ".");
      const limit = clampLimit(request.max_entries, maxListEntries);
      const entries: WorkspaceListEntry[] = [];
      const truncated = await collectListEntries(root, startPath, request, entries, limit);

      return {
        mime_type: "application/json",
        data: {
          path: relative(root, startPath) || ".",
          entries,
          truncated,
        },
      };
    },
  );

  node.action<WorkspaceReadRequest, WorkspaceReadResult>(
    "read",
    {
      description: "Read a UTF-8 file under the configured workspace root.",
      accepts: "application/json",
      returns: "application/json",
      input: readRequestSchema,
      output: readResultSchema,
      input_name: "WorkspaceReadRequest",
      output_name: "WorkspaceReadResult",
    },
    async ({ input }) => {
      const request = input;
      const filePath = resolveWorkspacePath(root, request.path);
      const content = await readFile(filePath, "utf8");
      const limit = clampLimit(request.max_bytes, maxReadBytes);
      const clipped = Buffer.from(content, "utf8").subarray(0, limit).toString("utf8");
      return {
        mime_type: "application/json",
        data: {
          path: relative(root, filePath),
          content: clipped,
          bytes: Buffer.byteLength(clipped, "utf8"),
          truncated: Buffer.byteLength(content, "utf8") > limit,
        },
      };
    },
  );

  node.action<WorkspaceSearchRequest, WorkspaceSearchResult>(
    "search",
    {
      description: "Search UTF-8 files under the configured workspace root for a literal string. Payload: { query, path?, case_sensitive?, max_matches?, max_files?, max_file_bytes?, include_hidden?, include_ignored? }.",
      accepts: "application/json",
      returns: "application/json",
      input: searchRequestSchema,
      output: searchResultSchema,
      input_name: "WorkspaceSearchRequest",
      output_name: "WorkspaceSearchResult",
    },
    async ({ input }) => {
      const request = input;
      const startPath = resolveWorkspacePath(root, request.path ?? ".");
      const result = await searchWorkspace(root, startPath, request, {
        max_matches: clampLimit(request.max_matches, maxSearchMatches),
        max_files: clampLimit(request.max_files, maxSearchFiles),
        max_file_bytes: clampLimit(request.max_file_bytes, maxSearchFileBytes),
      });

      return {
        mime_type: "application/json",
        data: {
          query: request.query,
          path: relative(root, startPath) || ".",
          ...result,
        },
      };
    },
  );

  node.action<WorkspaceWriteRequest, WorkspaceWriteResult>(
    "write",
    {
      description: "Write a UTF-8 file under the configured workspace root.",
      accepts: "application/json",
      returns: "application/json",
      input: writeRequestSchema,
      output: writeResultSchema,
      input_name: "WorkspaceWriteRequest",
      output_name: "WorkspaceWriteResult",
    },
    async ({ input, context }) => {
      const request = input;
      assertGrant(options.grant_store, request.approval_grant, context.envelope.header.source, uri, "write");
      const filePath = resolveWorkspacePath(root, request.path);
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, request.content, "utf8");
      return {
        mime_type: "application/json",
        data: {
          path: relative(root, filePath),
          bytes: Buffer.byteLength(request.content, "utf8"),
        },
      };
    },
  );

  node.action<WorkspaceEditRequest, WorkspaceEditResult>(
    "edit",
    {
      description: "Replace exact UTF-8 text in a file under the configured workspace root.",
      accepts: "application/json",
      returns: "application/json",
      input: editRequestSchema,
      output: editResultSchema,
      input_name: "WorkspaceEditRequest",
      output_name: "WorkspaceEditResult",
    },
    async ({ input, context }) => {
      const request = input;
      assertGrant(options.grant_store, request.approval_grant, context.envelope.header.source, uri, "edit");
      const filePath = resolveWorkspacePath(root, request.path);
      const content = await readFile(filePath, "utf8");
      const replacements = countOccurrences(content, request.old_text);
      if (replacements === 0) {
        throw new Error(`old_text was not found in ${request.path}`);
      }

      const next = content.split(request.old_text).join(request.new_text);
      await writeFile(filePath, next, "utf8");
      return {
        mime_type: "application/json",
        data: {
          path: relative(root, filePath),
          replacements,
          bytes: Buffer.byteLength(next, "utf8"),
        },
      };
    },
  );

  return { node, root };
}

function assertGrant(
  store: SlockGrantStore | undefined,
  grant: SlockCapabilityGrant | undefined,
  source: string,
  target: string,
  action: string,
): void {
  if (!store) {
    return;
  }

  const decision = store.check({ grant, source, target, action });
  if (!decision.allowed) {
    throw new Error(decision.message ?? decision.code ?? "capability grant denied");
  }
}

function resolveWorkspacePath(root: string, requestedPath: string): string {
  if (typeof requestedPath !== "string" || requestedPath.trim().length === 0) {
    throw new Error("workspace path is required");
  }

  const filePath = resolve(root, requestedPath);
  const rel = relative(root, filePath);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`workspace path escapes root: ${requestedPath}`);
  }
  return filePath;
}

function clampLimit(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(1, Math.min(Math.trunc(value), fallback));
}

function countOccurrences(value: string, needle: string): number {
  let count = 0;
  let index = value.indexOf(needle);
  while (index >= 0) {
    count++;
    index = value.indexOf(needle, index + needle.length);
  }
  return count;
}

async function collectListEntries(
  root: string,
  dirPath: string,
  request: WorkspaceListRequest,
  entries: WorkspaceListEntry[],
  limit: number,
): Promise<boolean> {
  const stats = await lstat(dirPath);
  if (!stats.isDirectory()) {
    entries.push(toListEntry(root, dirPath, stats));
    return false;
  }

  const names = await readdir(dirPath);
  names.sort((left, right) => left.localeCompare(right));

  for (const name of names) {
    if (shouldSkipName(name, request)) {
      continue;
    }

    if (entries.length >= limit) {
      return true;
    }

    const childPath = resolve(dirPath, name);
    const childStats = await lstat(childPath);
    entries.push(toListEntry(root, childPath, childStats));

    if (request.recursive && childStats.isDirectory()) {
      const truncated = await collectListEntries(root, childPath, request, entries, limit);
      if (truncated) {
        return true;
      }
    }
  }

  return false;
}

function toListEntry(root: string, path: string, stats: Awaited<ReturnType<typeof lstat>>): WorkspaceListEntry {
  return {
    path: relative(root, path),
    name: path.split(/[\\/]/).at(-1) ?? path,
    type: stats.isFile() ? "file" : stats.isDirectory() ? "directory" : stats.isSymbolicLink() ? "symlink" : "other",
    bytes: stats.size,
    mtime_ms: stats.mtimeMs,
  };
}

async function searchWorkspace(
  root: string,
  startPath: string,
  request: WorkspaceSearchRequest,
  limits: { max_matches: number; max_files: number; max_file_bytes: number },
): Promise<Omit<WorkspaceSearchResult, "query" | "path">> {
  const matches: WorkspaceSearchMatch[] = [];
  const needle = request.case_sensitive ? request.query : request.query.toLowerCase();
  let searchedFiles = 0;
  let truncated = false;

  for await (const filePath of walkSearchFiles(startPath, request)) {
    if (searchedFiles >= limits.max_files || matches.length >= limits.max_matches) {
      truncated = true;
      break;
    }

    const stats = await lstat(filePath);
    if (!stats.isFile()) {
      continue;
    }
    if (stats.size > limits.max_file_bytes) {
      continue;
    }

    searchedFiles++;
    const content = await readUtf8File(filePath);
    if (content === undefined) {
      continue;
    }

    const lines = content.split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      const haystack = request.case_sensitive ? line : line.toLowerCase();
      const column = haystack.indexOf(needle);
      if (column < 0) {
        continue;
      }

      matches.push({
        path: relative(root, filePath),
        line_number: index + 1,
        column: column + 1,
        line: clipLine(line),
      });

      if (matches.length >= limits.max_matches) {
        truncated = true;
        break;
      }
    }
  }

  return { matches, searched_files: searchedFiles, truncated };
}

async function* walkSearchFiles(path: string, request: WorkspaceSearchRequest): AsyncIterable<string> {
  const stats = await lstat(path);
  if (stats.isFile()) {
    yield path;
    return;
  }
  if (!stats.isDirectory()) {
    return;
  }

  const names = await readdir(path);
  names.sort((left, right) => left.localeCompare(right));
  for (const name of names) {
    if (shouldSkipName(name, request)) {
      continue;
    }

    const childPath = resolve(path, name);
    const childStats = await lstat(childPath);
    if (childStats.isDirectory()) {
      yield* walkSearchFiles(childPath, request);
      continue;
    }
    if (childStats.isFile()) {
      yield childPath;
    }
  }
}

function shouldSkipName(name: string, options: { include_hidden?: boolean; include_ignored?: boolean }): boolean {
  if (!options.include_hidden && name.startsWith(".")) {
    return true;
  }
  return !options.include_ignored && DEFAULT_IGNORED_NAMES.has(name);
}

async function readUtf8File(path: string): Promise<string | undefined> {
  try {
    const content = await readFile(path, "utf8");
    return content.includes("\u0000") ? undefined : content;
  } catch {
    return undefined;
  }
}

function clipLine(value: string): string {
  return value.length > 240 ? `${value.slice(0, 237)}...` : value;
}

const DEFAULT_IGNORED_NAMES = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
]);
