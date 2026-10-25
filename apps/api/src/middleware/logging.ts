/** Logs retain operational identifiers, never provider bodies or request content. */
export function safeErrorInfo(error: unknown): { type: string; message: string; stack: string; code?: string } {
  const value = error as { name?: unknown; code?: unknown } | null;
  const knownTypes = new Set(["Error", "TypeError", "RangeError", "TimeoutError", "PermanentError", "AbortError"]);
  const type = typeof value?.name === "string" && knownTypes.has(value.name) ? value.name : "Error";
  const code = typeof value?.code === "string" && /^(?:[0-9A-Z]{5}|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND)$/.test(value.code) ? value.code : undefined;
  const safe = { type, message: "[redacted]", stack: "[redacted]" };
  return code ? { ...safe, code } : safe;
}

export function safeRequestInfo(request: { method?: string; routeOptions?: { url?: string } }) {
  return { method: request.method, route: request.routeOptions?.url ?? "<unmatched>" };
}
