# MCP quickstart

`gibwork-crew-mcp` lets an AI assistant scout Gibwork bounties, draft a crew, preview its escrow costs and follow delivery. **No tool spends money.** Funding and the Gibwork participation fee go through the CLI with `--yes`.

## Claude Code

```bash
claude mcp add gibwork-crew \
  --env CREW_RPC_URL=<solana-mainnet-rpc> \
  --env CREW_WALLET=/absolute/path/to/keypair.json \
  --env GIBWORK_PRODUCTION=1 \
  -- npx -y -p github:SiiahK/gibwork-crew gibwork-crew-mcp
```

## Any MCP client (JSON config)

```json
{
  "mcpServers": {
    "gibwork-crew": {
      "command": "gibwork-crew-mcp",
      "env": {
        "CREW_RPC_URL": "<solana-mainnet-rpc>",
        "CREW_WALLET": "/absolute/path/to/keypair.json",
        "GIBWORK_PRODUCTION": "1"
      }
    }
  }
}
```

Install the binary first with `npm install -g github:SiiahK/gibwork-crew`.

## Tools

| Tool | What it returns |
|---|---|
| `crew_scout` | Open USDC bounties, ranked by reward per competing submission. Gated bounties (Discord role, verified account, premium) come last, with the reason |
| `crew_plan` | A `crew.json` draft from subtask specs `id\|description\|callee\|amountUsdc[\|sha256]`. Nothing is written |
| `crew_fund_preview` | Exact Select escrow cost for each unfunded subtask: gross, 2% fee, what the sub-agent receives, SOL rent locked and returned |
| `crew_status` | Each subtask's escrow state and receipt (`rufus://<task>`) |
| `crew_ledger` | The Gibwork bounty and submission linked to every escrow, funding transaction and receipt |

## Typical session

1. Ask for bounties: the assistant calls `crew_scout`.
2. Agree on subtasks and sub-agents: the assistant calls `crew_plan`, and you save the result as `crew.json`.
3. Check costs: `crew_fund_preview`.
4. Fund from your terminal: `gibwork-crew fund crew.json --yes`.
5. Sub-agents deliver to `./outputs/<subtask-id>`, then run `gibwork-crew collect crew.json --from ./outputs`. A subtask that needs your approval is released with `--approve <id>`.
6. Follow progress with `crew_status` until every subtask is `Completed`.
7. Submit to Gibwork: `gibwork-crew submit crew.json --content work.md --quote`, then `--yes`.

The wallet in `CREW_WALLET` is only used by the server to sign Gibwork's discovery requests. Keep the file private (`chmod 600`) and never paste key material into a chat.
