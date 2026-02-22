import { initWallet, validatePassphrase } from "../custody/local-wallet.js";
import { join } from "node:path";

const WORKSPACE = process.env.WORKSPACE || join(process.env.HOME || "/home/node", ".openclaw/workspace");
const KEYSTORE_PATH = process.env.KEYSTORE_PATH || join(WORKSPACE, "policy-proxy-wallet/config/keystore.json");

// Issue #5: read passphrase from env var, not process.argv
const rawPassphrase = process.env.WALLET_PASSPHRASE;
if (!rawPassphrase) {
  console.error("Usage: WALLET_PASSPHRASE=<passphrase> tsx src/cli/init-wallet.ts");
  console.error("  Set the WALLET_PASSPHRASE environment variable to encrypt your wallet key.");
  console.error("  Store it securely. You will need it to start the proxy server.");
  process.exit(1);
}

try {
  validatePassphrase(rawPassphrase);
} catch (err: unknown) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}

const passphrase: string = rawPassphrase;

const force = process.argv.includes("--force");

async function main() {
  try {
    if (force) {
      const { unlinkSync } = await import("node:fs");
      try { unlinkSync(KEYSTORE_PATH); } catch {}
    }
    const address = await initWallet(KEYSTORE_PATH, passphrase);
    console.log(`Wallet created successfully.`);
    console.log(`Address: ${address}`);
    console.log(`Keystore: ${KEYSTORE_PATH}`);
    console.log(`\nNext steps:`);
    console.log(`1. Fund this address with a small amount of USDC on Base`);
    console.log(`2. Ensure WALLET_PASSPHRASE environment variable is set`);
    console.log(`3. Start the MCP server: npm run dev`);
  } catch (err: unknown) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

main();
