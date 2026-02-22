import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { isAddress } from "ethers";

import { loadConfig } from "./config/loader.js";
import { evaluatePolicy } from "./policy/engine.js";
import { SpendingLedger } from "./policy/ledger.js";
import type { PaymentRequest, AuditEntry } from "./policy/types.js";
import { AuditLog } from "./audit/log.js";
import { getBalance, sendUSDC, type WalletConfig } from "./custody/local-wallet.js";
import { requestApproval, handleApprovalResponse, pendingCount, denyAllPending } from "./approval/pending.js";

// Paths
const WORKSPACE = process.env.WORKSPACE || join(process.env.HOME || "/home/node", ".openclaw/workspace");
const PROJECT_DIR = join(WORKSPACE, "policy-proxy-wallet");
const CONFIG_PATH = process.env.POLICY_CONFIG_PATH || join(PROJECT_DIR, "config/policy.json");
const KEYSTORE_PATH = process.env.KEYSTORE_PATH || join(PROJECT_DIR, "config/keystore.json");
const DB_PATH = process.env.AUDIT_DB_PATH || join(PROJECT_DIR, "data/audit.db");
const WALLET_PASSPHRASE = process.env.WALLET_PASSPHRASE;
if (!WALLET_PASSPHRASE) {
  console.error("Fatal: WALLET_PASSPHRASE environment variable is not set. Cannot start server.");
  process.exit(1);
}

const SUPPORTED_NETWORKS = ["base"];

// Initialize components
const auditLog = new AuditLog(DB_PATH);
const ledger = new SpendingLedger();

// Load spending history into ledger
const config = loadConfig(CONFIG_PATH);
const history = auditLog.getPaidEntriesForWindow(config.limits.perSession.windowSeconds);
ledger.loadHistory(history);

const walletConfig: WalletConfig = {
  keystorePath: KEYSTORE_PATH,
  passphrase: WALLET_PASSPHRASE,
};

// Zod schemas for tool inputs (issue #3)
const PayArgsSchema = z.object({
  serviceUrl: z.string().min(1, "serviceUrl is required"),
  payTo: z.string().refine((v) => isAddress(v), "payTo must be a valid Ethereum address"),
  amount: z.string().min(1, "amount is required").refine((v) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0;
  }, "amount must be a positive finite number"),
  token: z.string().default("USDC"),
  network: z.string().default("base").refine((v) => SUPPORTED_NETWORKS.includes(v), {
    message: `Unsupported network. Supported: ${SUPPORTED_NETWORKS.join(", ")}`,
  }),
  description: z.string().min(1, "description is required"),
  category: z.string().default("uncategorized"),
});

const ApproveArgsSchema = z.object({
  approvalId: z.string().min(1, "approvalId is required"),
  approved: z.boolean(),
  pin: z.string().min(1, "pin is required"),
});

const HistoryArgsSchema = z.object({
  limit: z.number().int().positive().default(10),
});

// MCP Server
const server = new Server(
  { name: "policy-proxy-wallet", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

// Tool definitions -- issue #1: removed policy_wallet_configure
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "policy_wallet_balance",
      description: "Check wallet USDC balance and remaining daily allowance",
      inputSchema: { type: "object" as const, properties: {} },
    },
    {
      name: "policy_wallet_pay",
      description: "Submit an x402 payment request. Goes through policy evaluation before execution.",
      inputSchema: {
        type: "object" as const,
        properties: {
          serviceUrl: { type: "string" as const, description: "The x402 endpoint URL" },
          payTo: { type: "string" as const, description: "Recipient address (from 402 response)" },
          amount: { type: "string" as const, description: "Amount in token base units (e.g., 50000 for $0.05 USDC)" },
          token: { type: "string" as const, default: "USDC" },
          network: { type: "string" as const, default: "base" },
          description: { type: "string" as const, description: "What this payment is for" },
          category: { type: "string" as const, description: "Service category (e.g., image-generation)" },
        },
        required: ["serviceUrl", "payTo", "amount", "description"],
      },
    },
    {
      name: "policy_wallet_history",
      description: "View recent transaction history",
      inputSchema: {
        type: "object" as const,
        properties: {
          limit: { type: "number" as const, default: 10, description: "Number of entries to return" },
        },
      },
    },
    {
      name: "policy_wallet_status",
      description: "Check policy configuration, spending limits, and remaining allowances",
      inputSchema: { type: "object" as const, properties: {} },
    },
    {
      name: "policy_wallet_approve",
      description: "Approve or deny a pending payment request (human-in-the-loop). The human must provide the one-time PIN printed to their console — ask the human for it before calling this tool.",
      inputSchema: {
        type: "object" as const,
        properties: {
          approvalId: { type: "string" as const, description: "The approval request ID" },
          approved: { type: "boolean" as const, description: "true to approve, false to deny" },
          pin: { type: "string" as const, description: "One-time PIN shown on the operator console — must be provided by the human" },
        },
        required: ["approvalId", "approved", "pin"],
      },
    },
  ],
}));

