import type { MattermostBotClientOptions, MattermostCreatePostRequest, MattermostDialogRequest, MattermostPostResponse, MattermostUpdatePostRequest } from "./types.ts";

export class MattermostRestError extends Error {
  readonly status: number;
  readonly statusText: string;
  readonly body: string;

  constructor(message: string, status: number, statusText: string, body: string) {
    super(message);
    this.name = "MattermostRestError";
    this.status = status;
    this.statusText = statusText;
    this.body = body;
  }
}

export class MattermostBotClient {
  private readonly baseUrl: string;
  private readonly botToken: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: MattermostBotClientOptions) {
    this.baseUrl = trimTrailingSlashes(options.mattermost_base_url);
    this.botToken = options.bot_token;
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeout_ms ?? 15000;
  }

  createPost(post: MattermostCreatePostRequest): Promise<MattermostPostResponse> {
    return this.request<MattermostPostResponse>("/api/v4/posts", "POST", post);
  }

  updatePost(postId: string, post: MattermostUpdatePostRequest): Promise<MattermostPostResponse> {
    return this.request<MattermostPostResponse>(`/api/v4/posts/${encodeURIComponent(postId)}`, "PUT", { ...post, id: postId });
  }

  openDialog(dialog: MattermostDialogRequest): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>("/api/v4/actions/dialogs/open", "POST", dialog);
  }

  private async request<T>(path: string, method: "POST" | "PUT", body: unknown): Promise<T> {
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const fetchPromise = this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${this.botToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    });
    const response = await (this.timeoutMs > 0
      ? Promise.race([
        fetchPromise,
        new Promise<Response>((_resolve, reject) => {
          timeout = setTimeout(() => {
            controller.abort();
            reject(new MattermostRestError(`Mattermost ${method} ${path} timed out`, 504, "Gateway Timeout", ""));
          }, this.timeoutMs);
          (timeout as { unref?: () => void }).unref?.();
        }),
      ])
      : fetchPromise).finally(() => {
        if (timeout) clearTimeout(timeout);
      });

    const text = await response.text();
    if (!response.ok) {
      throw new MattermostRestError(`Mattermost ${method} ${path} failed with ${response.status} ${response.statusText}`, response.status, response.statusText, text);
    }

    if (!text.trim()) {
      return {} as T;
    }

    try {
      return JSON.parse(text) as T;
    } catch (error) {
      throw new MattermostRestError(`Mattermost ${method} ${path} returned invalid JSON`, response.status, response.statusText, text);
    }
  }
}

export function createMattermostBotClient(options: MattermostBotClientOptions): MattermostBotClient {
  return new MattermostBotClient(options);
}

function trimTrailingSlashes(value: string): string {
  const trimmed = value.trim().replace(/\/+$/g, "");
  if (!trimmed) {
    throw new Error("Mattermost base URL is required");
  }
  return trimmed;
}
