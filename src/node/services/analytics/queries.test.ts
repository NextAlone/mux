import assert from "node:assert/strict";
import { afterEach, describe, expect, test } from "bun:test";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { z } from "zod";
import {
  HistogramBucketSchema,
  SpendOverTimeRowSchema,
  SpendByModelRowSchema,
  SummaryRowSchema,
  TimingPercentilesRowSchema,
  TokensByModelRowSchema,
} from "@/common/orpc/schemas/analytics";
import { executeNamedQuery, type DashboardQueryResult } from "./queries";
import {
  CREATE_DELEGATION_ROLLUPS_TABLE_SQL,
  CREATE_EVENTS_TABLE_SQL,
  CREATE_PROVIDER_QUOTA_SNAPSHOTS_TABLE_SQL,
} from "./schemaSql";

const duckDbHandlesToClose: Array<{ instance: DuckDBInstance; conn: DuckDBConnection }> = [];

interface EventSeed {
  workspaceId: string;
  date: string;
  timestamp: number;
  model: string;
  toolName?: string | null;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
  cachedTokens?: number;
  cacheCreateTokens?: number;
  totalCostUsd: number;
  costStatus?: "priced" | "included" | "unknown";
  billingRoute?: "codex-oauth" | "openai-api-key" | "mux-gateway" | "provider-direct" | "unknown";
  durationMs?: number | null;
  ttftMs?: number | null;
  outputTps?: number | null;
}

async function createTestConn(): Promise<DuckDBConnection> {
  const instance = await DuckDBInstance.create(":memory:");
  const conn = await instance.connect();
  duckDbHandlesToClose.push({ instance, conn });

  await conn.run(CREATE_EVENTS_TABLE_SQL);
  await conn.run("ALTER TABLE events ADD COLUMN IF NOT EXISTS tool_name VARCHAR");
  await conn.run(CREATE_DELEGATION_ROLLUPS_TABLE_SQL);
  await conn.run(CREATE_PROVIDER_QUOTA_SNAPSHOTS_TABLE_SQL);

  return conn;
}

async function insertEvent(conn: DuckDBConnection, seed: EventSeed): Promise<void> {
  await conn.run(
    `INSERT INTO events (
      workspace_id,
      date,
      timestamp,
      model,
      tool_name,
      input_tokens,
      output_tokens,
      reasoning_tokens,
      cached_tokens,
      cache_create_tokens,
      total_cost_usd,
      cost_status,
      billing_route,
      duration_ms,
      ttft_ms,
      output_tps,
      is_sub_agent
    ) VALUES (
      ?, CAST(? AS DATE), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    )`,
    [
      seed.workspaceId,
      seed.date,
      BigInt(seed.timestamp),
      seed.model,
      seed.toolName ?? null,
      seed.inputTokens,
      seed.outputTokens,
      seed.reasoningTokens ?? 0,
      seed.cachedTokens ?? 0,
      seed.cacheCreateTokens ?? 0,
      seed.totalCostUsd,
      seed.costStatus ?? "priced",
      seed.billingRoute ?? "provider-direct",
      seed.durationMs ?? null,
      seed.ttftMs ?? null,
      seed.outputTps ?? null,
      false,
    ]
  );
}

afterEach(() => {
  for (const { conn, instance } of duckDbHandlesToClose.splice(0).reverse()) {
    try {
      conn.closeSync();
    } catch {
      // Ignore close failures in test cleanup.
    }

    try {
      instance.closeSync();
    } catch {
      // Ignore close failures in test cleanup.
    }
  }
});

