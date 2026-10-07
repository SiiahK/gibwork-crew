/**
 * Select side of a crew: preview and fund one escrow per subtask, deliver verified outputs, read status.
 *
 * Funding signs create_task_v2 with the crew lead's wallet (the payer) only after the preview is shown and
 * confirmed. Delivery is open: anyone may post an artifact, and the settlement worker releases only when its
 * SHA-256 equals the commitment fixed at creation. Payer-approval subtasks are released by the payer's
 * signed message. Nothing here can redirect funds: the program pays only the subtask's callee or the payer.
 */

import { createHash } from "node:crypto";
import {
  web3, TaskStatus, approvalMessage, buildCreateInstructions, configPda, decodeProtocolConfig, decodeTask, decodeTombstone,
  previewTask, resolveRoutingDomain, USDC_MINT, PROGRAM_ID, type ChainReader, type TaskPreview, type WorkerPolicy,
} from "@selecto-infra/agent-adapters/core";
import { CrewError, type Crew, type Subtask } from "./crew.js";

const { PublicKey, Transaction } = web3;
type Keypair = InstanceType<typeof web3.Keypair>;

export interface EscrowDeps {
  chain: ChainReader;
  cluster: "mainnet-beta" | "devnet" | "localnet";
  /** Select evidence intake, e.g. https://api.tryaigility.com */
  apiBaseUrl: string;
  latestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number }>;
  /** Sends a signed transaction and waits for confirmation; returns the signature. */
  send(tx: InstanceType<typeof Transaction>): Promise<string>;
  fetch?: typeof fetch;
  /** Integrator authority (25% of the fee) — the crew tool's operator, never the payer. */
  affiliate?: string | null;
  domain?: string;
}

/** The task's idempotency key is derived from the Gibwork bounty and the subtask id, so a retry never creates a second escrow. */
export const opKey = (crew: Crew, s: Subtask) => `gwc:${crew.gibwork.taskId}:${s.id}`.slice(0, 128);

/** The settlement worker's published policy (GET /health): allowed mints and per-task limit. Read-only; null when unreachable. */
export async function workerPolicy(d: EscrowDeps): Promise<WorkerPolicy | null> {
  try {
    const r = await (d.fetch ?? fetch)(new URL("/health", d.apiBaseUrl), { signal: AbortSignal.timeout(5_000), redirect: "error" });
    return ((await r.json()) as { policy?: WorkerPolicy }).policy ?? null;
  } catch { return null; }
}

export async function previewSubtask(d: EscrowDeps, crew: Crew, s: Subtask, payer: string, policy?: WorkerPolicy | null): Promise<TaskPreview> {
  return previewTask({
    cluster: d.cluster, tenant: "gibwork-crew", payer, callee: s.callee, mint: USDC_MINT.toBase58(), amount: s.amountUsdc,
    amountBasis: "gross", deadlineSecs: crew.deadlineSecs, idempotencyKey: opKey(crew, s), domain: resolveRoutingDomain(d.domain),
    verification: s.rule.type === "artifact_hash" ? { type: "artifact_hash", sha256: s.rule.sha256 } : { type: "payer_approval" },
  }, d.chain, { workerPolicy: policy === undefined ? await workerPolicy(d) : policy });
}

export interface FundLine {
  id: string; task: string; grossUsdc: string; feeUsdc: string; calleeReceivesUsdc: string; rentLockedSol: string; rentReturnedSol: string;
  blocking: string[]; warnings: string[];
}

export const fundLine = (s: Subtask, p: TaskPreview): FundLine => ({
  id: s.id, task: p.binding.task, grossUsdc: p.display.payerTransfers, feeUsdc: p.display.fee, calleeReceivesUsdc: p.display.calleeReceivesOnRelease,
  rentLockedSol: (Number(p.rent.lockedAtCreateLamports) / 1e9).toFixed(6), rentReturnedSol: (Number(p.rent.returnedToPayerOnCloseLamports) / 1e9).toFixed(6),
  blocking: p.blocking, warnings: p.warnings,
});

/** Builds, signs and sends create_task_v2 for one previewed subtask. The caller has already obtained confirmation. */
export async function fundSubtask(d: EscrowDeps, preview: TaskPreview, payer: Keypair): Promise<{ task: string; signature: string; commission: string }> {
  if (preview.blocking.length) throw new CrewError("preview_blocked", preview.blocking.join("; "));
  if (preview.binding.payer !== payer.publicKey.toBase58()) throw new CrewError("wrong_payer", "preview was made for another payer");
  if ((await d.chain.now()) > preview.expiresAt) throw new CrewError("preview_expired", "preview expired; run fund again");
  const existing = await d.chain.getAccount(new PublicKey(preview.binding.task));
  if (existing) throw new CrewError("already_funded", `escrow ${preview.binding.task} already exists (idempotent: no second fee)`);
  const cfg = decodeProtocolConfig((await d.chain.getAccount(configPda()))!.data);
  const { ixs, route } = await buildCreateInstructions(d.chain, preview, payer.publicKey, d.affiliate ?? null, cfg.treasuryAuthority);
  const bh = await d.latestBlockhash();
  const tx = new Transaction({ feePayer: payer.publicKey, blockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight }).add(...ixs);
  tx.sign(payer);
  const signature = await d.send(tx);
  return { task: preview.binding.task, signature, commission: route.kind === "affiliate" ? route.commissionWallet : "treasury" };
}

