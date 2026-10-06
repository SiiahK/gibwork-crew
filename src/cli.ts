#!/usr/bin/env node
/**
 * gibwork-crew — take a Gibwork bounty, split it into subtasks, pay sub-agents through Select escrow on
 * verified delivery, and submit the assembled work to Gibwork. Terminal only; dry-run unless --yes.
 *
 *   gibwork-crew scout   [--min 5] [--tag Docs] [--pages 2]
 *   gibwork-crew plan    <taskId> --budget 6 --sub "id|description|callee|amountUsdc[|sha256]" ... [--deadline 86400] [--out crew.json]
 *   gibwork-crew fund    crew.json [--yes]
 *   gibwork-crew collect crew.json [--from ./outputs] [--approve id,...]
 *   gibwork-crew status  crew.json
 *   gibwork-crew submit  crew.json --content work.md [--quote | --yes] [--allow-partial]
 *   gibwork-crew ledger  crew.json
 *
 * Env: CREW_WALLET (keypair JSON file; payer of the escrows and Gibwork wallet), CREW_RPC_URL (Solana RPC),
 *      SELECT_API (default https://api.tryaigility.com), GIBWORK_PRODUCTION=1 (default: Gibwork stage),
 *      CREW_MAX_SUBTASK_USDC (≤ 10), SELECT_AFFILIATE (optional integrator authority, never the payer).
 */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import nacl from "tweetnacl";
import { web3, connectionReader } from "@selectinfra/agent-adapters/core";
import { CrewError, loadCrew, saveCrew, usdcToRaw } from "./crew.js";
import { gibworkAdapter, type GibworkPort } from "./gibwork.js";
import { collect, fund, ledger, parseSubtaskSpec, plan, scout, status, submit } from "./commands.js";
import { clusterClock, type EscrowDeps } from "./escrow.js";

const USAGE = readFileSync(fileURLToPath(import.meta.url), "utf-8").split("\n").slice(2, 20).map((l) => l.replace(/^ \* ?/, "")).join("\n");

function wallet(): InstanceType<typeof web3.Keypair> {
  const f = process.env.CREW_WALLET;
  if (!f || !existsSync(f)) throw new CrewError("no_wallet", "set CREW_WALLET to a keypair JSON file (never paste keys into chat or the crew file)");
  return web3.Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(f, "utf-8"))));
}

async function gibwork(): Promise<GibworkPort> {
  const { createGibworkClient } = await import("@gibwork/sdk/node");
  const kp = wallet();
  return gibworkAdapter(createGibworkClient({ privateKey: Array.from(kp.secretKey), production: process.env.GIBWORK_PRODUCTION === "1" }));
}

function escrowDeps(): EscrowDeps {
  const rpc = process.env.CREW_RPC_URL;
  if (!rpc) throw new CrewError("no_rpc", "set CREW_RPC_URL to a Solana mainnet RPC endpoint");
  const conn = new web3.Connection(rpc, "confirmed");
  return {
    chain: { ...connectionReader(conn), now: clusterClock(conn) }, cluster: "mainnet-beta", apiBaseUrl: process.env.SELECT_API ?? "https://api.tryaigility.com",
    latestBlockhash: () => conn.getLatestBlockhash("confirmed"), affiliate: process.env.SELECT_AFFILIATE || null,
    send: async (tx) => {
      const sig = await conn.sendRawTransaction(tx.serialize());
      const r = await conn.confirmTransaction({ signature: sig, blockhash: tx.recentBlockhash!, lastValidBlockHeight: tx.lastValidBlockHeight! }, "confirmed");
      if (r.value.err) throw new CrewError("tx_failed", `${sig}: ${JSON.stringify(r.value.err)}`);
      return sig;
    },
  };
}

const out = (v: unknown) => console.log(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x), 2));

