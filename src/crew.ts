/**
 * Crew file (crew.json): one Gibwork bounty, split into subtasks that sub-agents deliver and that are paid
 * through Select escrow on verified delivery. The file is the single source of truth for every command:
 * plan writes it, fund adds escrow addresses, collect records receipts, submit records the Gibwork intent.
 */

import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { z } from "zod";

const KEY = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, "base58 public key");
const USDC = z.string().regex(/^(0|[1-9][0-9]{0,6})(\.[0-9]{1,6})?$/, "USDC amount, up to 6 decimals");
const ID = z.string().regex(/^[a-z0-9-]{1,32}$/, "subtask id: [a-z0-9-]{1,32}");

export const RuleSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("artifact_hash"), sha256: z.string().regex(/^[0-9a-f]{64}$/) }),
  z.object({ type: z.literal("payer_approval") }),
]);

export const SubtaskSchema = z.object({
  id: ID,
  description: z.string().min(1).max(500),
  callee: KEY,
  amountUsdc: USDC,
  rule: RuleSchema,
  /** Filled by fund. */
  escrow: z.object({ task: KEY, signature: z.string().optional(), fundedAt: z.string() }).optional(),
  /** Filled by collect. */
  receipt: z.object({ status: z.string(), memo: z.string(), url: z.string(), checkedAt: z.string() }).optional(),
});

export const CrewSchema = z.object({
  version: z.literal(1),
  gibwork: z.object({ taskId: z.string().min(1).max(64), title: z.string().max(300), rewardReported: z.string().max(64).nullable(), deadline: z.string().nullable() }),
  /** Total the crew lead may lock in escrow for this bounty (gross, fees included). */
  budgetUsdc: USDC,
  deadlineSecs: z.number().int().min(600).max(2_592_000),
  subtasks: z.array(SubtaskSchema).max(20),
  submission: z.object({ intentId: z.string(), status: z.string(), feeUsdc: z.string(), idempotencyKey: z.string(), at: z.string() }).optional(),
});

export type Crew = z.infer<typeof CrewSchema>;
export type Subtask = z.infer<typeof SubtaskSchema>;
export type Rule = z.infer<typeof RuleSchema>;

export class CrewError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = "CrewError"; }
}

/** Exact decimal → atomic units (6 decimals); no floating point. */
export function usdcToRaw(v: string): bigint {
  const [i, f = ""] = v.split(".");
  return BigInt(i) * 1_000_000n + BigInt((f + "000000").slice(0, 6));
}
export const rawToUsdc = (r: bigint) => `${r / 1_000_000n}.${(r % 1_000_000n).toString().padStart(6, "0")}`.replace(/\.?0+$/, "");

export function parseCrew(json: unknown): Crew {
  const r = CrewSchema.safeParse(json);
  if (!r.success) throw new CrewError("invalid_crew", r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  const ids = new Set<string>();
  for (const s of r.data.subtasks) {
    if (ids.has(s.id)) throw new CrewError("invalid_crew", `duplicate subtask id ${s.id}`);
    ids.add(s.id);
  }
  return r.data;
}

export const loadCrew = (path: string) => parseCrew(JSON.parse(readFileSync(path, "utf-8")));

/** Atomic write (temp file + rename), so an interrupted command never leaves a half-written crew file. */
export function saveCrew(path: string, crew: Crew) {
  parseCrew(crew);
  writeFileSync(`${path}.tmp`, JSON.stringify(crew, null, 2) + "\n");
  renameSync(`${path}.tmp`, path);
}

export interface SpendLimits {
  /** Per-subtask gross ceiling (atomic units); the Select pilot limit is 10 USDC. */
  maxSubtaskRaw: bigint;
}

/**
 * Checks before any escrow is funded: each subtask within the per-subtask ceiling, the crew total within the
 * budget, the payer never pays itself.
 */
export function checkSpend(crew: Crew, payer: string, limits: SpendLimits): { totalRaw: bigint; unfunded: Subtask[] } {
  const totalRaw = crew.subtasks.reduce((a, s) => a + usdcToRaw(s.amountUsdc), 0n);
  if (totalRaw > usdcToRaw(crew.budgetUsdc)) throw new CrewError("over_budget", `subtasks total ${rawToUsdc(totalRaw)} USDC exceeds the crew budget ${crew.budgetUsdc} USDC`);
  for (const s of crew.subtasks) {
    const raw = usdcToRaw(s.amountUsdc);
    if (raw <= 0n) throw new CrewError("invalid_amount", `subtask ${s.id}: amount must be positive`);
    if (raw > limits.maxSubtaskRaw) throw new CrewError("over_limit", `subtask ${s.id}: ${s.amountUsdc} USDC exceeds the per-subtask limit ${rawToUsdc(limits.maxSubtaskRaw)} USDC`);
    if (s.callee === payer) throw new CrewError("self_payment", `subtask ${s.id}: the callee is the payer`);
  }
  return { totalRaw, unfunded: crew.subtasks.filter((s) => !s.escrow) };
}
