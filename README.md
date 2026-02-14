# Policy Proxy Wallet

**Let AI agents spend money without holding keys.**

An MCP server that gives AI agents the ability to make [x402](https://www.x402.org/) payments with policy enforcement. The agent never touches private keys—a local proxy evaluates spending rules before signing any transaction.

```bash
# Install
npm install

# Create wallet (one time)
WALLET_PASSPHRASE=your-secret npm run init-wallet

# Run the MCP server
WALLET_PASSPHRASE=your-secret npm run dev
```

Fund the wallet address with USDC on Base, then your agent can pay for x402 services.

---

## Quick Start

### 1. Install and create a wallet

```bash
git clone https://github.com/csmoove530/policy-proxy-wallet.git
cd policy-proxy-wallet
npm install

# Create an encrypted wallet (saves to config/keystore.json)
WALLET_PASSPHRASE=your-secret npm run init-wallet
```

Output:
```
Wallet created successfully.
Address: 0x1234...abcd
Keystore: ~/.openclaw/workspace/policy-proxy-wallet/config/keystore.json
```

### 2. Fund the wallet

Send a small amount of USDC to your wallet address on **Base** network.

### 3. Add to Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "policy-wallet": {
      "command": "node",
      "args": ["--import", "tsx", "/path/to/policy-proxy-wallet/src/server.ts"],
      "env": {
        "WALLET_PASSPHRASE": "your-secret"
      }
    }
  }
}
```

### 4. Make your first payment

Ask Claude to use an x402 service. The agent calls `policy_wallet_pay`:

```json
{
  "serviceUrl": "https://api.example.com/generate",
  "payTo": "0xServiceAddress...",
  "amount": "50000",
  "description": "Generate an image"
}
```

Response:
```json
{
  "status": "paid",
  "txHash": "0xabc123...",
  "from": "0xYourWallet...",
  "to": "0xServiceAddress...",
  "amount": "50000",
  "amountUSD": 0.05
}
```

---

## How It Works

```
┌─────────────┐     ┌──────────────────┐     ┌─────────────┐
│  AI Agent   │────▶│  Policy Proxy    │────▶│  Base (L2)  │
│  (Claude)   │     │  Wallet (MCP)    │     │  USDC       │
└─────────────┘     └──────────────────┘     └─────────────┘
                            │
                    ┌───────┴───────┐
                    │               │
              ┌─────▼─────┐   ┌─────▼─────┐
              │  Policy   │   │  Keystore │
              │  Engine   │   │  (local)  │
              └───────────┘   └───────────┘
