import { ethers } from "ethers";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

const USDC_ABI = [
  "function transfer(address to, uint256 amount) returns (bool)",
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
];

// USDC on Base
const USDC_BASE_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const BASE_RPC = "https://mainnet.base.org";

export interface WalletConfig {
  keystorePath: string;
  passphrase: string;
}

export interface SendResult {
  txHash: string;
  from: string;
  to: string;
  amount: string;
}

/**
 * Validate passphrase strength for wallet encryption.
 * Throws with a descriptive message if any requirement is not met.
 */
export function validatePassphrase(passphrase: string): void {
  const errors: string[] = [];

  if (passphrase.length < 12) {
    errors.push("at least 12 characters");
  }
  if (!/[A-Z]/.test(passphrase)) {
    errors.push("at least one uppercase letter (A–Z)");
  }
  if (!/[a-z]/.test(passphrase)) {
    errors.push("at least one lowercase letter (a–z)");
  }
  if (!/[0-9]/.test(passphrase)) {
    errors.push("at least one digit (0–9)");
  }
  if (!/[^A-Za-z0-9]/.test(passphrase)) {
    errors.push("at least one special character (e.g. !@#$%^&*)");
  }

  if (errors.length > 0) {
    throw new Error(
      `Passphrase does not meet security requirements. It must contain:\n` +
        errors.map((e) => `  • ${e}`).join("\n")
    );
  }
}

/**
 * Generate a new wallet and save as encrypted keystore.
 */
export async function initWallet(keystorePath: string, passphrase: string): Promise<string> {
  validatePassphrase(passphrase);
  if (existsSync(keystorePath)) {
    throw new Error(`Keystore already exists at ${keystorePath}. Use --force to overwrite.`);
  }

  const wallet = ethers.Wallet.createRandom();
  const encrypted = await wallet.encrypt(passphrase);

  const dir = dirname(keystorePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  writeFileSync(keystorePath, encrypted, { mode: 0o600 });
  return wallet.address;
}

/**
 * Load wallet from encrypted keystore.
 */
async function loadWallet(config: WalletConfig): Promise<ethers.Wallet | ethers.HDNodeWallet> {
  const keystore = readFileSync(config.keystorePath, "utf-8");
  const wallet = await ethers.Wallet.fromEncryptedJson(keystore, config.passphrase);
  const provider = new ethers.JsonRpcProvider(BASE_RPC);
  return wallet.connect(provider);
}

/**
 * Get wallet address without decrypting the full key.
 */
export function getAddress(keystorePath: string): string {
  const keystore = readFileSync(keystorePath, "utf-8");
  const parsed = JSON.parse(keystore);
  return ethers.getAddress("0x" + parsed.address);
}

/**
 * Check USDC balance.
 */
export async function getBalance(config: WalletConfig): Promise<{ address: string; balanceUSDC: string }> {
  const address = getAddress(config.keystorePath);
  const provider = new ethers.JsonRpcProvider(BASE_RPC);
  const usdc = new ethers.Contract(USDC_BASE_ADDRESS, USDC_ABI, provider);
  const balance = await (usdc.balanceOf as (addr: string) => Promise<bigint>)(address);
  const decimals = await (usdc.decimals as () => Promise<number>)();
  return {
    address,
    balanceUSDC: ethers.formatUnits(balance, decimals),
  };
}

/**
 * Send USDC payment. Only called after policy approval.
 */
export async function sendUSDC(config: WalletConfig, to: string, amountRaw: string): Promise<SendResult> {
  const wallet = await loadWallet(config);
  const usdc = new ethers.Contract(USDC_BASE_ADDRESS, USDC_ABI, wallet);

  const tx = await (usdc.transfer as (to: string, amount: string) => Promise<ethers.TransactionResponse>)(to, amountRaw);
  const receipt = await tx.wait();
  if (!receipt) {
    throw new Error("Transaction receipt is null");
  }

  return {
    txHash: receipt.hash,
    from: wallet.address,
    to,
    amount: amountRaw,
  };
}
