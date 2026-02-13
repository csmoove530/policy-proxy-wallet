import { z } from "zod";

export const PolicyConfigSchema = z.object({
  version: z.literal("1.0"),
  enabled: z.boolean(),

  limits: z.object({
    perTransaction: z.object({
      maxAmountUSD: z.number().positive(),
    }),
    perSession: z.object({
      maxAmountUSD: z.number().positive(),
      windowSeconds: z.number().int().positive(),
    }),
    cooldown: z.object({
      maxTransactions: z.number().int().positive(),
      windowSeconds: z.number().int().positive(),
    }),
  }),

  autoApprove: z.object({
    enabled: z.boolean(),
    maxAmountUSD: z.number().nonnegative(),
  }),

  whitelist: z.object({
    enabled: z.boolean(),
    domains: z.array(z.string()),
    categories: z.array(z.string()),
  }),

  humanApproval: z.object({
    enabled: z.boolean(),
    timeoutSeconds: z.number().int().positive(),
    defaultOnTimeout: z.literal("deny"),
  }),
});

export type PolicyConfig = z.infer<typeof PolicyConfigSchema>;

export interface PaymentRequest {
  id: string;
  serviceUrl: string;
  payTo: string;
  amount: string;
  amountUSD: number;
  token: string;
  network: string;
  description: string;
  category: string;
  timestamp: number;
}

export type PolicyDecision =
  | { action: "approve"; reason: string }
  | { action: "deny"; reason: string }
  | { action: "require_human_approval"; reason: string };

export interface AuditEntry {
  id: string;
  timestamp: string;
  serviceUrl: string;
  amount: string;
  amountUSD: number;
  token: string;
  category: string;
  policyDecision: string;
  policyReason: string;
  humanDecision: string | null;
  finalOutcome: string;
  txHash: string | null;
  error: string | null;
}
