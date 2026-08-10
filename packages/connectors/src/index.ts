/**
 * @iisl/connectors — provider adapters.
 *
 * Adapters classify their failures (TimeoutError / PermanentError / retriable)
 * so the outbox worker can apply the right retry policy per action. See
 * packages/shared for those error types.
 */
export {
  ZendeskAdapter,
  simulatorStore,
  type TicketConversation,
  type ConversationMessage,
} from "./zendesk/adapter";
export {
  StripeAdapter,
  stripeSimulator,
  type StripeRefund,
  type StripeCharge,
  type CreateRefundInput,
} from "./stripe/adapter";
export {
  ShopifyAdapter,
  SourceUnavailableError,
  type ShopifyOrder,
} from "./shopify/adapter";