```

1. Agent requests a payment via MCP tool call
2. Policy engine evaluates against spending rules
3. If approved, proxy signs and broadcasts transaction
4. Agent receives tx hash confirmation

The agent **never sees the private key**. It only sees approve/deny decisions.

---

## Policy Rules

The policy engine evaluates requests in order. First denial wins.

| Rule | Default | Description |
|------|---------|-------------|
| **Kill switch** | `enabled: true` | Freeze all payments instantly |
| **Per-tx cap** | `$0.10` | Max amount per single payment |
| **Daily cap** | `$5.00` | Max total in 24-hour window |
| **Cooldown** | `10 tx / 60s` | Rate limit to prevent runaway loops |
| **Whitelist** | `disabled` | Only allow specific domains |
| **Auto-approve** | `≤ $0.05` | Skip human approval for small amounts |
| **Human approval** | `enabled` | Require human confirmation above threshold |

### Example policy.json

```json
{
  "version": "1.0",
  "enabled": true,
  "limits": {
    "perTransaction": { "maxAmountUSD": 0.10 },
    "perSession": { "maxAmountUSD": 5.00, "windowSeconds": 86400 },
    "cooldown": { "maxTransactions": 10, "windowSeconds": 60 }
  },
  "autoApprove": {
    "enabled": true,
    "maxAmountUSD": 0.05
  },
  "whitelist": {
    "enabled": false,
    "domains": ["api.example.com", "trusted-service.io"],
    "categories": ["image-generation", "search"]
  },
  "humanApproval": {
    "enabled": true,
    "timeoutSeconds": 300,
    "defaultOnTimeout": "deny"
  }
}
```

---

## MCP Tools

### policy_wallet_pay

Submit a payment request. Goes through policy evaluation.

**Request:**
```json
{
  "serviceUrl": "https://api.example.com/generate",
  "payTo": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  "amount": "50000",
  "description": "Generate product image",
  "category": "image-generation"
}
```

**Success response:**
```json
{
  "status": "paid",
  "txHash": "0x1234567890abcdef...",
  "from": "0xYourWallet...",
  "to": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  "amount": "50000",
  "amountUSD": 0.05
}
```

**Denied response:**
```json
{
  "status": "denied",
  "reason": "Exceeds per-tx cap: $0.15 > $0.10"
}
```

### policy_wallet_balance

Check USDC balance and remaining daily allowance.

**Response:**
```json
{
  "address": "0xYourWallet...",
  "balanceUSDC": "4.532100",
  "dailyAllowance": {
    "limit": 5.0,
    "spent": 0.15,
    "remaining": 4.85
  },
  "autoApproveMax": 0.05
}
```

### policy_wallet_status

View current policy config and spending state.

**Response:**
```json
{
  "policyEnabled": true,
  "frozen": false,
  "limits": {
    "perTransaction": { "max": 0.10 },
    "daily": { "max": 5.0, "spent": 0.15, "remaining": 4.85 },
    "cooldown": { "maxPerMinute": 10, "currentCount": 2 }
  },
  "autoApprove": { "enabled": true, "maxAmountUSD": 0.05 },
  "whitelist": { "enabled": false, "domains": [], "categories": [] },
  "humanApproval": true,
  "pendingApprovals": 0
}
```

### policy_wallet_history

View recent transactions.

**Request:**
```json
{ "limit": 5 }
```

**Response:**
```json
[
  {
    "id": "abc123",
    "timestamp": "2024-01-15T10:30:00Z",
    "serviceUrl": "https://api.example.com/generate",
    "amountUSD": 0.05,
    "finalOutcome": "paid",
    "txHash": "0x1234..."
  }
]
```

### policy_wallet_approve

Approve or deny a pending human approval request.

**Request:**
```json
{
  "approvalId": "abc123",
  "approved": true
}
```

**Response:**
```json
{ "status": "processed", "approved": true }
```

---

## Error Handling

### Validation errors

```json
{
  "status": "error",
  "validation": "payTo: payTo must be a valid Ethereum address"
}
```

### Policy denials

```json
{
  "status": "denied",
  "reason": "Would exceed daily cap: $5.15 > $5.00 (already spent: $4.95)"
}
```

### Transaction errors

```json
{
  "status": "error",
  "error": "insufficient funds for gas"
}
```

### Common denial reasons

| Reason | Fix |
|--------|-----|
| `Wallet is frozen` | Edit policy.json, set `enabled: true` |
| `Exceeds per-tx cap` | Lower amount or increase `perTransaction.maxAmountUSD` |
| `Would exceed daily cap` | Wait for window to reset or increase limit |
| `Cooldown active` | Wait 60 seconds between bursts |
| `Domain not whitelisted` | Add domain to `whitelist.domains` or disable whitelist |
| `Human denied or approval timed out` | Try again with human approval |

---

## Configuration

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `WALLET_PASSPHRASE` | (required) | Decrypts the keystore |
| `KEYSTORE_PATH` | `config/keystore.json` | Encrypted wallet location |
| `POLICY_CONFIG_PATH` | `config/policy.json` | Policy rules location |
| `AUDIT_DB_PATH` | `data/audit.db` | SQLite audit log |

### File locations

```
policy-proxy-wallet/
├── config/
│   ├── keystore.json    # Encrypted wallet (never commit!)
│   └── policy.json      # Policy rules (edit this)
├── data/
│   └── audit.db         # Transaction history
└── src/
    └── server.ts        # MCP server
```

---

## Security Model

### What the agent CAN do
- Request payments (subject to policy)
- Check balance and history
- Submit approval responses

### What the agent CANNOT do
- Access the private key
- Modify policy rules
- Bypass spending limits
- Approve its own requests

### Design principles

1. **Defense in depth**: Multiple independent limits (per-tx, daily, cooldown)
2. **Fail closed**: Unknown states deny by default
3. **Audit everything**: Every request logged to SQLite
4. **Human override**: Freeze wallet instantly via policy.json

---

## Development

```bash
# Run tests
npm test

# Build TypeScript
npm run build

# Run in development
WALLET_PASSPHRASE=test npm run dev
```

### Project structure

```
src/
├── server.ts           # MCP server + tool handlers
├── policy/
│   ├── engine.ts       # Policy evaluation (pure function)
│   ├── ledger.ts       # In-memory spending tracker
│   └── types.ts        # TypeScript types + Zod schemas
├── custody/
│   └── local-wallet.ts # Keystore + ethers.js signing
├── approval/
│   └── pending.ts      # Human approval queue
├── audit/
│   └── log.ts          # SQLite audit trail
├── config/
│   └── loader.ts       # Policy config loader
└── cli/
    └── init-wallet.ts  # Wallet creation CLI
```

---

## License

MIT
