import { createNode, z, type IpcNode } from "../../sdk/src/index.ts";

export interface BrowserReadPageRequest {
  url: string;
  max_bytes?: number;
  max_redirects?: number;
  include_headers?: boolean;
}

export interface BrowserReadPageResult {
  url: string;
  final_url: string;
  status: number;
  ok: boolean;
  content_type?: string;
  title?: string;
  text: string;
  bytes: number;
  truncated: boolean;
  redirects: number;
  headers?: Record<string, string>;
}

export interface BrowserPluginOptions {
  uri?: string;
  allowed_origins?: string[] | null;
  timeout_ms?: number;
  max_read_bytes?: number;
  user_agent?: string;
}

export interface BrowserPlugin {
  node: IpcNode;
}

const SAFE_RESPONSE_HEADERS = new Set(["cache-control", "content-language", "content-length", "content-type", "etag", "last-modified", "location"]);

const readPageRequestSchema = z.object({
  url: z.string().url().describe("HTTP(S) URL to read. If the plugin is configured with allowed_origins, non-matching origins are rejected."),
  max_bytes: z.number().int().positive().optional().describe("Maximum response bytes to decode. The plugin clamps this to its configured limit."),
  max_redirects: z.number().int().min(0).optional().describe("Maximum same-policy redirects to follow. Defaults to 5 and is capped at 10."),
  include_headers: z.boolean().optional().describe("When true, include a small allowlisted subset of response headers."),
}).describe("Read a bounded HTTP(S) page snapshot through the local browser plugin.");

const readPageResultSchema = z.object({
  url: z.string().describe("Original requested URL."),
  final_url: z.string().describe("Final URL after allowed redirects."),
  status: z.number().int().describe("HTTP response status code."),
  ok: z.boolean().describe("True when the HTTP status is in the 2xx range."),
  content_type: z.string().optional().describe("Response Content-Type header when present."),
  title: z.string().optional().describe("HTML title when a title element is present."),
  text: z.string().describe("Bounded UTF-8 text extracted from the response. HTML responses are reduced to readable text."),
  bytes: z.number().int().describe("Returned raw byte count before text extraction."),
  truncated: z.boolean().describe("True when the response was clipped by max_bytes or the configured limit."),
  redirects: z.number().int().describe("Number of redirects followed."),
  headers: z.record(z.string(), z.string()).optional().describe("Allowlisted response headers when include_headers is true."),
}).describe("Browser page snapshot response.");

export function createBrowserPlugin(options: BrowserPluginOptions = {}): BrowserPlugin {
  const uri = options.uri ?? "plugin://local/browser";
  const node = createNode(uri);
  const allowedOrigins = options.allowed_origins ?? null;
  const timeoutMs = options.timeout_ms ?? 10000;
  const maxReadBytes = options.max_read_bytes ?? 1024 * 128;
  const userAgent = options.user_agent ?? "KairosIPC-BrowserPlugin/0.1";

  node.action<BrowserReadPageRequest, BrowserReadPageResult>(
    "read_page",
    {
      description: "Read a bounded HTTP(S) page snapshot. Set allowed_origins in daemon config when you want origin restrictions.",
      accepts: "application/json",
      returns: "application/json",
      input: readPageRequestSchema,
      output: readPageResultSchema,
      input_name: "BrowserReadPageRequest",
      output_name: "BrowserReadPageResult",
    },
    async ({ input }) => {
      const requestUrl = normalizeHttpUrl(input.url);
      const limit = clampLimit(input.max_bytes, maxReadBytes);
      const maxRedirects = clampRedirects(input.max_redirects);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(new Error(`browser.read_page timed out after ${timeoutMs}ms`)), timeoutMs);

      try {
        const { response, finalUrl, redirects } = await fetchWithAllowedRedirects(requestUrl, {
          allowed_origins: allowedOrigins,
          max_redirects: maxRedirects,
          signal: controller.signal,
          user_agent: userAgent,
        });
        const contentType = response.headers.get("content-type") ?? undefined;
        const raw = Buffer.from(await response.arrayBuffer());
        const clipped = raw.subarray(0, limit);
        const rawText = clipped.toString("utf8");
        const text = responseText(contentType, rawText);
        const result: BrowserReadPageResult = {
          url: requestUrl.href,
          final_url: finalUrl.href,
          status: response.status,
          ok: response.ok,
          content_type: contentType,
          title: extractTitle(contentType, rawText),
          text,
          bytes: clipped.byteLength,
          truncated: raw.byteLength > limit,
          redirects,
          ...(input.include_headers ? { headers: pickSafeHeaders(response.headers) } : {}),
        };

        return { mime_type: "application/json", data: result };
      } catch (error) {
        if (controller.signal.aborted) {
          throw new Error(error instanceof Error ? error.message : `browser.read_page timed out after ${timeoutMs}ms`);
        }
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    },
  );

  return { node };
}

