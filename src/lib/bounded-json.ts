export const DEFAULT_REQUEST_JSON_LIMIT = 64 * 1024;

export class RequestJsonError extends Error {
  constructor(readonly status: 400 | 413 | 415, message: string) {
    super(message);
    this.name = "RequestJsonError";
  }
}

export class UpstreamResponseTooLargeError extends Error {
  readonly status = 502;

  constructor(readonly limitBytes: number) {
    super(`Upstream JSON response exceeds the ${limitBytes}-byte limit.`);
    this.name = "UpstreamResponseTooLargeError";
  }
}

export async function readRequestJson<T = unknown>(request: Request, limitBytes = DEFAULT_REQUEST_JSON_LIMIT): Promise<T> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") throw new RequestJsonError(415, "Request body must use application/json.");
  const bytes = await readBoundedBytes(request.body, request.headers.get("content-length"), limitBytes, async () => {
    await request.body?.cancel().catch(() => undefined);
  }, (message) => new RequestJsonError(413, message));
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as T;
  } catch {
    throw new RequestJsonError(400, "Request body must be valid JSON.");
  }
}

export async function readUpstreamJson<T = unknown>(response: Response, limitBytes: number): Promise<T | null> {
  const bytes = await readBoundedBytes(response.body, response.headers.get("content-length"), limitBytes, async () => {
    await response.body?.cancel().catch(() => undefined);
  }, () => new UpstreamResponseTooLargeError(limitBytes));
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as T;
  } catch {
    return null;
  }
}

export async function readUpstreamText(response: Response, limitBytes: number): Promise<string | null> {
  const bytes = await readBoundedBytes(response.body, response.headers.get("content-length"), limitBytes, async () => {
    await response.body?.cancel().catch(() => undefined);
  }, () => new UpstreamResponseTooLargeError(limitBytes));
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

async function readBoundedBytes(
  stream: ReadableStream<Uint8Array> | null,
  contentLength: string | null,
  limitBytes: number,
  cancel: () => Promise<void>,
  tooLarge: (message: string) => Error,
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(limitBytes) || limitBytes < 1) throw new RangeError("JSON byte limit must be a positive safe integer.");
  if (contentLength !== null) {
    if (/^\d+$/.test(contentLength) && BigInt(contentLength) > BigInt(limitBytes)) {
      await cancel();
      throw tooLarge(`JSON body exceeds the ${limitBytes}-byte limit.`);
    }
  }
  if (!stream) return new Uint8Array();

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limitBytes) {
        await reader.cancel().catch(() => undefined);
        throw tooLarge(`JSON body exceeds the ${limitBytes}-byte limit.`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
