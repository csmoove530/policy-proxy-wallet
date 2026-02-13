import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { PolicyConfigSchema, type PolicyConfig } from "../policy/types.js";

const DEFAULT_CONFIG: PolicyConfig = {
  version: "1.0",
  enabled: true,
  limits: {
    perTransaction: { maxAmountUSD: 0.10 },
    perSession: { maxAmountUSD: 5.00, windowSeconds: 86400 },
    cooldown: { maxTransactions: 10, windowSeconds: 60 },
  },
  autoApprove: {
    enabled: true,
    maxAmountUSD: 0.05,
  },
  whitelist: {
    enabled: false,
    domains: [],
    categories: ["image-generation", "search", "compute"],
  },
  humanApproval: {
    enabled: true,
    timeoutSeconds: 300,
    defaultOnTimeout: "deny",
  },
};

export function loadConfig(configPath: string): PolicyConfig {
  if (!existsSync(configPath)) {
    writeFileSync(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2), { mode: 0o600 });
    return DEFAULT_CONFIG;
  }

  const raw = readFileSync(configPath, "utf-8");
  const parsed = JSON.parse(raw);
  return PolicyConfigSchema.parse(parsed);
}

export function saveConfig(configPath: string, config: PolicyConfig): void {
  PolicyConfigSchema.parse(config); // validate before saving
  writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
}

export function updateConfig(
  configPath: string,
  updater: (config: PolicyConfig) => PolicyConfig,
): PolicyConfig {
  const current = loadConfig(configPath);
  const updated = updater(current);
  saveConfig(configPath, updated);
  return updated;
}
