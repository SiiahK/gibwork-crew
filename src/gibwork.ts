/**
 * Gibwork side, behind a small port so commands are testable without the network.
 * The adapter wraps the official @gibwork/sdk (discovery, task details, submission intents).
 * Submitting work on Gibwork charges a participation fee: prepare first (shows the fee), pay only on --yes.
 */

import type { GibworkClient, AvailableTask, TaskDetails, TaskSubmissionIntent } from "@gibwork/sdk";

export interface BountySummary {
  id: string; title: string; rewardUsdc: string | null; symbol: string | null; deadline: string | null;
  totalSubmissions: number; slotsRemaining: number | null; tags: string[];
  /** Gates that the agent cannot pass by itself (Discord role, verified accounts, premium, Twitter). */
  gates: string[];
}

export interface SubmissionQuote { intentId: string; status: string; feeUsdc: string; feeDestination: string; expiresAt: string; serializedTransaction?: string }

export interface GibworkPort {
  listAvailable(page: number, limit: number): Promise<{ items: BountySummary[]; hasMore: boolean }>;
  get(taskId: string): Promise<{ id: string; title: string; content: string; rewardReported: string | null; deadline: string | null; isOpen: boolean; gates: string[] }>;
  /** Creates (or returns) a pending submission intent and its fee quote. Pays nothing. */
  prepareSubmission(taskId: string, content: string, idempotencyKey: string): Promise<SubmissionQuote>;
  /** Signs and pays the participation fee, then submits. Only called with explicit confirmation. */
  submit(taskId: string, content: string, idempotencyKey: string): Promise<{ intentId: string; status: string; txHash: string | null }>;
  getIntent(taskId: string, intentId: string): Promise<{ status: string; txHash: string | null }>;
}

const units = (amount: string | number | null | undefined, decimals: number) => {
  if (amount === null || amount === undefined) return null;
  const raw = BigInt(typeof amount === "number" ? Math.round(amount) : amount);
  if (decimals === 0) return raw.toString();
  const base = 10n ** BigInt(decimals);
  return `${raw / base}.${(raw % base).toString().padStart(decimals, "0")}`.replace(/\.?0+$/, "");
};

function gatesOf(r: Partial<AvailableTask["participationRequirements"]> & { requiresPremium?: boolean }): string[] {
  const g: string[] = [];
  if (r.allowOnlyDiscordGuildSubmissions) g.push(`discord:${r.requiredDiscordGuildName ?? r.requiredDiscordGuildId ?? "guild"}${r.requiredDiscordRoleIds?.length ? "+role" : ""}`);
  if (r.allowOnlyVerifiedSubmissions) g.push("verified-account");
  if (r.allowOnlyVerifiedTwitterAccountSubmissions || r.isTwitterTask) g.push("twitter");
  if (r.requiresPremium) g.push("premium");
  return g;
}

export function summarize(t: AvailableTask): BountySummary {
  return {
    id: t.id, title: t.title, rewardUsdc: t.asset ? units(t.asset.amount, t.asset.decimals) : null, symbol: t.asset?.symbol ?? null,
    deadline: t.deadline, totalSubmissions: t.totalSubmissions, slotsRemaining: t.standardSubmissionSlotsRemaining, tags: t.tags,
    gates: gatesOf({ ...t.participationRequirements, requiresPremium: t.requiresPremium }),
  };
}

/**
 * Rank for a crew: open slots, no human-only gates, USDC reward, more reward per competing submission,
 * then the latest deadline. Returns the score so the agent can explain its choice.
 */
export function rank(items: BountySummary[], now = Date.now(), opts: { minRewardUsdc?: number; tag?: string } = {}) {
  return items
    .filter((b) => b.symbol === "USDC" && b.rewardUsdc !== null && Number(b.rewardUsdc) >= (opts.minRewardUsdc ?? 0))
    .filter((b) => b.slotsRemaining === null || b.slotsRemaining > 0)
    .filter((b) => !b.deadline || Date.parse(b.deadline) > now + 3_600_000)
    .filter((b) => !opts.tag || b.tags.some((t) => t.toLowerCase() === opts.tag!.toLowerCase()))
    .map((b) => {
      const perSubmission = Number(b.rewardUsdc) / (b.totalSubmissions + 1);
      const score = Math.round(perSubmission * 100) / 100 - (b.gates.length ? 1_000 : 0);
      return { ...b, score, why: b.gates.length ? `gated (${b.gates.join(", ")}): needs a human step` : `${perSubmission.toFixed(2)} USDC per competing submission` };
    })
    .sort((a, b) => b.score - a.score || Date.parse(b.deadline ?? "9999") - Date.parse(a.deadline ?? "9999"));
}

/** Adapter over the official SDK client. */
export function gibworkAdapter(client: GibworkClient): GibworkPort {
  const quote = (i: TaskSubmissionIntent): SubmissionQuote => ({
    intentId: i.intentId, status: i.status, feeUsdc: i.fee.amount, feeDestination: i.fee.destinationAddress, expiresAt: i.expiresAt,
    serializedTransaction: i.serializedTransaction,
  });
  return {
    async listAvailable(page, limit) {
      const p = await client.tasks.listAvailable({ page, limit });
      return { items: p.results.map(summarize), hasMore: p.page < p.lastPage };
    },
    async get(taskId) {
      const t: TaskDetails = await client.tasks.get(taskId);
      return {
        id: t.id, title: t.title, content: t.content, rewardReported: t.asset ? `${t.asset.amount} ${t.asset.symbol}` : null, deadline: t.deadline, isOpen: t.isOpen,
        gates: gatesOf({ allowOnlyDiscordGuildSubmissions: t.allowOnlyDiscordGuildSubmissions, requiredDiscordGuildName: t.requiredDiscordGuildName ?? null,
          requiredDiscordRoleIds: t.requiredDiscordRoleIds, allowOnlyVerifiedSubmissions: t.allowOnlyVerifiedSubmissions,
          allowOnlyVerifiedTwitterAccountSubmissions: t.allowOnlyVerifiedTwitterAccountSubmissions ?? false }),
      };
    },
    async prepareSubmission(taskId, content, idempotencyKey) {
      return quote(await client.submissions.prepareCreate(taskId, { content, idempotencyKey }));
    },
    async submit(taskId, content, idempotencyKey) {
      const i = await client.submissions.create(taskId, { content, idempotencyKey });
      return { intentId: i.intentId, status: i.status, txHash: i.txHash };
    },
    async getIntent(taskId, intentId) {
      const i = await client.submissions.getIntent(taskId, intentId);
      return { status: i.status, txHash: i.txHash };
    },
  };
}