async function fetchWithAllowedRedirects(
  startUrl: URL,
  options: {
    allowed_origins: string[] | null;
    max_redirects: number;
    signal: AbortSignal;
    user_agent: string;
  },
): Promise<{ response: Response; finalUrl: URL; redirects: number }> {
  let current = startUrl;
  for (let redirects = 0; redirects <= options.max_redirects; redirects++) {
    assertAllowedOrigin(current, options.allowed_origins);
    const response = await fetch(current, {
      method: "GET",
      redirect: "manual",
      signal: options.signal,
      headers: {
        accept: "text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.5",
        "user-agent": options.user_agent,
      },
    });

    const location = response.headers.get("location");
    if (!isRedirectStatus(response.status) || !location) {
      return { response, finalUrl: current, redirects };
    }

    if (redirects >= options.max_redirects) {
      throw new Error(`browser.read_page exceeded max_redirects=${options.max_redirects}`);
    }

    current = normalizeHttpUrl(new URL(location, current).href);
  }

  throw new Error("browser.read_page redirect handling failed");
}

function normalizeHttpUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`browser.read_page only supports HTTP(S) URLs: ${value}`);
  }
  return url;
}

function assertAllowedOrigin(url: URL, allowedOrigins: string[] | null): void {
  if (allowedOrigins === null || allowedOrigins.includes("*")) {
    return;
  }

  if (!allowedOrigins.some((pattern) => originMatches(url, pattern))) {
    throw new Error(`browser.read_page origin is not allowlisted: ${url.origin}`);
  }
}

function originMatches(url: URL, pattern: string): boolean {
  try {
    const next = new URL(pattern);
    return next.protocol === url.protocol
      && normalizeHostname(next.hostname) === normalizeHostname(url.hostname)
      && (!next.port || next.port === url.port);
  } catch {
    return false;
  }
}

function normalizeHostname(value: string): string {
  return value.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
}

function clampLimit(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(1, Math.min(Math.trunc(value), fallback));
}

function clampRedirects(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 5;
  }
  return Math.max(0, Math.min(Math.trunc(value), 10));
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function responseText(contentType: string | undefined, text: string): string {
  if (isHtml(contentType)) {
    return htmlToText(text);
  }
  return text;
}

function extractTitle(contentType: string | undefined, text: string): string | undefined {
  if (!isHtml(contentType)) {
    return undefined;
  }
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(text);
  return match ? compactWhitespace(decodeHtmlEntities(stripTags(match[1]))).slice(0, 240) : undefined;
}

function htmlToText(html: string): string {
  const withoutHidden = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ");
  const withBreaks = withoutHidden.replace(/<(br|\/p|\/div|\/section|\/article|\/li|\/h[1-6])\b[^>]*>/gi, "\n");
  return compactWhitespace(decodeHtmlEntities(stripTags(withBreaks)));
}

function stripTags(value: string): string {
  return value.replace(/<[^>]*>/g, " ");
}

function compactWhitespace(value: string): string {
  return value.replace(/[\t ]+/g, " ").replace(/\s*\n\s*/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (match, code) => {
      const point = Number(code);
      return Number.isInteger(point) && point >= 0 && point <= 0x10ffff ? String.fromCodePoint(point) : match;
    });
}

function isHtml(contentType: string | undefined): boolean {
  return typeof contentType === "string" && contentType.toLowerCase().includes("html");
}

function pickSafeHeaders(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of headers) {
    if (SAFE_RESPONSE_HEADERS.has(name.toLowerCase())) {
      result[name.toLowerCase()] = value;
    }
  }
  return result;
}
