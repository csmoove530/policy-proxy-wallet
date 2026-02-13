import type { PaymentRequest } from "../policy/types.js";

interface PendingApproval {
  request: PaymentRequest;
  resolve: (approved: boolean) => void;
  timeout: NodeJS.Timeout;
  createdAt: number;
}

const pending = new Map<string, PendingApproval>();

/**
 * Create a pending approval and wait for human response.
 * Returns true if approved, false if denied or timed out.
 */
export function requestApproval(
  request: PaymentRequest,
  timeoutSeconds: number,
): { promise: Promise<boolean>; message: string } {
  const message = formatApprovalMessage(request);

  const promise = new Promise<boolean>((resolve) => {
    const timeout = setTimeout(() => {
      pending.delete(request.id);
      resolve(false);
    }, timeoutSeconds * 1000);

    pending.set(request.id, { request, resolve, timeout, createdAt: Date.now() });
  });

  return { promise, message };
}

/**
 * Handle a human approval/denial callback.
 */
export function handleApprovalResponse(approvalId: string, approved: boolean): boolean {
  const entry = pending.get(approvalId);
  if (!entry) return false;

  clearTimeout(entry.timeout);
  pending.delete(approvalId);
  entry.resolve(approved);
  return true;
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
