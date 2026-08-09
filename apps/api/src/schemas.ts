/**
 * @support-overlay/api — request schemas
 *
 * Every mutating endpoint validates its body here rather than casting an
 * `unknown` body and hoping. The action route in particular reached the
 * database with whatever shape it was handed.
 */
import { z } from "zod";
import { ActionType } from "@iisl/shared";

/** Idempotency keys are echoed into logs, so bound their size and charset. */
const idempotencyKey = z
  .string()
  .min(8, "must be at least 8 characters")
  .max(200)
  .regex(/^[A-Za-z0-9._:-]+$/, "may contain letters, digits, and . _ : -");

const uuid = z.string().uuid("must be a UUID");

export const initiateActionBody = z.object({
  action_type: z.nativeEnum(ActionType, {
    errorMap: () => ({
      message: `must be one of: ${Object.values(ActionType).join(", ")}`,
    }),
  }),
  issue_id: uuid,
  idempotency_key: idempotencyKey,
  action_params: z
    .record(z.unknown())
    .optional()
    .transform((value): Record<string, unknown> => value ?? {}),
});

export const grantApprovalBody = z
  .object({
    notes: z.string().max(2000).optional(),
  })
  .default({});

export const denyApprovalBody = z
  .object({
    reason: z.string().max(2000).optional(),
  })
  .default({});

export const reconcileBody = z.object({
  external_side_effect_status: z.enum([
    "CONFIRMED_OCCURRED",
    "CONFIRMED_NOT_OCCURRED",
    "UNKNOWN",
  ]),
  // Required: a reconciliation with no account of what was checked is not a
  // reconciliation, and this row is what an auditor reads later.
  investigation_notes: z.string().min(10, "describe what was verified").max(4000),
  corrective_action_taken: z.string().max(4000).optional(),
});

/**
 * Operator repair endpoints require a stated reason. It is written to the audit
 * log and is the only record of why a manual intervention happened.
 */
export const operatorRepairBody = z.object({
  reason: z.string().min(5, "explain why this repair is needed").max(2000),
});

export const syncZendeskBody = z.object({
  reason: z.string().min(5, "explain why this sync is needed").max(2000),
  target_status: z.enum(["new", "open", "pending", "hold", "solved", "closed"]),
});
