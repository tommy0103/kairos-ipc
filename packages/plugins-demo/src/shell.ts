import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createNode, type IpcNode } from "../../sdk/src/index.ts";
import {
  SLOCK_SHELL_EXEC_MIME,
  SLOCK_SHELL_RESULT_MIME,
  type SlockShellExecRequest,
  type SlockShellExecResult,
} from "../../slock-channel/src/index.ts";

const execFileAsync = promisify(execFile);

export interface ShellPluginOptions {
  uri?: string;
  cwd?: string;
  allowed_commands?: string[] | null;
  timeout_ms?: number;
  max_buffer_bytes?: number;
}

export interface ShellPlugin {
  node: IpcNode;
}

export function createShellPlugin(options: ShellPluginOptions = {}): ShellPlugin {
  const node = createNode(options.uri ?? "plugin://local/shell");
  const allowed = options.allowed_commands === null
    ? null
    : new Set(options.allowed_commands ?? ["pwd", "echo", "ls"]);
  const defaultCwd = options.cwd ?? process.cwd();
  const timeoutMs = options.timeout_ms ?? 5000;
  const maxBuffer = options.max_buffer_bytes ?? 1024 * 128;

  node.action<SlockShellExecRequest, SlockShellExecResult>(
    "exec",
    {
      description: allowed
        ? "Execute an allowlisted local command without shell expansion."
        : "Execute an approved local command without shell expansion.",
      accepts: SLOCK_SHELL_EXEC_MIME,
      returns: SLOCK_SHELL_RESULT_MIME,
    },
    async (payload) => {
      const request = normalizeRequest(payload.data);
      if (allowed && !allowed.has(request.command)) {
        throw new Error(`command is not allowed: ${request.command}`);
      }

      const cwd = request.cwd ?? defaultCwd;
      try {
        const result = await execFileAsync(request.command, request.args ?? [], {
          cwd,
          timeout: timeoutMs,
          maxBuffer,
          windowsHide: true,
        });

        return {
          mime_type: SLOCK_SHELL_RESULT_MIME,
          data: {
            command: request.command,
            args: request.args ?? [],
            cwd,
            exit_code: 0,
            stdout: result.stdout,
            stderr: result.stderr,
          },
        };
      } catch (error) {
        const execError = error as { stdout?: string; stderr?: string; code?: number | string; message?: string };
        return {
          mime_type: SLOCK_SHELL_RESULT_MIME,
          data: {
            command: request.command,
            args: request.args ?? [],
            cwd,
            exit_code: typeof execError.code === "number" ? execError.code : 1,
            stdout: execError.stdout ?? "",
            stderr: execError.stderr ?? execError.message ?? "command failed",
          },
        };
      }
    },
  );

  return { node };
}

function normalizeRequest(value: SlockShellExecRequest): Required<Pick<SlockShellExecRequest, "command" | "args">> & Pick<SlockShellExecRequest, "cwd"> {
  if (!value || typeof value.command !== "string" || value.command.trim().length === 0) {
    throw new Error("shell.exec requires a command");
  }

  if (value.command.includes("/")) {
    throw new Error("shell.exec command must be a bare executable name");
  }

  const args = value.args ?? [];
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
    throw new Error("shell.exec args must be an array of strings");
  }

  return {
    command: value.command.trim(),
    args,
    cwd: value.cwd,
  };
}
