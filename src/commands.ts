/**
 * Command logic shared by the CLI and the MCP server. Every command returns plain data; only the CLI prints.
 * Spending commands (fund, submit) take an explicit `confirm` flag: without it they return the preview only.
 */

import { createHash } from "node:crypto";
import { CrewError, checkSpend, rawToUsdc, usdcToRaw, type Crew, type Rule, type Subtask } from "./crew.js";
import { rank, type GibworkPort } from "./gibwork.js";
import { deliverArtifact, approveRelease, fundLine, fundSubtask, previewSubtask, readSubtask, receiptOf, workerPolicy, type EscrowDeps, type FundLine } from "./escrow.js";
import type { web3 } from "@selectinfra/agent-adapters/core";

type Keypair = InstanceType<typeof web3.Keypair>;

/** Select pilot limit per task (the settlement worker refuses more). */
export const SELECT_PILOT_MAX_RAW = 10_000_000n;

export async function scout(g: GibworkPort, opts: { pages?: number; limit?: number; minRewardUsdc?: number; tag?: string; now?: number } = {}) {
  const all = [];
  for (let page = 1; page <= (opts.pages ?? 2); page++) {
    const r = await g.listAvailable(page, opts.limit ?? 30);
    all.push(...r.items);
    if (!r.hasMore) break;
  }
  return { scanned: all.length, ranked: rank(all, opts.now, opts) };
}

export interface PlannedSubtask { id: string; description: string; callee: string; amountUsdc: string; sha256?: string }

/** Parses `id|description|callee|amountUsdc[|sha256]` (sha256 → artifact-hash rule; none → payer approval). */
export function parseSubtaskSpec(spec: string): PlannedSubtask {
  const p = spec.split("|");
  if (p.length < 4 || p.length > 5) throw new CrewError("invalid_spec", `subtask spec must be id|description|callee|amountUsdc[|sha256], got: ${spec}`);
  return { id: p[0].trim(), description: p[1].trim(), callee: p[2].trim(), amountUsdc: p[3].trim(), sha256: p[4]?.trim().toLowerCase() || undefined };
}

export async function plan(g: GibworkPort, taskId: string, subtasks: PlannedSubtask[], opts: { budgetUsdc: string; deadlineSecs?: number }): Promise<{ crew: Crew; gates: string[] }> {
  const t = await g.get(taskId);
  if (!t.isOpen) throw new CrewError("bounty_closed", `Gibwork task ${taskId} is not open`);
  const crew: Crew = {
    version: 1,
    gibwork: { taskId: t.id, title: t.title.slice(0, 300), rewardReported: t.rewardReported, deadline: t.deadline },
    budgetUsdc: opts.budgetUsdc,
    deadlineSecs: opts.deadlineSecs ?? 24 * 3600,
    subtasks: subtasks.map((s): Subtask => ({
      id: s.id, description: s.description, callee: s.callee, amountUsdc: s.amountUsdc,
      rule: (s.sha256 ? { type: "artifact_hash", sha256: s.sha256 } : { type: "payer_approval" }) as Rule,
    })),
  };
  if (t.deadline && Date.parse(t.deadline) < Date.now() + crew.deadlineSecs * 1000) {
    throw new CrewError("deadline_after_bounty", `subtask deadline (${crew.deadlineSecs}s) ends after the bounty deadline ${t.deadline}; shorten --deadline`);
  }
  return { crew, gates: t.gates };
}

export interface FundResult { lines: FundLine[]; totalGrossUsdc: string; funded: { id: string; task: string; signature: string }[]; confirmed: boolean }

/**
 * Previews every unfunded subtask; with `confirm`, funds them one by one and records each escrow in the crew
 * (the caller saves the crew after every funded subtask, see onFunded) so an interruption never loses one.
 */
export async function fund(d: EscrowDeps, crew: Crew, payer: Keypair, opts: { confirm: boolean; maxSubtaskRaw?: bigint; onFunded?: (crew: Crew) => void }): Promise<FundResult> {
  const max = opts.maxSubtaskRaw ?? SELECT_PILOT_MAX_RAW;
  if (max > SELECT_PILOT_MAX_RAW) throw new CrewError("over_limit", `per-subtask limit cannot exceed the Select pilot limit ${rawToUsdc(SELECT_PILOT_MAX_RAW)} USDC`);
  const { unfunded } = checkSpend(crew, payer.publicKey.toBase58(), { maxSubtaskRaw: max });
  const policy = await workerPolicy(d);
  const previews = await Promise.all(unfunded.map(async (s) => ({ s, p: await previewSubtask(d, crew, s, payer.publicKey.toBase58(), policy) })));
  const lines = previews.map(({ s, p }) => fundLine(s, p));
  const totalGrossUsdc = rawToUsdc(unfunded.reduce((a, s) => a + usdcToRaw(s.amountUsdc), 0n)) || "0";
  const blocked = lines.filter((l) => l.blocking.length);
  if (!opts.confirm || blocked.length) {
    if (opts.confirm && blocked.length) throw new CrewError("preview_blocked", blocked.map((l) => `${l.id}: ${l.blocking.join("; ")}`).join(" | "));
    return { lines, totalGrossUsdc, funded: [], confirmed: false };
  }
  const funded: FundResult["funded"] = [];
  for (const { s, p } of previews) {
    const r = await fundSubtask(d, p, payer);
    s.escrow = { task: r.task, signature: r.signature, fundedAt: new Date().toISOString() };
    funded.push({ id: s.id, task: r.task, signature: r.signature });
    opts.onFunded?.(crew);
  }
  return { lines, totalGrossUsdc, funded, confirmed: true };
}