// Tool handlers
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "policy_wallet_balance":
        return await handleBalance();
      case "policy_wallet_pay":
        return await handlePay(args as Record<string, unknown>);
      case "policy_wallet_history":
        return handleHistory(args as Record<string, unknown>);
      case "policy_wallet_status":
        return handleStatus();
      case "policy_wallet_approve":
        return handleApprove(args as Record<string, unknown>);
      // issue #1: removed policy_wallet_configure handler
      default:
        return { content: [{ type: "text" as const, text: `Unknown tool: ${name}` }], isError: true };
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true };
  }
});

async function handleBalance() {
  try {
    const currentConfig = loadConfig(CONFIG_PATH);
    const { address, balanceUSDC } = await getBalance(walletConfig);
    const spent = ledger.totalSpentInWindow(currentConfig.limits.perSession.windowSeconds);
    const remaining = Math.max(0, currentConfig.limits.perSession.maxAmountUSD - spent);

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          address,
          balanceUSDC,
          dailyAllowance: {
            limit: currentConfig.limits.perSession.maxAmountUSD,
            spent: Number(spent.toFixed(4)),
            remaining: Number(remaining.toFixed(4)),
          },
          autoApproveMax: currentConfig.autoApprove.maxAmountUSD,
        }, null, 2),
      }],
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true };
  }
}

async function handlePay(args: Record<string, unknown>) {
  // Issue #3: validate inputs with Zod
  const parsed = PayArgsSchema.safeParse(args);
  if (!parsed.success) {
    const errors = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ status: "error", validation: errors }) }],
      isError: true,
    };
  }
  const { serviceUrl, payTo, amount, token, network, description, category } = parsed.data;

  const currentConfig = loadConfig(CONFIG_PATH);
  const id = randomUUID().slice(0, 12);

  // Parse amount to USD (USDC has 6 decimals)
  const amountUSD = Number(amount) / 1_000_000;

  const paymentRequest: PaymentRequest = {
    id,
    serviceUrl,
    payTo,
    amount,
    amountUSD,
    token,
    network,
    description,
    category,
    timestamp: Math.floor(Date.now() / 1000),
  };

  // Evaluate policy
  const decision = evaluatePolicy(paymentRequest, currentConfig, ledger);

  if (decision.action === "deny") {
    const audit: AuditEntry = {
      id,
      timestamp: new Date().toISOString(),
      serviceUrl: paymentRequest.serviceUrl,
      amount,
      amountUSD,
      token: paymentRequest.token,
      category: paymentRequest.category,
      policyDecision: "deny",
      policyReason: decision.reason,
      humanDecision: null,
      finalOutcome: "denied",
      txHash: null,
      error: null,
    };
    auditLog.insert(audit);

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({ status: "denied", reason: decision.reason }, null, 2),
      }],
    };
  }

  // Issue #2: await human approval flow
  if (decision.action === "require_human_approval") {
    // Reserve this amount in the ledger BEFORE awaiting human input so that
    // concurrent requests see the pending spend during their own policy checks.
    ledger.record(paymentRequest.id, paymentRequest.amountUSD, paymentRequest.timestamp);

    const { promise, message, pin } = requestApproval(paymentRequest, currentConfig.humanApproval.timeoutSeconds);

    // PIN goes to stderr (operator console) only — never into the tool response
    // so the agent cannot read it and must ask the human to provide it.
    process.stderr.write(`\n[policy-proxy-wallet] Approval PIN for request ${paymentRequest.id}: ${pin}\n`);

    // The MCP tool call blocks here until human responds or timeout
    const approved = await promise;

    if (!approved) {
      // Release the reserved ledger entry — payment will not proceed
      ledger.removeRecord(paymentRequest.id);

      const audit: AuditEntry = {
        id,
        timestamp: new Date().toISOString(),
        serviceUrl: paymentRequest.serviceUrl,
        amount,
        amountUSD,
        token: paymentRequest.token,
        category: paymentRequest.category,
        policyDecision: "require_human_approval",
        policyReason: decision.reason,
        humanDecision: "deny",
        finalOutcome: "denied",
        txHash: null,
        error: null,
      };
      auditLog.insert(audit);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ status: "denied", reason: "Human denied or approval timed out" }, null, 2),
        }],
      };
    }

    return await executePayment(paymentRequest, "human", currentConfig, true);
  }

  // Auto-approved: execute payment (executePayment will record the ledger entry)
  return await executePayment(paymentRequest, "auto", currentConfig, false);
}