describe("analytics queries", () => {
  test("includes tool rows in spend and token totals while excluding them from response counts and timing", async () => {
    const conn = await createTestConn();
    const workspaceId = "ws-tool-query-analytics";
    const date = "2026-04-20";

    await insertEvent(conn, {
      workspaceId,
      date,
      timestamp: 1,
      model: "openai:gpt-4",
      inputTokens: 10,
      outputTokens: 5,
      totalCostUsd: 1,
      durationMs: 100,
      ttftMs: 20,
      outputTps: 50,
    });
    await insertEvent(conn, {
      workspaceId,
      date,
      timestamp: 2,
      model: "openai:gpt-4",
      toolName: "bash",
      inputTokens: 3,
      outputTokens: 2,
      totalCostUsd: 0.2,
      durationMs: 900,
      ttftMs: 500,
      outputTps: 2,
    });
    await insertEvent(conn, {
      workspaceId,
      date,
      timestamp: 3,
      model: "anthropic:claude-sonnet-4-20250514",
      inputTokens: 20,
      outputTokens: 10,
      totalCostUsd: 2,
      durationMs: 300,
      ttftMs: 60,
      outputTps: 100 / 3,
    });
    await insertEvent(conn, {
      workspaceId,
      date,
      timestamp: 4,
      model: "anthropic:claude-opus-4-20250514",
      toolName: "advisor",
      inputTokens: 7,
      outputTokens: 1,
      totalCostUsd: 0.7,
      durationMs: 1_200,
      ttftMs: 800,
      outputTps: 0.5,
    });

    const summary = SummaryRowSchema.parse(await executeNamedQuery(conn, "getSummary", {}));
    expect(summary.total_spend_usd).toBeCloseTo(3.9, 12);
    expect(summary.total_tokens).toBe(58);
    expect(summary.total_responses).toBe(2);

    const spendByModel = z
      .array(SpendByModelRowSchema)
      .parse(await executeNamedQuery(conn, "getSpendByModel", {}));
    const spendByModelMap = new Map(spendByModel.map((row) => [row.model, row]));
    expect(spendByModelMap.get("openai:gpt-4")).toMatchObject({
      cost_usd: 1.2,
      token_count: 20,
      response_count: 1,
    });
    expect(spendByModelMap.get("anthropic:claude-sonnet-4-20250514")).toMatchObject({
      cost_usd: 2,
      token_count: 30,
      response_count: 1,
    });
    expect(spendByModelMap.get("anthropic:claude-opus-4-20250514")).toMatchObject({
      cost_usd: 0.7,
      token_count: 8,
      response_count: 0,
    });

    const tokensByModel = z
      .array(TokensByModelRowSchema)
      .parse(await executeNamedQuery(conn, "getTokensByModel", {}));
    const tokensByModelMap = new Map(tokensByModel.map((row) => [row.model, row]));
    expect(tokensByModelMap.get("openai:gpt-4")).toMatchObject({
      total_tokens: 20,
      request_count: 1,
    });
    expect(tokensByModelMap.get("anthropic:claude-sonnet-4-20250514")).toMatchObject({
      total_tokens: 30,
      request_count: 1,
    });
    expect(tokensByModelMap.get("anthropic:claude-opus-4-20250514")).toMatchObject({
      total_tokens: 8,
      request_count: 0,
    });

    const timing = z
      .object({
        percentiles: TimingPercentilesRowSchema,
        histogram: z.array(HistogramBucketSchema),
      })
      .parse(await executeNamedQuery(conn, "getTimingDistribution", { metric: "duration" }));
    expect(timing.percentiles.p50).toBeCloseTo(200, 12);

    const histogramCount = timing.histogram.reduce((sum, bucket) => {
      return sum + bucket.count;
    }, 0);
    assert(Number.isInteger(histogramCount), "histogramCount should remain integral");
    expect(histogramCount).toBe(2);
  });

  test("filters by exact local-day timestamps and reports OAuth included usage separately", async () => {
    const conn = await createTestConn();
    const localMidnightShanghai = Date.UTC(2026, 6, 1, 16);

    await insertEvent(conn, {
      workspaceId: "ws-before-local-day",
      date: "2026-07-01",
      timestamp: localMidnightShanghai - 1,
      model: "openai:gpt-5.6-sol",
      inputTokens: 100,
      outputTokens: 20,
      totalCostUsd: 1,
    });
    await insertEvent(conn, {
      workspaceId: "ws-oauth-local-day",
      date: "2026-07-01",
      timestamp: localMidnightShanghai + 1,
      model: "openai:gpt-5.6-sol",
      inputTokens: 200,
      outputTokens: 50,
      totalCostUsd: 0,
      costStatus: "included",
      billingRoute: "codex-oauth",
    });
    await conn.run(
      `INSERT INTO delegation_rollups
       (parent_workspace_id, child_workspace_id, rolled_up_at_ms, date)
       VALUES ('parent', 'before-local-day', ?, CAST('2026-07-01' AS DATE)),
              ('parent', 'inside-local-day', ?, CAST('2026-07-01' AS DATE))`,
      [BigInt(localMidnightShanghai - 1), BigInt(localMidnightShanghai + 1)]
    );

    const summary = SummaryRowSchema.parse(
      await executeNamedQuery(conn, "getSummary", {
        from: localMidnightShanghai,
        todayStart: localMidnightShanghai,
        todayEnd: localMidnightShanghai + 86_399_999,
      })
    );
    expect(summary.total_tokens).toBe(250);
    expect(summary.today_spend_usd).toBe(0);
    expect(summary.included_tokens).toBe(250);
    expect(summary.oauth_tokens).toBe(250);
    expect(summary.oauth_requests).toBe(1);

    const trend = z.array(SpendOverTimeRowSchema).parse(
      await executeNamedQuery(conn, "getSpendOverTime", {
        granularity: "day",
        from: localMidnightShanghai,
        timezone: "Asia/Shanghai",
      })
    );
    expect(trend).toHaveLength(1);
    expect(trend[0]?.bucket).toBe("2026-07-02");

    const delegation = (await executeNamedQuery(conn, "getDelegationSummary", {
      from: localMidnightShanghai,
    })) as { totals: { total_children: number } };
    expect(delegation.totals.total_children).toBe(1);
  });

  test("returns dashboard usage and the latest account-scoped quota in one named query", async () => {
    const conn = await createTestConn();
    await insertEvent(conn, {
      workspaceId: "ws-dashboard",
      date: "2026-07-19",
      timestamp: Date.UTC(2026, 6, 19, 2),
      model: "openai:gpt-5.6-sol",
      inputTokens: 300,
      outputTokens: 100,
      totalCostUsd: 0,
      costStatus: "included",
      billingRoute: "codex-oauth",
      durationMs: 500,
      ttftMs: 50,
      outputTps: 200,
    });
    await conn.run(
      `INSERT INTO provider_quota_snapshots
       (provider, account_key, window_kind, observed_at, last_observed_at,
        used_percent, remaining_percent, reset_at, source)
       VALUES ('openai-codex', 'account-a', 'five-hour', ?, ?, 20, 80, NULL, 'headers')`,
      [BigInt(1000), BigInt(2000)]
    );

    const result = (await executeNamedQuery(conn, "getDashboard", {
      projectPath: null,
      granularity: "day",
      timingMetric: "duration",
      codexAccountKey: "account-a",
      timezone: "Asia/Shanghai",
    })) as DashboardQueryResult;

    expect(result.summary.oauth_tokens).toBe(400);
    expect(result.spendOverTime).toHaveLength(1);
    expect(result.codexQuotaRows).toMatchObject([
      { window_kind: "five-hour", observed_at: 2000, remaining_percent: 80 },
    ]);
  });
});