export type DeliverySource = (s: Subtask) => Promise<Uint8Array | null>;

/**
 * For each funded subtask: artifact-hash → read the sub-agent's output (if present) and deliver it when its
 * hash matches; payer-approval → approve only when listed in `approve`. Then refresh every subtask's state.
 */
export async function collect(d: EscrowDeps, crew: Crew, opts: { source?: DeliverySource; approve?: string[]; payer?: Keypair; sign?: (m: Uint8Array, k: Keypair) => Uint8Array }) {
  const actions: { id: string; action: string; detail: string }[] = [];
  for (const s of crew.subtasks) {
    const st = await readSubtask(d, s);
    if (st.state !== "funded") continue;
    if (s.rule.type === "artifact_hash" && opts.source) {
      const bytes = await opts.source(s);
      if (!bytes) { actions.push({ id: s.id, action: "waiting", detail: "no output from the sub-agent yet" }); continue; }
      const r = await deliverArtifact(d, s, bytes);
      actions.push({ id: s.id, action: r.accepted ? "delivered" : "rejected", detail: r.accepted ? `sha256 ${r.sha256} matches; settlement pending` : r.status ? `intake answered ${r.status}` : `sha256 ${r.sha256} does not match the commitment; not posted` });
    } else if (s.rule.type === "payer_approval" && opts.approve?.includes(s.id)) {
      if (!opts.payer || !opts.sign) throw new CrewError("no_wallet", "approval needs the payer wallet");
      const r = await approveRelease(d, s, opts.payer, opts.sign);
      actions.push({ id: s.id, action: r.accepted ? "approved" : "approval_rejected", detail: `intake answered ${r.status}` });
    }
  }
  return { actions, status: await status(d, crew) };
}

/** Current state of every subtask, recorded into the crew as receipts. */
export async function status(d: EscrowDeps, crew: Crew) {
  const rows = [];
  for (const s of crew.subtasks) {
    const st = await readSubtask(d, s);
    if (s.escrow) s.receipt = { status: st.state === "unfunded" ? "unfunded" : st.status, ...receiptOf(d, s.escrow.task), checkedAt: new Date().toISOString() };
    rows.push({ id: s.id, amountUsdc: s.amountUsdc, rule: s.rule.type, task: s.escrow?.task ?? null, ...st });
  }
  const settled = rows.filter((r) => "status" in r && (r.status === "Completed" || r.status === "completed")).length;
  return { rows, settled, total: rows.length, ready: rows.length > 0 && settled === rows.length };
}

/**
 * Gibwork submission, in three steps:
 *  - "dry": no network call; shows what would be submitted.
 *  - "quote": prepareCreate returns the participation fee. It creates a pending intent and pays nothing.
 *  - "confirm": signs and pays the fee, then submits.
 */
export async function submit(g: GibworkPort, crew: Crew, content: string, opts: { mode: "dry" | "quote" | "confirm"; requireAllSettled?: boolean; settled?: boolean }) {
  if (opts.requireAllSettled !== false && !opts.settled) throw new CrewError("not_ready", "not every subtask is settled; run collect first or pass --allow-partial");
  const idempotencyKey = `gwc-submit-${crew.gibwork.taskId}-${createHash("sha256").update(content).digest("hex").slice(0, 24)}`;
  if (opts.mode === "dry") return { mode: "dry" as const, taskId: crew.gibwork.taskId, contentBytes: Buffer.byteLength(content), idempotencyKey };
  const q = await g.prepareSubmission(crew.gibwork.taskId, content, idempotencyKey);
  if (opts.mode === "quote") return { mode: "quote" as const, feeUsdc: q.feeUsdc, feeDestination: q.feeDestination, intentId: q.intentId, expiresAt: q.expiresAt };
  const r = await g.submit(crew.gibwork.taskId, content, idempotencyKey);
  crew.submission = { intentId: r.intentId, status: r.status, feeUsdc: q.feeUsdc, idempotencyKey, at: new Date().toISOString() };
  return { mode: "confirm" as const, feeUsdc: q.feeUsdc, intentId: r.intentId, status: r.status, txHash: r.txHash };
}

/** One line per subtask linking the Gibwork bounty to the Select receipts. */
export function ledger(crew: Crew) {
  return {
    gibwork: { taskId: crew.gibwork.taskId, title: crew.gibwork.title, submission: crew.submission ?? null },
    subtasks: crew.subtasks.map((s) => ({ id: s.id, callee: s.callee, amountUsdc: s.amountUsdc, rule: s.rule.type, task: s.escrow?.task ?? null, fundTx: s.escrow?.signature ?? null, receipt: s.receipt ?? null })),
    spentGrossUsdc: rawToUsdc(crew.subtasks.filter((s) => s.escrow).reduce((a, s) => a + usdcToRaw(s.amountUsdc), 0n)) || "0",
  };
}
