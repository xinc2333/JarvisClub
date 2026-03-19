const ALLOWED_ACTION_TYPES = new Set([
  "observe_space",
  "start_activity",
  "finish_activity",
  "join_activity",
  "relationship_changed",
  "watch_player",
  "react_event",
  "post_update",
  "post_created",
  "idle",
]);

const HIGH_RISK_ACTION_TYPES = new Set([
  "payment",
  "transfer",
  "purchase",
  "trade",
  "subscribe",
  "withdraw",
  "wallet_operation",
  "credential_reset",
  "account_binding_external",
]);

const SENSITIVE_CONTENT_PATTERNS = [
  /hc_[a-z0-9]{6,}/i,
  /agt_[a-z0-9]{6,}/i,
  /\b(?:api[_-]?key|password|wallet|银行卡|验证码|credit\s*card|bank\s*card)\b/i,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
  /(?<!\d)1\d{10}(?!\d)/,
];

function inspectTickSafety(output) {
  if (!ALLOWED_ACTION_TYPES.has(output.actionType) || HIGH_RISK_ACTION_TYPES.has(output.actionType)) {
    return {
      ok: false,
      status: 422,
      diagnosticType: "guardrail_high_risk_action_blocked",
      ruleName: "action_type_rejected",
      error: `Action type "${output.actionType}" is not allowed by safety guardrails.`,
    };
  }

  for (const event of output.emittedEvents || []) {
    if (!ALLOWED_ACTION_TYPES.has(event.type) || HIGH_RISK_ACTION_TYPES.has(event.type)) {
      return {
        ok: false,
        status: 422,
        diagnosticType: "guardrail_high_risk_action_blocked",
        ruleName: "event_type_rejected",
        error: `Event type "${event.type}" is not allowed by safety guardrails.`,
      };
    }

    const summary = typeof event?.payload?.summary === "string" ? event.payload.summary : "";
    const matchedPattern = SENSITIVE_CONTENT_PATTERNS.find((pattern) => pattern.test(summary));
    if (matchedPattern) {
      return {
        ok: false,
        status: 422,
        diagnosticType: "guardrail_sensitive_content_blocked",
        ruleName: "sensitive_content_blocked",
        error: "Submitted event content contains sensitive information and was blocked.",
      };
    }
  }

  return { ok: true };
}

module.exports = {
  inspectTickSafety,
};
