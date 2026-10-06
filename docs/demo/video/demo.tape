# gibwork-crew demo — real terminal session on the team VPS (Solana mainnet, Gibwork production). Nothing is spent.
Output demo.mp4
Output demo.gif

Set Shell "bash"
Set FontSize 17
Set Width 1440
Set Height 900
Set Padding 24
Set TypingSpeed 28ms
Set Theme "Dracula"

# Off screen: connect and load the recording environment (RPC and wallet are never printed).
Hide
Type "ssh -t -o LogLevel=ERROR root@<vps> 'bash --rcfile /root/gwc-video/env.sh -i'" Enter
Sleep 4s
Type "cd /root/gwc-video/rec && rm -f crew.json && clear" Enter
Sleep 1s
Show

Type "# gibwork-crew: take a Gibwork bounty, split it, pay sub-agents only on verified delivery (Solana escrow)" Enter
Sleep 2s

Type "gibwork-crew scout --pages 3 | jq -c '.ranked[] | {title: .title[0:44], rewardUsdc, why}'" Enter
Sleep 9s

Type "# plan two subtasks for the hackathon bounty: one paid on a SHA-256 match, one on approval" Enter
Type "gibwork-crew plan 1052f22d-3f87-4b1d-b0d7-71a60679e7fa --budget 1.5 --deadline 21600 \" Enter
Type "  --sub 'crew-docs|Document the crew.json format|2PbLh9PqaxNTMNuBrRu8fbH2MvyjifsyuxXnEhxNvJMn|1|24cb8c3e946e6408fccbf7eea67ac5c4b72e32a552722923b2d726bc9507257f' \" Enter
Type "  --sub 'crew-review|Review the document|9vqqr1WE33QcbxCcoFcEmJaBycRLPznpcctGhvfsuCfm|0.5' --out crew.json" Enter
Sleep 6s

Type "# exact cost before anything is signed (dry run)" Enter
Type "gibwork-crew fund crew.json | jq -c '.lines[] | {id, grossUsdc, feeUsdc, calleeReceivesUsdc, rentLockedSol, warnings}'" Enter
Sleep 9s

Type "clear" Enter
Type "# the paid run on mainnet (2026-10-06): both sub-agents funded, delivered, settled, closed" Enter
Type "gibwork-crew status /root/gwc-run/crew.json | jq -c '{settled, total, ready, rows: [.rows[] | {id, rule, status, closed}]}'" Enter
Sleep 8s

Type "gibwork-crew ledger /root/gwc-run/crew.json | jq -c '.subtasks[] | {id, amountUsdc, rule, task, receipt: .receipt.memo}'" Enter
Sleep 5s

Type "jq -c 'to_entries[] | {step: .key, usdc: [.value.deltas[] | {owner: .owner[0:6], delta}]}' /root/gwc-run/07-deltas.json" Enter
Sleep 6s

Type "# last step: submit the assembled work to Gibwork (dry by default; --quote shows the fee, --yes pays it)" Enter
Type "gibwork-crew submit /root/gwc-run/crew.json --content /root/gwc-run/work.md | jq -c ." Enter
Sleep 8s

Type "# repo: github.com/SiiahK/gibwork-crew  ·  MIT  ·  CLI + MCP server" Enter
Sleep 4s
