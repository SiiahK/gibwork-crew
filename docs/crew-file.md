# crew.json

`crew.json` is the single source of truth for one Gibwork bounty and its subtasks.
- `plan` writes it.
- `fund` adds each escrow as soon as it is funded.
- `collect` and `status` record receipts.
- `submit` records the Gibwork submission intent.

Every write is atomic (temp file, then rename), so an interrupted command never loses an escrow address.

```json
{
  "version": 1,
  "gibwork": { "taskId": "<gibwork task uuid>", "title": "…", "rewardReported": "1000 USDC", "deadline": null },
  "budgetUsdc": "3",
  "deadlineSecs": 21600,
  "subtasks": [
    {
      "id": "mcp-docs",
      "description": "Write the MCP quickstart",
      "callee": "<sub-agent wallet>",
      "amountUsdc": "2",
      "rule": { "type": "artifact_hash", "sha256": "<64 hex>" },
      "escrow": { "task": "<escrow task address>", "signature": "<funding tx>", "fundedAt": "<ISO time>" },
      "receipt": { "status": "completed", "memo": "rufus://<task>", "url": "https://api.tryaigility.com/v2/receipts/<task>", "checkedAt": "<ISO time>" }
    }
  ]
}
```

## Fields

| Field | Rule |
|---|---|
| `budgetUsdc` | Maximum total of all subtask amounts (gross, fees included). `fund` refuses to exceed it |
| `deadlineSecs` | Escrow deadline from funding, 600 s to 30 days. After it, the payer can refund without anyone's permission. `plan` refuses a deadline later than the bounty's own |
| `subtasks[].id` | `[a-z0-9-]{1,32}`, unique. It is also the file name `collect --from <dir>` looks for |
| `subtasks[].callee` | The sub-agent's wallet. It may not be the payer |
| `subtasks[].amountUsdc` | Up to 6 decimals, at most 10 (the Select pilot limit, or `CREW_MAX_SUBTASK_USDC` if lower). The sub-agent receives 98% |
| `rule` | `artifact_hash`: paid when the delivered bytes hash to `sha256`. `payer_approval`: paid when the payer approves (`collect --approve <id>`) |
| `escrow` | Written by `fund` |
| `receipt` | Written by `collect` and `status` |

## Idempotency

- **Escrow address:** each subtask's escrow is derived from the payer wallet and `gwc:<gibwork task id>:<subtask id>`. Running `fund` again only funds the subtasks that have no escrow, and an existing escrow is never charged twice.
- **Submission:** the Gibwork idempotency key is derived from the task id and the SHA-256 of the submitted content.