export type SubtaskState =
  | { state: "unfunded" }
  | { state: "funded" | "terminal"; status: string; callee?: string; deadline?: string; closed: boolean };

export async function readSubtask(d: EscrowDeps, s: Subtask): Promise<SubtaskState> {
  if (!s.escrow) return { state: "unfunded" };
  const a = await d.chain.getAccount(new PublicKey(s.escrow.task));
  if (!a || !a.owner.equals(PROGRAM_ID)) return { state: "terminal", status: "absent", closed: true };
  try {
    const t = decodeTask(a.data);
    const live = t.status === TaskStatus.Funded || t.status === TaskStatus.Active;
    return { state: live ? "funded" : "terminal", status: TaskStatus[t.status], callee: t.calleeAgent.toBase58(), deadline: new Date(Number(t.deadline) * 1000).toISOString(), closed: false };
  } catch {
    return { state: "terminal", status: decodeTombstone(a.data).terminalStatus, closed: true };
  }
}

const CLOCK_SYSVAR = new PublicKey("SysvarC1ock11111111111111111111111111111111");

/**
 * Cluster time from the Clock sysvar (unix_timestamp at offset 32): the same clock the program uses for
 * deadlines, and always available. getBlockTime(latest slot) can fail on RPCs that have not stored the block yet.
 */
export function clusterClock(conn: InstanceType<typeof web3.Connection>): () => Promise<number> {
  return async () => {
    const a = await conn.getAccountInfo(CLOCK_SYSVAR, "confirmed");
    if (a && a.data.length >= 40) return Number(a.data.readBigInt64LE(32));
    const slot = await conn.getSlot("confirmed");
    return (await conn.getBlockTime(slot).catch(() => null)) ?? Math.floor(Date.now() / 1000);
  };
}

export const sha256Hex = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/**
 * Delivers a sub-agent's output for an artifact-hash subtask. The bytes are checked locally first: a mismatch
 * is never posted (the worker would reject it, and the sub-agent should fix its output instead).
 */
export async function deliverArtifact(d: EscrowDeps, s: Subtask, bytes: Uint8Array): Promise<{ accepted: boolean; status: number; sha256: string }> {
  if (s.rule.type !== "artifact_hash") throw new CrewError("wrong_rule", `subtask ${s.id} is released by payer approval, not by artifact`);
  if (!s.escrow) throw new CrewError("unfunded", `subtask ${s.id} has no escrow yet`);
  const sha256 = sha256Hex(bytes);
  if (sha256 !== s.rule.sha256) return { accepted: false, status: 0, sha256 };
  const r = await (d.fetch ?? fetch)(new URL(`/v2/tasks/${s.escrow.task}/artifact`, d.apiBaseUrl), { method: "POST", headers: { "content-type": "application/octet-stream" }, body: new Uint8Array(bytes) });
  return { accepted: r.status === 200 || r.status === 202, status: r.status, sha256 };
}

/** Payer approval: signs the release message with the payer key and posts it to the evidence intake. */
export async function approveRelease(d: EscrowDeps, s: Subtask, payer: Keypair, sign: (msg: Uint8Array, kp: Keypair) => Uint8Array): Promise<{ accepted: boolean; status: number }> {
  if (s.rule.type !== "payer_approval") throw new CrewError("wrong_rule", `subtask ${s.id} is released by its artifact hash`);
  if (!s.escrow) throw new CrewError("unfunded", `subtask ${s.id} has no escrow yet`);
  const msg = approvalMessage("release", new PublicKey(s.escrow.task));
  const body = { action: "release", signer: payer.publicKey.toBase58(), signature: Buffer.from(sign(msg, payer)).toString("hex") };
  const r = await (d.fetch ?? fetch)(new URL(`/v2/tasks/${s.escrow.task}/approvals`, d.apiBaseUrl), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { accepted: r.status === 200 || r.status === 202, status: r.status };
}

export const receiptOf = (d: EscrowDeps, task: string) => ({ memo: `rufus://${task}`, url: new URL(`/v2/receipts/${task}`, d.apiBaseUrl).toString() });
