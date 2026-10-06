/**
 * Network-free tests: crew file, spend guards, bounty ranking, planning, Gibwork submission modes, artifact
 * delivery and payer approval (HTTP mocked). The full lifecycle on the approved Select program binary
 * (LiteSVM replay: fund → deliver → settle → submit) runs in Select's main repository.
 */
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import nacl from "tweetnacl";
import { web3, approvalMessage } from "@selectinfra/agent-adapters/core";
import { checkSpend, parseCrew, rawToUsdc, usdcToRaw, type Crew } from "../src/crew.js";
import { rank, summarize, type BountySummary, type GibworkPort } from "../src/gibwork.js";
import { ledger, parseSubtaskSpec, plan, submit, SELECT_PILOT_MAX_RAW } from "../src/commands.js";
import { approveRelease, deliverArtifact, opKey, type EscrowDeps } from "../src/escrow.js";

const lead = web3.Keypair.generate(), writer = web3.Keypair.generate().publicKey.toBase58(), reviewer = web3.Keypair.generate().publicKey.toBase58();
const OUTPUT = Buffer.from("## SDK guide\n");
const SHA = createHash("sha256").update(OUTPUT).digest("hex");
const TASK = web3.Keypair.generate().publicKey.toBase58();

const gibwork = (calls: string[] = []): GibworkPort => ({
  async listAvailable() { return { items: [], hasMore: false }; },
  async get(id) { return { id, title: "Write an SDK guide", content: "", rewardReported: "60 USDC", deadline: new Date(Date.now() + 7 * 86_400_000).toISOString(), isOpen: true, gates: [] }; },
  async prepareSubmission(_t, _c, key) { calls.push(`prepare:${key}`); return { intentId: "i-1", status: "pending", feeUsdc: "0.5", feeDestination: "x", expiresAt: "y" }; },
  async submit(_t, _c, key) { calls.push(`submit:${key}`); return { intentId: "i-1", status: "fulfilled", txHash: "sig" }; },
  async getIntent() { return { status: "fulfilled", txHash: "sig" }; },
});
const specs = [`write|Write the guide|${writer}|2|${SHA}`, `review|Review it|${reviewer}|1`].map(parseSubtaskSpec);
const newCrew = async () => (await plan(gibwork(), "task-1", specs, { budgetUsdc: "3", deadlineSecs: 3600 })).crew;

function httpMock() {
  const posts: { url: string; body: any; type: string }[] = [];
  const f = (async (url: URL | string, init?: RequestInit) => {
    posts.push({ url: String(url), body: init?.body, type: String((init?.headers as any)?.["content-type"]) });
    return new Response("{}", { status: 202 });
  }) as typeof fetch;
  return { posts, f };
}
const deps = (f: typeof fetch): EscrowDeps => ({ chain: {} as any, cluster: "mainnet-beta", apiBaseUrl: "https://api.example", latestBlockhash: async () => ({ blockhash: "x", lastValidBlockHeight: 0 }), send: async () => "x", fetch: f });

describe("crew file and amounts", () => {
  it("exact USDC conversion, no floating point", () => {
    expect(usdcToRaw("2")).toBe(2_000_000n);
    expect(usdcToRaw("0.000001")).toBe(1n);
    expect(rawToUsdc(1_960_000n)).toBe("1.96");
    expect(rawToUsdc(10_000_000n)).toBe("10");
  });

  it("plan builds the rules from the specs; parse rejects bad ids, keys and duplicates", async () => {
    const crew = await newCrew();
    expect(crew.subtasks.map((s) => s.rule)).toEqual([{ type: "artifact_hash", sha256: SHA }, { type: "payer_approval" }]);
    expect(opKey(crew, crew.subtasks[0])).toBe("gwc:task-1:write");
    expect(() => parseCrew({ ...crew, subtasks: [crew.subtasks[0], crew.subtasks[0]] })).toThrow(/duplicate subtask id/);
    expect(() => parseCrew({ ...crew, subtasks: [{ ...crew.subtasks[0], id: "Bad Id" }] })).toThrow(/subtask id/);
    expect(() => parseCrew({ ...crew, subtasks: [{ ...crew.subtasks[0], callee: "not-a-key" }] })).toThrow(/public key/);
    expect(() => parseSubtaskSpec("a|b")).toThrow(/id\|description\|callee\|amountUsdc/);
  });

  it("refuses a bounty that is closed or ends before the subtask deadline", async () => {
    const g = gibwork();
    await expect(plan({ ...g, get: async (id) => ({ ...(await g.get(id)), isOpen: false }) }, "t", specs, { budgetUsdc: "3" })).rejects.toThrow(/not open/);
    await expect(plan({ ...g, get: async (id) => ({ ...(await g.get(id)), deadline: new Date(Date.now() + 60_000).toISOString() }) }, "t", specs, { budgetUsdc: "3", deadlineSecs: 3600 })).rejects.toThrow(/after the bounty deadline/);
  });

  it("spend guards: budget, per-subtask limit, self-payment", async () => {
    const crew = await newCrew();
    const max = { maxSubtaskRaw: SELECT_PILOT_MAX_RAW };
    expect(checkSpend(crew, lead.publicKey.toBase58(), max).totalRaw).toBe(3_000_000n);
    expect(() => checkSpend({ ...crew, budgetUsdc: "2.5" }, lead.publicKey.toBase58(), max)).toThrow(/exceeds the crew budget/);
    expect(() => checkSpend({ ...crew, budgetUsdc: "50", subtasks: [{ ...crew.subtasks[0], amountUsdc: "11" }] }, lead.publicKey.toBase58(), max)).toThrow(/per-subtask limit 10/);
    expect(() => checkSpend({ ...crew, subtasks: [{ ...crew.subtasks[1], callee: lead.publicKey.toBase58() }] }, lead.publicKey.toBase58(), max)).toThrow(/callee is the payer/);
  });
});

