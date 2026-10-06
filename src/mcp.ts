#!/usr/bin/env node
/**
 * gibwork-crew MCP server (stdio). Lets an agent scout Gibwork bounties, plan a crew, preview its escrow costs
 * and follow delivery. **No tool spends:** funding escrows and paying Gibwork's participation fee happen only
 * through the CLI with --yes, on the operator's machine.
 *
 * Tools: crew_scout, crew_plan, crew_fund_preview, crew_status, crew_ledger.
 * Env: CREW_WALLET (used only to sign Gibwork's discovery requests), CREW_RPC_URL, SELECT_API, GIBWORK_PRODUCTION.
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { web3, connectionReader } from "@selectinfra/agent-adapters/core";
import { CrewError, checkSpend, parseCrew } from "./crew.js";
import { gibworkAdapter, type GibworkPort } from "./gibwork.js";
import { ledger, parseSubtaskSpec, plan, scout, status, SELECT_PILOT_MAX_RAW } from "./commands.js";
import { clusterClock, fundLine, previewSubtask, workerPolicy, type EscrowDeps } from "./escrow.js";

const KEY = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);

export interface McpDeps { gibwork: () => Promise<GibworkPort>; escrow: () => EscrowDeps }

export function buildServer(d: McpDeps) {
  const server = new McpServer({ name: "gibwork-crew", version: "0.1.0" });
  const wrap = (fn: (i: any) => Promise<unknown>) => async (i: any) => {
    try { return { content: [{ type: "text" as const, text: JSON.stringify(await fn(i), null, 2) }] }; }
    catch (e: any) { return { isError: true, content: [{ type: "text" as const, text: JSON.stringify({ error: e instanceof CrewError ? e.code : "error", message: String(e?.message ?? e).slice(0, 300) }) }] }; }
  };
  const crewArg = z.string().min(2).max(200_000).describe("crew.json content");

  server.registerTool("crew_scout", {
    description: "List open Gibwork bounties ranked for a crew: USDC reward per competing submission, open slots, no human-only gates (Discord role, verified account, premium). Read-only.",
    inputSchema: { minRewardUsdc: z.number().min(0).optional(), tag: z.string().max(40).optional(), pages: z.number().int().min(1).max(5).optional() },
    annotations: { readOnlyHint: true },
  }, wrap(async (i) => scout(await d.gibwork(), i)));

  server.registerTool("crew_plan", {
    description: "Draft a crew.json for a Gibwork bounty. Each subtask spec is 'id|description|callee|amountUsdc[|sha256]': with sha256 the sub-agent is paid when its output hashes to it; without, the payer approves the release. Returns the file content; writes nothing.",
    inputSchema: { taskId: z.string().min(1).max(64), budgetUsdc: z.string().regex(/^[0-9]+(\.[0-9]{1,6})?$/), subtasks: z.array(z.string().max(700)).min(1).max(20), deadlineSecs: z.number().int().min(600).max(2_592_000).optional() },
    annotations: { readOnlyHint: true },
  }, wrap(async (i) => {
    const r = await plan(await d.gibwork(), i.taskId, i.subtasks.map(parseSubtaskSpec), { budgetUsdc: i.budgetUsdc, deadlineSecs: i.deadlineSecs });
    return { crewJson: r.crew, gates: r.gates, next: "Save as crew.json, then the operator runs: gibwork-crew fund crew.json (dry run), and --yes to fund." };
  }));

  server.registerTool("crew_fund_preview", {
    description: "Exact Select escrow cost for each unfunded subtask (gross, 2% fee, what the sub-agent receives, SOL rent locked and returned). Signs nothing.",
    inputSchema: { crew: crewArg, payer: KEY },
    annotations: { readOnlyHint: true },
  }, wrap(async (i) => {
    const crew = parseCrew(JSON.parse(i.crew)), e = d.escrow();
    const { unfunded, totalRaw } = checkSpend(crew, i.payer, { maxSubtaskRaw: SELECT_PILOT_MAX_RAW });
    const policy = await workerPolicy(e);
    const lines = await Promise.all(unfunded.map(async (s) => fundLine(s, await previewSubtask(e, crew, s, i.payer, policy))));
    return { lines, totalGrossRaw: totalRaw.toString(), next: "Funding is done by the operator with: gibwork-crew fund crew.json --yes" };
  }));

  server.registerTool("crew_status", {
    description: "State of every subtask escrow (unfunded, funded, completed, refunded) with its receipt (rufus://<task>). Read-only.",
    inputSchema: { crew: crewArg }, annotations: { readOnlyHint: true },
  }, wrap(async (i) => { const crew = parseCrew(JSON.parse(i.crew)); return { ...(await status(d.escrow(), crew)), crewJson: crew }; }));

  server.registerTool("crew_ledger", {
    description: "Link the Gibwork bounty and submission to each subtask's Select escrow, funding transaction and receipt. Read-only.",
    inputSchema: { crew: crewArg }, annotations: { readOnlyHint: true },
  }, wrap(async (i) => ledger(parseCrew(JSON.parse(i.crew)))));

  return server;
}

async function main() {
  const rpc = process.env.CREW_RPC_URL;
  if (!rpc) throw new Error("CREW_RPC_URL is required");
  const conn = new web3.Connection(rpc, "confirmed");
  const escrow = (): EscrowDeps => ({
    chain: { ...connectionReader(conn), now: clusterClock(conn) }, cluster: "mainnet-beta", apiBaseUrl: process.env.SELECT_API ?? "https://api.tryaigility.com",
    latestBlockhash: () => conn.getLatestBlockhash("confirmed"),
    send: async () => { throw new CrewError("read_only", "the MCP server never sends transactions"); },
  });
  const gibwork = async () => {
    const f = process.env.CREW_WALLET;
    if (!f || !existsSync(f)) throw new CrewError("no_wallet", "Gibwork discovery is wallet-authenticated: set CREW_WALLET");
    const { createGibworkClient } = await import("@gibwork/sdk/node");
    const secret = Array.from(Uint8Array.from(JSON.parse(readFileSync(f, "utf-8"))));
    return gibworkAdapter(createGibworkClient({ privateKey: secret, production: process.env.GIBWORK_PRODUCTION === "1" }));
  };
  await buildServer({ gibwork, escrow }).connect(new StdioServerTransport());
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(path.resolve(process.argv[1]))) main().catch((e) => { console.error(`[gibwork-crew-mcp] ${e.message}`); process.exit(1); });
