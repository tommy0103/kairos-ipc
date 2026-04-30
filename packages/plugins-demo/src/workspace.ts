import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { createNode, type IpcNode } from "../../sdk/src/index.ts";

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
}

export interface WorkspaceWriteResult {
  path: string;
  bytes: number;
}

export interface WorkspaceEditRequest {
  path: string;
  old_text: string;
  new_text: string;
}

export interface WorkspaceEditResult {
  path: string;
  replacements: number;
  bytes: number;
}

export interface WorkspacePluginOptions {
  uri?: string;
  root?: string;
  max_read_bytes?: number;
}

export interface WorkspacePlugin {
  node: IpcNode;
  root: string;
}

export function createWorkspacePlugin(options: WorkspacePluginOptions = {}): WorkspacePlugin {
  const node = createNode(options.uri ?? "plugin://local/workspace");
  const root = resolve(options.root ?? process.cwd());
  const maxReadBytes = options.max_read_bytes ?? 1024 * 128;

  node.action<WorkspaceReadRequest, WorkspaceReadResult>(
    "read",
    {
      description: "Read a UTF-8 file under the configured workspace root.",
      accepts: "application/json",
      returns: "application/json",
    },
    async (payload) => {
      const request = payload.data;
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

  node.action<WorkspaceWriteRequest, WorkspaceWriteResult>(
    "write",
    {
      description: "Write a UTF-8 file under the configured workspace root.",
      accepts: "application/json",
      returns: "application/json",
    },
    async (payload) => {
      const request = normalizeWriteRequest(payload.data);
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
    },
    async (payload) => {
      const request = normalizeEditRequest(payload.data);
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

function normalizeWriteRequest(value: WorkspaceWriteRequest): WorkspaceWriteRequest {
  if (!value || typeof value.path !== "string" || typeof value.content !== "string") {
    throw new Error("workspace.write requires path and content");
  }
  return value;
}

function normalizeEditRequest(value: WorkspaceEditRequest): WorkspaceEditRequest {
  if (!value || typeof value.path !== "string" || typeof value.old_text !== "string" || typeof value.new_text !== "string") {
    throw new Error("workspace.edit requires path, old_text, and new_text");
  }
  if (value.old_text.length === 0) {
    throw new Error("workspace.edit old_text must be non-empty");
  }
  return value;
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