async function executePayment(
  request: PaymentRequest,
  approvalType: "auto" | "human",
  currentConfig: ReturnType<typeof loadConfig>,
  preRecorded = false,
) {
  // Record in ledger BEFORE sending tx to prevent concurrent requests from
  // exceeding limits. Human-approval path pre-records before the await, so
  // skip re-recording to avoid double-counting.
  if (!preRecorded) {
    ledger.record(request.id, request.amountUSD, request.timestamp);
  }

  try {
    const result = await sendUSDC(walletConfig, request.payTo, request.amount);

    // Issue #4: prune ledger after every transaction
    ledger.prune(currentConfig.limits.perSession.windowSeconds);

    const audit: AuditEntry = {
      id: request.id,
      timestamp: new Date().toISOString(),
      serviceUrl: request.serviceUrl,
      amount: request.amount,
      amountUSD: request.amountUSD,
      token: request.token,
      category: request.category,
      policyDecision: approvalType === "auto" ? "approve" : "require_human_approval",
      policyReason: approvalType === "auto" ? "Auto-approved" : "Human-approved",
      humanDecision: approvalType === "human" ? "approve" : null,
      finalOutcome: "paid",
      txHash: result.txHash,
      error: null,
    };
    auditLog.insert(audit);

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          status: "paid",
          txHash: result.txHash,
          from: result.from,
          to: result.to,
          amount: request.amount,
          amountUSD: request.amountUSD,
        }, null, 2),
      }],
    };
  } catch (err: unknown) {
    // Roll back the ledger entry — tx did not complete
    ledger.removeRecord(request.id);

    const message = err instanceof Error ? err.message : String(err);
    const audit: AuditEntry = {
      id: request.id,
      timestamp: new Date().toISOString(),
      serviceUrl: request.serviceUrl,
      amount: request.amount,
      amountUSD: request.amountUSD,
      token: request.token,
      category: request.category,
      policyDecision: "approve",
      policyReason: approvalType === "auto" ? "Auto-approved" : "Human-approved",
      humanDecision: approvalType === "human" ? "approve" : null,
      finalOutcome: "error",
      txHash: null,
      error: message,
    };
    auditLog.insert(audit);

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({ status: "error", error: message }, null, 2),
      }],
      isError: true,
    };
  }
}

function handleHistory(args: Record<string, unknown>) {
  try {
    const parsed = HistoryArgsSchema.safeParse(args);
    const limit = parsed.success ? parsed.data.limit : 10;
    const entries = auditLog.getRecent(limit);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(entries, null, 2) }],
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true };
  }
}

function handleStatus() {
  try {
    const currentConfig = loadConfig(CONFIG_PATH);
    const spent = ledger.totalSpentInWindow(currentConfig.limits.perSession.windowSeconds);
    const txCount = ledger.transactionCountInWindow(currentConfig.limits.cooldown.windowSeconds);

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          policyEnabled: currentConfig.enabled,
          frozen: !currentConfig.enabled,
          limits: {
            perTransaction: { max: currentConfig.limits.perTransaction.maxAmountUSD },
            daily: {
              max: currentConfig.limits.perSession.maxAmountUSD,
              spent: Number(spent.toFixed(4)),
              remaining: Number(Math.max(0, currentConfig.limits.perSession.maxAmountUSD - spent).toFixed(4)),
            },
            cooldown: {
              maxPerMinute: currentConfig.limits.cooldown.maxTransactions,
              currentCount: txCount,
            },
          },
          autoApprove: currentConfig.autoApprove,
          whitelist: currentConfig.whitelist,
          humanApproval: currentConfig.humanApproval.enabled,
          pendingApprovals: pendingCount(),
        }, null, 2),
      }],
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true };
  }
}

function handleApprove(args: Record<string, unknown>) {
  try {
    const parsed = ApproveArgsSchema.safeParse(args);
    if (!parsed.success) {
      const errors = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ status: "error", validation: errors }) }],
        isError: true,
      };
    }
    const { approvalId, approved, pin } = parsed.data;

    const result = handleApprovalResponse(approvalId, pin, approved);

    if (result === "not_found") {
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ status: "not_found", message: "No pending approval with that ID (may have timed out)" }),
        }],
      };
    }

    if (result === "invalid_pin") {
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ status: "error", message: "Invalid PIN. Ask the human to check their console for the correct PIN." }),
        }],
        isError: true,
      };
    }

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({ status: "processed", approved }),
      }],
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true };
  }
}

// Start
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Policy Proxy Wallet MCP server running");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