export async function main(argv = process.argv.slice(2)) {
  const [cmd, ...rest] = argv;
  const { values: o, positionals: pos } = parseArgs({
    args: rest, allowPositionals: true,
    options: {
      yes: { type: "boolean" }, min: { type: "string" }, tag: { type: "string" }, pages: { type: "string" }, budget: { type: "string" },
      sub: { type: "string", multiple: true }, deadline: { type: "string" }, out: { type: "string" }, from: { type: "string" },
      approve: { type: "string" }, content: { type: "string" }, "allow-partial": { type: "boolean" }, quote: { type: "boolean" },
    },
  });
  switch (cmd) {
    case "scout":
      return out(await scout(await gibwork(), { minRewardUsdc: o.min ? Number(o.min) : undefined, tag: o.tag, pages: o.pages ? Number(o.pages) : undefined }));
    case "plan": {
      if (!pos[0] || !o.budget || !o.sub?.length) throw new CrewError("usage", "plan <taskId> --budget <usdc> --sub <spec> [--sub ...]");
      const r = await plan(await gibwork(), pos[0], o.sub.map(parseSubtaskSpec), { budgetUsdc: o.budget, deadlineSecs: o.deadline ? Number(o.deadline) : undefined });
      const file = o.out ?? "crew.json";
      if (existsSync(file)) throw new CrewError("exists", `${file} exists; choose another --out`);
      saveCrew(file, r.crew);
      return out({ written: file, gates: r.gates, subtasks: r.crew.subtasks.length, next: `gibwork-crew fund ${file}` });
    }
    case "fund": {
      const file = pos[0], crew = loadCrew(file);
      const max = process.env.CREW_MAX_SUBTASK_USDC ? usdcToRaw(process.env.CREW_MAX_SUBTASK_USDC) : undefined;
      const r = await fund(escrowDeps(), crew, wallet(), { confirm: Boolean(o.yes), maxSubtaskRaw: max, onFunded: (c) => saveCrew(file, c) });
      return out(r.confirmed ? r : { ...r, next: "dry run: nothing was signed. Re-run with --yes to fund these escrows." });
    }
    case "collect": {
      const file = pos[0], crew = loadCrew(file), dir = o.from;
      const source = dir ? async (s: { id: string }) => { const f = path.join(dir, s.id); return existsSync(f) ? new Uint8Array(readFileSync(f)) : null; } : undefined;
      const approve = o.approve?.split(",").map((x) => x.trim()).filter(Boolean);
      const r = await collect(escrowDeps(), crew, { source, approve, payer: approve?.length ? wallet() : undefined, sign: (m, k) => nacl.sign.detached(m, k.secretKey) });
      saveCrew(file, crew);
      return out(r);
    }
    case "status": {
      const file = pos[0], crew = loadCrew(file), r = await status(escrowDeps(), crew);
      saveCrew(file, crew);
      return out(r);
    }
    case "submit": {
      const file = pos[0], crew = loadCrew(file);
      if (!o.content) throw new CrewError("usage", "submit <crew.json> --content <file>");
      const st = await status(escrowDeps(), crew);
      const mode = o.yes ? "confirm" : o.quote ? "quote" : "dry";
      const g = mode === "dry" ? (null as unknown as GibworkPort) : await gibwork();
      const r = await submit(g, crew, readFileSync(o.content, "utf-8"), { mode, requireAllSettled: !o["allow-partial"], settled: st.ready });
      saveCrew(file, crew);
      const next = { dry: "nothing sent. --quote asks Gibwork for the participation fee (pending intent, no payment); --yes pays it and submits.", quote: "fee quoted, nothing paid. Re-run with --yes to pay it and submit.", confirm: "submitted." };
      return out({ ...r, next: next[r.mode] });
    }
    case "ledger":
      return out(ledger(loadCrew(pos[0])));
    default:
      console.log(USAGE);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(path.resolve(process.argv[1]))) {
  main().catch((e) => {
    // Gibwork API errors carry the reason in their body (e.g. "An active platform wallet is required to submit work").
    const reason = typeof e?.body?.message === "string" ? ` — ${e.body.message}` : "";
    console.error(`gibwork-crew: ${e instanceof CrewError ? `[${e.code}] ` : ""}${e.message}${reason}`);
    process.exit(1);
  });
}