describe("scouting", () => {
  const b = (o: Partial<BountySummary>): BountySummary => ({ id: "b", title: "t", rewardUsdc: "100", symbol: "USDC", deadline: null, totalSubmissions: 0, slotsRemaining: null, tags: [], gates: [], ...o });

  it("USDC only, full or expiring bounties dropped, gated ones last, best reward per competing submission first", () => {
    const soon = new Date(Date.now() + 60_000).toISOString();
    const r = rank([b({ id: "gated", rewardUsdc: "900", gates: ["discord:Gib+role"] }), b({ id: "bonk", symbol: "BONK" }), b({ id: "full", slotsRemaining: 0 }),
      b({ id: "expiring", deadline: soon }), b({ id: "docs", rewardUsdc: "60", totalSubmissions: 2 }), b({ id: "big", rewardUsdc: "300", totalSubmissions: 9 })]);
    expect(r.map((x) => x.id)).toEqual(["big", "docs", "gated"]);
    expect(r[2].why).toMatch(/needs a human step/);
  });

  it("summarize converts the base-unit reward and lists the gates", () => {
    const s = summarize({ id: "x", slug: "x", title: "T", content: "", requirements: null, tags: ["Docs"], primarySkillId: null, createdAt: "", deadline: null, status: "CREATED", isOpen: true,
      asset: { mintAddress: "m", symbol: "USDC", imageUrl: "", decimals: 6, amount: "25000000" }, minSubmissionAmount: null, totalSubmissions: 1, maxSubmissions: null, standardSubmissionSlotsRemaining: 3, requiresPremium: true,
      participationRequirements: { allowOnlyVerifiedSubmissions: false, allowOnlyVerifiedTwitterAccountSubmissions: false, minTwitterFollowers: 0, minTweetLikes: 0, minTweetViews: 0, isTwitterTask: false,
        allowOnlyDiscordGuildSubmissions: true, requiredDiscordGuildId: "1", requiredDiscordGuildName: "Gib", discordGuildInvitationUrl: null, requiredDiscordRoleIds: ["r"] } });
    expect(s).toMatchObject({ rewardUsdc: "25", gates: ["discord:Gib+role", "premium"] });
  });
});

describe("delivery and approval", () => {
  it("a wrong output is never posted; the right one is posted as raw bytes to the task's artifact intake", async () => {
    const crew = await newCrew(), s = { ...crew.subtasks[0], escrow: { task: TASK, fundedAt: "now" } };
    const { posts, f } = httpMock();
    expect(await deliverArtifact(deps(f), s, Buffer.from("draft"))).toMatchObject({ accepted: false, status: 0 });
    expect(posts).toHaveLength(0);
    expect(await deliverArtifact(deps(f), s, OUTPUT)).toMatchObject({ accepted: true, status: 202, sha256: SHA });
    expect(posts[0]).toMatchObject({ url: `https://api.example/v2/tasks/${TASK}/artifact`, type: "application/octet-stream" });
  });

  it("payer approval signs the exact release message; artifact and approval rules cannot be swapped", async () => {
    const crew = await newCrew(), s = { ...crew.subtasks[1], escrow: { task: TASK, fundedAt: "now" } };
    const { posts, f } = httpMock();
    expect(await approveRelease(deps(f), s, lead, (m, k) => nacl.sign.detached(m, k.secretKey))).toMatchObject({ accepted: true });
    const body = JSON.parse(posts[0].body);
    expect(posts[0].url).toBe(`https://api.example/v2/tasks/${TASK}/approvals`);
    expect(nacl.sign.detached.verify(approvalMessage("release", new web3.PublicKey(TASK)), Buffer.from(body.signature, "hex"), lead.publicKey.toBytes())).toBe(true);
    await expect(deliverArtifact(deps(f), s, OUTPUT)).rejects.toThrow(/payer approval/);
    await expect(approveRelease(deps(f), { ...crew.subtasks[0], escrow: { task: TASK, fundedAt: "now" } }, lead, () => new Uint8Array(64))).rejects.toThrow(/artifact hash/);
  });
});

describe("Gibwork submission", () => {
  it("dry makes no call; quote only prepares; confirm submits once with a content-derived idempotency key; unsettled crews are refused", async () => {
    const calls: string[] = [], g = gibwork(calls), crew: Crew = await newCrew();
    expect(await submit(null as unknown as GibworkPort, crew, "# Work", { mode: "dry", settled: true })).toMatchObject({ mode: "dry" });
    expect(calls).toEqual([]);
    expect(await submit(g, crew, "# Work", { mode: "quote", settled: true })).toMatchObject({ mode: "quote", feeUsdc: "0.5" });
    expect(calls.some((c) => c.startsWith("submit"))).toBe(false);
    expect(await submit(g, crew, "# Work", { mode: "confirm", settled: true })).toMatchObject({ mode: "confirm", status: "fulfilled" });
    const keys = calls.map((c) => c.split(":")[1]);
    expect(new Set(keys).size).toBe(1);
    await expect(submit(g, crew, "# Work", { mode: "confirm", settled: false })).rejects.toThrow(/not every subtask is settled/);
    expect(ledger(crew).gibwork.submission).toMatchObject({ intentId: "i-1", feeUsdc: "0.5" });
  });
});
