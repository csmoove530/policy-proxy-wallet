import { randomInt } from "node:crypto";
import type { PaymentRequest } from "../policy/types.js";

interface PendingApproval {
  request: PaymentRequest;
  resolve: (approved: boolean) => void;
  timeout: NodeJS.Timeout;
  createdAt: number;
  pin: string;
}

const pending = new Map<string, PendingApproval>();

/**
 * Generate a cryptographically random 6-digit PIN.
 * Written to stderr (operator console) so the agent never sees it.
 */
function generatePin(): string {
  return randomInt(100_000, 1_000_000).toString();
}

/**
 * Create a pending approval and wait for human response.
 * Returns { promise, message, pin }. The caller MUST write pin to stderr only —
 * never include it in the tool response returned to the agent.
 */
export function requestApproval(
  request: PaymentRequest,
  timeoutSeconds: number,
): { promise: Promise<boolean>; message: string; pin: string } {
  const pin = generatePin();
  const message = formatApprovalMessage(request);

  const promise = new Promise<boolean>((resolve) => {
    const timeout = setTimeout(() => {
      pending.delete(request.id);
      resolve(false);
    }, timeoutSeconds * 1000);

    pending.set(request.id, { request, resolve, timeout, createdAt: Date.now(), pin });
  });

  return { promise, message, pin };
}

export type ApprovalResponseResult = "approved" | "not_found" | "invalid_pin";

/**
 * Handle a human approval/denial callback.
 * The PIN must match the one printed to the operator console at request time.
 */
export function handleApprovalResponse(
  approvalId: string,
  pin: string,
  approved: boolean,
): ApprovalResponseResult {
  const entry = pending.get(approvalId);
  if (!entry) return "not_found";
  if (entry.pin !== pin) return "invalid_pin";

  clearTimeout(entry.timeout);
  pending.delete(approvalId);
  entry.resolve(approved);
  return "approved";
}

/**
 * Get count of pending approvals.
 */
export function pendingCount(): number {
  return pending.size;
}

/**
 * Cancel all pending approvals (used on freeze).
 */
export function denyAllPending(): number {
  let count = 0;
  for (const [id, entry] of pending) {
    clearTimeout(entry.timeout);
    entry.resolve(false);
    count++;
  }
  pending.clear();
  return count;
}

function formatApprovalMessage(request: PaymentRequest): string {
  let domain: string;
  try {
    domain = new URL(request.serviceUrl).hostname;
  } catch {
    domain = request.serviceUrl;
  }

  return [
    `🔔 Payment Request #${request.id.slice(0, 8)}`,
    ``,
    `Service:     ${domain}`,
    `Amount:      $${request.amountUSD.toFixed(4)} ${request.token}`,
    `Category:    ${request.category}`,
    `Description: ${request.description}`,
  ].join("\n");
}
