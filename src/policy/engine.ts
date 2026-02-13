import type { PolicyConfig, PaymentRequest, PolicyDecision } from "./types.js";
import type { SpendingLedger } from "./ledger.js";

/**
 * Evaluate a payment request against the policy config.
 * Rules evaluated in order. First denial wins.
 * Pure function: no side effects.
 */
export function evaluatePolicy(
  request: PaymentRequest,
  config: PolicyConfig,
  ledger: SpendingLedger,
): PolicyDecision {
  // 1. Kill switch
  if (!config.enabled) {
    return { action: "deny", reason: "Wallet is frozen" };
  }

  // 2. Per-transaction cap
  if (request.amountUSD > config.limits.perTransaction.maxAmountUSD) {
    return {
      action: "deny",
      reason: `Exceeds per-tx cap: $${request.amountUSD} > $${config.limits.perTransaction.maxAmountUSD}`,
    };
  }

  // 3. Session/daily cap
  const recentSpend = ledger.totalSpentInWindow(config.limits.perSession.windowSeconds);
  const projectedSpend = recentSpend + request.amountUSD;
  if (projectedSpend > config.limits.perSession.maxAmountUSD) {
    return {
      action: "deny",
      reason: `Would exceed daily cap: $${projectedSpend.toFixed(2)} > $${config.limits.perSession.maxAmountUSD} (already spent: $${recentSpend.toFixed(2)})`,
    };
  }

  // 4. Cooldown
  const recentTxCount = ledger.transactionCountInWindow(config.limits.cooldown.windowSeconds);
  if (recentTxCount >= config.limits.cooldown.maxTransactions) {
    return {
      action: "deny",
      reason: `Cooldown active: ${recentTxCount} txs in last ${config.limits.cooldown.windowSeconds}s (max ${config.limits.cooldown.maxTransactions})`,
    };
  }

  // 5. Whitelist
  if (config.whitelist.enabled) {
    try {
      const domain = new URL(request.serviceUrl).hostname;
      if (!config.whitelist.domains.includes(domain)) {
        return {
          action: "deny",
          reason: `Domain not whitelisted: ${domain}`,
        };
      }
    } catch {
      return { action: "deny", reason: `Invalid service URL: ${request.serviceUrl}` };
    }
  }

  // 6. Category check
  if (config.whitelist.enabled && config.whitelist.categories.length > 0) {
    if (!config.whitelist.categories.includes(request.category)) {
      return {
        action: "deny",
        reason: `Category not allowed: ${request.category}`,
      };
    }
  }

  // 7. Auto-approve threshold
  if (config.autoApprove.enabled && request.amountUSD <= config.autoApprove.maxAmountUSD) {
    return { action: "approve", reason: "Auto-approved (below threshold)" };
  }

  // 8. Needs human approval
  if (config.humanApproval.enabled) {
    return {
      action: "require_human_approval",
      reason: `Amount $${request.amountUSD} exceeds auto-approve threshold of $${config.autoApprove.maxAmountUSD}`,
    };
  }

  // If human approval is disabled and amount exceeds auto-approve, deny
  return {
    action: "deny",
    reason: `Amount $${request.amountUSD} exceeds auto-approve threshold and human approval is disabled`,
  };
}
