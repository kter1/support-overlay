/**
 * @support-overlay/api — error handling and request validation
 *
 * One error shape for every failure, and no internal detail in any of them.
 * Routes previously returned raw messages straight from thrown errors, which
 * leaked Postgres text — table names, constraint names, and at least once the
 * literal SQL — to any caller who could trigger a 500.
 */
import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z, ZodError, ZodTypeAny } from "zod";

export interface ErrorBody {
  error: string;
  /** What the caller can do about it, when there is something. */
  hint?: string;
  /** Field-level problems for validation failures. */
  details?: Array<{ field: string; message: string }>;
  correlation_id?: string;
}

/**
 * A failure whose message is safe to show the caller. Anything not thrown as
 * one of these is treated as internal and reported generically.
 */
export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    readonly hint?: string
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export const badRequest = (message: string, hint?: string) =>
  new ApiError(400, message, hint);
export const notFound = (message: string, hint?: string) =>
  new ApiError(404, message, hint);
export const conflict = (message: string, hint?: string) =>
  new ApiError(409, message, hint);
export const forbidden = (message: string, hint?: string) =>
  new ApiError(403, message, hint);

/**
 * Validate and narrow route parameters.
 *
 * Without this, a malformed id reaches Postgres and comes back as
 * "invalid input syntax for type uuid", which is both a 500 for what is really
 * a client mistake and a small leak of the storage layer.
 */
export function parseParams<S extends ZodTypeAny>(
  schema: S,
  params: unknown
): z.infer<S> {
  const result = schema.safeParse(params);
  if (result.success) return result.data;

  const error = new ApiError(400, "Request path is not valid");
  (error as ApiError & { details?: unknown }).details = zodDetails(result.error);
  throw error;
}

/**
 * Validate and narrow a request body. Throws an ApiError carrying field-level
 * detail, which is safe: it describes the caller's own input, not ours.
 */
export function parseBody<S extends ZodTypeAny>(
  schema: S,
  body: unknown
): z.infer<S> {
  const result = schema.safeParse(body);
  if (result.success) return result.data;

  const error = new ApiError(400, "Request body is not valid");
  (error as ApiError & { details?: unknown }).details = zodDetails(result.error);
  throw error;
}

function zodDetails(error: ZodError): Array<{ field: string; message: string }> {
  return error.errors.map((issue) => ({
    field: issue.path.join(".") || "(root)",
    message: issue.message,
  }));
}

/**
 * Register the global error handler and 404 handler.
 *
 * Unexpected errors are logged in full and reported as a bare 500. The
 * correlation id is the bridge: the caller quotes it, and it locates the real
 * error in the logs without ever putting that detail on the wire.
 */
export function registerErrorHandling(app: FastifyInstance): void {
  app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
    void reply.status(404).send({
      error: "No such endpoint",
      correlation_id: request.correlationId,
    } satisfies ErrorBody);
  });

  app.setErrorHandler((error, request, reply) => {
    const correlationId = request.correlationId;

    if (error instanceof ApiError) {
      const body: ErrorBody = {
        error: error.message,
        correlation_id: correlationId,
      };
      if (error.hint) body.hint = error.hint;

      const details = (error as ApiError & {
        details?: Array<{ field: string; message: string }>;
      }).details;
      if (details) body.details = details;

      void reply.status(error.statusCode).send(body);
      return;
    }

    // Fastify's own validation and body-parse failures are caller-facing.
    const statusCode = (error as { statusCode?: number }).statusCode;
    if (typeof statusCode === "number" && statusCode >= 400 && statusCode < 500) {
      void reply.status(statusCode).send({
        error: statusCode === 400 ? "Request could not be parsed" : "Request rejected",
        correlation_id: correlationId,
      } satisfies ErrorBody);
      return;
    }

    request.log.error(
      { err: error, correlationId, url: request.url, method: request.method },
      "Unhandled request error"
    );

    void reply.status(500).send({
      error: "Internal error",
      hint: `Quote correlation id ${correlationId} when reporting this.`,
      correlation_id: correlationId,
    } satisfies ErrorBody);
  });
}
