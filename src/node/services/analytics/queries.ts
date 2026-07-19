import assert from "node:assert/strict";
import type { DuckDBConnection, DuckDBValue } from "@duckdb/node-api";
import type { z } from "zod";
import {
  AgentCostRowSchema,
  DelegationAgentBreakdownRowSchema,
  DelegationSummaryTotalsRowSchema,
  HistogramBucketSchema,
  ProviderCacheHitModelRowSchema,
  ProviderQuotaSnapshotRowSchema,
  SpendByModelRowSchema,
  SpendByProjectRowSchema,
  SpendOverTimeRowSchema,
  SummaryRowSchema,
  TimingPercentilesRowSchema,
  TokensByModelRowSchema,
  type AgentCostRow,
  type DelegationAgentBreakdownRow,
  type DelegationSummaryTotalsRow,
  type HistogramBucket,
  type ProviderCacheHitModelRow,
  type ProviderQuotaSnapshotRow,
  type SpendByModelRow,
  type SpendByProjectRow,
  type SpendOverTimeRow,
  type SummaryRow,
  type TimingPercentilesRow,
  type TokensByModelRow,
} from "@/common/orpc/schemas/analytics";

const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE_BIGINT = BigInt(Number.MIN_SAFE_INTEGER);

type Granularity = "hour" | "day" | "week";
type TimingMetric = "ttft" | "duration" | "tps";

const NON_TOOL_EVENTS_PREDICATE = "tool_name IS NULL";

interface TimingDistributionResult {
  percentiles: TimingPercentilesRow;
  histogram: HistogramBucket[];
}

interface DelegationSummaryResult {
  totals: DelegationSummaryTotalsRow;
  breakdown: DelegationAgentBreakdownRow[];
}

export interface DashboardQueryResult {
  summary: SummaryRow;
  spendOverTime: SpendOverTimeRow[];
  spendByProject: SpendByProjectRow[];
  spendByModel: SpendByModelRow[];
  tokensByModel: TokensByModelRow[];
  timingDistribution: TimingDistributionResult;
  agentCosts: AgentCostRow[];
  providerCacheHitModels: ProviderCacheHitModelRow[];
  delegationSummary: DelegationSummaryResult;
  codexQuotaRows: ProviderQuotaSnapshotRow[];
  refreshedAt: number;
}

function normalizeDuckDbValue(value: unknown): unknown {
  if (typeof value === "bigint") {
    assert(
      value <= MAX_SAFE_BIGINT && value >= MIN_SAFE_BIGINT,
      `DuckDB bigint out of JS safe integer range: ${value}`
    );
    return Number(value);
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  return value;
}

function normalizeDuckDbRow(row: Record<string, unknown>): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(row)) {
    normalized[key] = normalizeDuckDbValue(value);
  }

  return normalized;
}

async function typedQuery<T>(
  conn: DuckDBConnection,
  sql: string,
  params: DuckDBValue[],
  schema: z.ZodType<T>
): Promise<T[]> {
  const result = await conn.run(sql, params);
  const rows = await result.getRowObjectsJS();

  return rows.map((row) => schema.parse(normalizeDuckDbRow(row)));
}

async function typedQueryOne<T>(
  conn: DuckDBConnection,
  sql: string,
  params: DuckDBValue[],
  schema: z.ZodType<T>
): Promise<T> {
  const rows = await typedQuery(conn, sql, params, schema);
  assert(rows.length === 1, `Expected one row, got ${rows.length}`);
  return rows[0];
}

function parseOptionalString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseTimestampFilter(value: unknown): bigint | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (value instanceof Date) {
    assert(Number.isFinite(value.getTime()), "Invalid Date provided for analytics filter");
    return BigInt(value.getTime());
  }

  if (typeof value === "bigint") {
    return value;
  }

  if (typeof value === "number") {
    assert(Number.isSafeInteger(value), `Invalid timestamp filter value: ${value}`);
    return BigInt(value);
  }

  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = new Date(value);
    assert(Number.isFinite(parsed.getTime()), `Invalid date filter value: ${value}`);
    return BigInt(parsed.getTime());
  }

  throw new Error("Unsupported analytics timestamp filter type");
}

function parseTimezone(value: unknown): string {
  return typeof value === "string" && value.trim().length > 0 ? value : "UTC";
}

function parseGranularity(value: unknown): Granularity {
  assert(
    value === "hour" || value === "day" || value === "week",
    `Invalid granularity: ${String(value)}`
  );
  return value;
}

function parseTimingMetric(value: unknown): TimingMetric {
  assert(
    value === "ttft" || value === "duration" || value === "tps",
    `Invalid timing metric: ${String(value)}`
  );
  return value;
}

async function querySummary(
  conn: DuckDBConnection,
  params: {
    projectPath: string | null;
    from: bigint | null;
    to: bigint | null;
    todayStart: bigint;
    todayEnd: bigint;
  }
): Promise<SummaryRow> {
  return typedQueryOne(
    conn,
    `
    SELECT
      COALESCE(SUM(total_cost_usd), 0) AS total_spend_usd,
      COALESCE(SUM(CASE WHEN timestamp >= ? AND timestamp <= ? THEN total_cost_usd ELSE 0 END), 0) AS today_spend_usd,
      COALESCE(
        COALESCE(SUM(total_cost_usd), 0) / NULLIF(COUNT(DISTINCT date), 0),
        0
      ) AS avg_daily_spend_usd,
      COALESCE(
        SUM(cached_tokens)::DOUBLE / NULLIF(SUM(input_tokens + cached_tokens + cache_create_tokens), 0),
        0
      ) AS cache_hit_ratio,
      COALESCE(
        SUM(input_tokens + output_tokens + reasoning_tokens + cached_tokens + cache_create_tokens),
        0
      ) AS total_tokens,
      COALESCE(COUNT(*) FILTER (WHERE ${NON_TOOL_EVENTS_PREDICATE}), 0) AS total_responses
      ,COALESCE(
        SUM(input_tokens + output_tokens + reasoning_tokens + cached_tokens + cache_create_tokens)
          FILTER (WHERE cost_status = 'priced'),
        0
      ) AS priced_tokens
      ,COALESCE(
        SUM(input_tokens + output_tokens + reasoning_tokens + cached_tokens + cache_create_tokens)
          FILTER (WHERE cost_status = 'included'),
        0
      ) AS included_tokens
      ,COALESCE(
        SUM(input_tokens + output_tokens + reasoning_tokens + cached_tokens + cache_create_tokens)
          FILTER (WHERE cost_status = 'unknown'),
        0
      ) AS unknown_cost_tokens
      ,COALESCE(
        SUM(input_tokens + output_tokens + reasoning_tokens + cached_tokens + cache_create_tokens)
          FILTER (WHERE billing_route = 'codex-oauth'),
        0
      ) AS oauth_tokens
      ,COALESCE(COUNT(*) FILTER (WHERE billing_route = 'codex-oauth'), 0) AS oauth_requests
      ,MIN(timestamp) AS first_event_at
      ,MAX(timestamp) AS last_event_at
    FROM events
    WHERE (? IS NULL OR project_path = ?)
      AND (? IS NULL OR timestamp >= ?)
      AND (? IS NULL OR timestamp <= ?)
    `,
    [
      params.todayStart,
      params.todayEnd,
      params.projectPath,
      params.projectPath,
      params.from,
      params.from,
      params.to,
      params.to,
    ],
    SummaryRowSchema
  );
}

async function querySpendOverTime(
  conn: DuckDBConnection,
  params: {
    granularity: Granularity;
    projectPath: string | null;
    from: bigint | null;
    to: bigint | null;
    timezone: string;
  }
): Promise<SpendOverTimeRow[]> {
  const bucketExpression: Record<Granularity, string> = {
    hour: "DATE_TRUNC('hour', timezone(?, to_timestamp(timestamp / 1000.0)))",
    // Keep day/week buckets date-only after applying the local timezone. The
    // renderer intentionally treats date-only values differently from hourly
    // timestamps so daily labels do not acquire a misleading midnight time.
    day: "CAST(DATE_TRUNC('day', timezone(?, to_timestamp(timestamp / 1000.0))) AS DATE)",
    week: "CAST(DATE_TRUNC('week', timezone(?, to_timestamp(timestamp / 1000.0))) AS DATE)",
  };

  const bucketExpr = bucketExpression[params.granularity];

  return typedQuery(
    conn,
    `
    SELECT
      CAST(${bucketExpr} AS VARCHAR) AS bucket,
      COALESCE(model, 'unknown') AS model,
      COALESCE(SUM(total_cost_usd), 0) AS cost_usd
    FROM events
    WHERE
      (? IS NULL OR project_path = ?)
      AND (? IS NULL OR timestamp >= ?)
      AND (? IS NULL OR timestamp <= ?)
      AND timestamp IS NOT NULL
    GROUP BY 1, 2
    ORDER BY 1 ASC, 2 ASC
    `,
    [
      params.timezone,
      params.projectPath,
      params.projectPath,
      params.from,
      params.from,
      params.to,
      params.to,
    ],
    SpendOverTimeRowSchema
  );
}

async function querySpendByProject(
  conn: DuckDBConnection,
  params: { from: bigint | null; to: bigint | null }
): Promise<SpendByProjectRow[]> {
  return typedQuery(
    conn,
    `
    SELECT
      COALESCE(project_name, 'unknown') AS project_name,
      COALESCE(project_path, 'unknown') AS project_path,
      COALESCE(SUM(total_cost_usd), 0) AS cost_usd,
      COALESCE(
        SUM(input_tokens + output_tokens + reasoning_tokens + cached_tokens + cache_create_tokens),
        0
      ) AS token_count
    FROM events
    WHERE (? IS NULL OR timestamp >= ?)
      AND (? IS NULL OR timestamp <= ?)
    GROUP BY 1, 2
    ORDER BY cost_usd DESC
    `,
    [params.from, params.from, params.to, params.to],
    SpendByProjectRowSchema
  );
}

async function querySpendByModel(
  conn: DuckDBConnection,
  projectPath: string | null,
  from: bigint | null,
  to: bigint | null
): Promise<SpendByModelRow[]> {
  return typedQuery(
    conn,
    `
    SELECT
      COALESCE(model, 'unknown') AS model,
      COALESCE(SUM(total_cost_usd), 0) AS cost_usd,
      COALESCE(
        SUM(input_tokens + output_tokens + reasoning_tokens + cached_tokens + cache_create_tokens),
        0
      ) AS token_count,
      COALESCE(COUNT(*) FILTER (WHERE ${NON_TOOL_EVENTS_PREDICATE}), 0) AS response_count
    FROM events
    WHERE (? IS NULL OR project_path = ?)
      AND (? IS NULL OR timestamp >= ?)
      AND (? IS NULL OR timestamp <= ?)
    GROUP BY 1
    ORDER BY cost_usd DESC
    `,
    [projectPath, projectPath, from, from, to, to],
    SpendByModelRowSchema
  );
}

async function queryTokensByModel(
  conn: DuckDBConnection,
  projectPath: string | null,
  from: bigint | null,
  to: bigint | null
): Promise<TokensByModelRow[]> {
  return typedQuery(
    conn,
    `
    SELECT
      COALESCE(model, 'unknown') AS model,
      COALESCE(SUM(input_tokens), 0) AS input_tokens,
      COALESCE(SUM(cached_tokens), 0) AS cached_tokens,
      COALESCE(SUM(cache_create_tokens), 0) AS cache_create_tokens,
      COALESCE(SUM(output_tokens), 0) AS output_tokens,
      COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens,
      COALESCE(SUM(
        COALESCE(input_tokens, 0) + COALESCE(cached_tokens, 0) + COALESCE(cache_create_tokens, 0)
        + COALESCE(output_tokens, 0) + COALESCE(reasoning_tokens, 0)
      ), 0) AS total_tokens,
      COALESCE(COUNT(*) FILTER (WHERE ${NON_TOOL_EVENTS_PREDICATE}), 0) AS request_count
    FROM events
    WHERE (? IS NULL OR project_path = ?)
      AND (? IS NULL OR timestamp >= ?)
      AND (? IS NULL OR timestamp <= ?)
    GROUP BY 1
    ORDER BY total_tokens DESC
    LIMIT 10
    `,
    [projectPath, projectPath, from, from, to, to],
    TokensByModelRowSchema
  );
}

async function queryTimingDistribution(
  conn: DuckDBConnection,
  metric: TimingMetric,
  projectPath: string | null,
  from: bigint | null,
  to: bigint | null
): Promise<TimingDistributionResult> {
  const columnByMetric: Record<TimingMetric, string> = {
    ttft: "ttft_ms",
    duration: "duration_ms",
    tps: "output_tps",
  };

  const column = columnByMetric[metric];

  const percentiles = await typedQueryOne(
    conn,
    `
    SELECT
      COALESCE(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY ${column}), 0) AS p50,
      COALESCE(PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY ${column}), 0) AS p90,
      COALESCE(PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY ${column}), 0) AS p99
    FROM events
    WHERE ${column} IS NOT NULL
      AND ${NON_TOOL_EVENTS_PREDICATE}
      AND (? IS NULL OR project_path = ?)
      AND (? IS NULL OR timestamp >= ?)
      AND (? IS NULL OR timestamp <= ?)
    `,
    [projectPath, projectPath, from, from, to, to],
    TimingPercentilesRowSchema
  );

  // Histogram emits real metric values (e.g. ms, tok/s) as bucket labels,
  // not abstract 1..20 indices. This way the chart x-axis maps directly to
  // meaningful units and percentile reference lines land correctly.
  //
  // Cap the histogram range at p99 so a single extreme outlier does not flatten
  // the distribution for the other 99% of responses. If p99 collapses to min
  // (for near-constant datasets), fall back to raw max to preserve bucket spread.
  const histogram = await typedQuery(
    conn,
    `
    WITH raw_stats AS (
      SELECT
        MIN(${column}) AS min_value,
        PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY ${column}) AS p99_value,
        MAX(${column}) AS raw_max_value
      FROM events
      WHERE ${column} IS NOT NULL
        AND ${NON_TOOL_EVENTS_PREDICATE}
        AND (? IS NULL OR project_path = ?)
        AND (? IS NULL OR timestamp >= ?)
        AND (? IS NULL OR timestamp <= ?)
    ),
    stats AS (
      SELECT
        min_value,
        CASE
          -- If p99 collapses to the minimum (e.g. >99% identical values),
          -- fall back to the raw max so outliers do not get forced into bucket 1.
          WHEN p99_value = min_value AND raw_max_value > p99_value THEN raw_max_value
          ELSE p99_value
        END AS max_value
      FROM raw_stats
    ),
    bucketed AS (
      SELECT
        CASE
          WHEN stats.min_value IS NULL OR stats.max_value IS NULL THEN NULL
          WHEN stats.max_value = stats.min_value THEN 1
          ELSE LEAST(
            20,
            GREATEST(
              1,
              CAST(
                FLOOR(
                  ((events.${column} - stats.min_value) / NULLIF(stats.max_value - stats.min_value, 0)) * 20
                ) AS INTEGER
              ) + 1
            )
          )
        END AS bucket_id
      FROM events
      CROSS JOIN stats
      WHERE events.${column} IS NOT NULL
        AND ${NON_TOOL_EVENTS_PREDICATE}
        AND (? IS NULL OR events.project_path = ?)
        AND (? IS NULL OR events.timestamp >= ?)
        AND (? IS NULL OR events.timestamp <= ?)
    )
    SELECT
      COALESCE(
        ROUND(
          (SELECT min_value FROM stats) +
          (bucket_id - 0.5) * (
            NULLIF((SELECT max_value FROM stats) - (SELECT min_value FROM stats), 0) / 20.0
          ),
          2
        ),
        -- When min == max (single distinct value), NULLIF produces NULL.
        -- Fall back to the actual value so the bucket label is meaningful.
        ROUND((SELECT min_value FROM stats), 2)
      ) AS bucket,
      COUNT(*) AS count
    FROM bucketed
    WHERE bucket_id IS NOT NULL
    GROUP BY bucket_id
    ORDER BY bucket_id
    `,
    [projectPath, projectPath, from, from, to, to, projectPath, projectPath, from, from, to, to],
    HistogramBucketSchema
  );

  return {
    percentiles,
    histogram,
  };
}

async function queryAgentCostBreakdown(
  conn: DuckDBConnection,
  projectPath: string | null,
  from: bigint | null,
  to: bigint | null
): Promise<AgentCostRow[]> {
  return typedQuery(
    conn,
    `
    SELECT
      COALESCE(agent_id, 'unknown') AS agent_id,
      COALESCE(SUM(total_cost_usd), 0) AS cost_usd,
      COALESCE(
        SUM(input_tokens + output_tokens + reasoning_tokens + cached_tokens + cache_create_tokens),
        0
      ) AS token_count,
      COALESCE(COUNT(*) FILTER (WHERE ${NON_TOOL_EVENTS_PREDICATE}), 0) AS response_count
    FROM events
    WHERE (? IS NULL OR project_path = ?)
      AND (? IS NULL OR timestamp >= ?)
      AND (? IS NULL OR timestamp <= ?)
    GROUP BY 1
    ORDER BY cost_usd DESC
    `,
    [projectPath, projectPath, from, from, to, to],
    AgentCostRowSchema
  );
}

async function queryCacheHitRatioByProvider(
  conn: DuckDBConnection,
  projectPath: string | null,
  from: bigint | null,
  to: bigint | null
): Promise<ProviderCacheHitModelRow[]> {
  return typedQuery(
    conn,
    `
    SELECT
      COALESCE(model, 'unknown') AS model,
      COALESCE(SUM(cached_tokens), 0) AS cached_tokens,
      COALESCE(SUM(input_tokens + cached_tokens + cache_create_tokens), 0) AS total_prompt_tokens,
      COALESCE(COUNT(*) FILTER (WHERE ${NON_TOOL_EVENTS_PREDICATE}), 0) AS response_count
    FROM events
    WHERE (? IS NULL OR project_path = ?)
      AND (? IS NULL OR timestamp >= ?)
      AND (? IS NULL OR timestamp <= ?)
    GROUP BY 1
    ORDER BY response_count DESC
    `,
    [projectPath, projectPath, from, from, to, to],
    ProviderCacheHitModelRowSchema
  );
}

async function queryDelegationSummary(
  conn: DuckDBConnection,
  params: { projectPath: string | null; from: bigint | null; to: bigint | null }
): Promise<DelegationSummaryResult> {
  const filterParams: DuckDBValue[] = [
    params.projectPath,
    params.projectPath,
    params.from,
    params.from,
    params.to,
    params.to,
  ];

  const whereClause = `
    WHERE (? IS NULL OR project_path = ?)
      AND (? IS NULL OR rolled_up_at_ms >= ?)
      AND (? IS NULL OR rolled_up_at_ms <= ?)
  `;

  const totals = await typedQueryOne(
    conn,
    `
    SELECT
      COALESCE(COUNT(*), 0) AS total_children,
      COALESCE(SUM(total_tokens), 0) AS total_tokens_consumed,
      COALESCE(SUM(report_token_estimate), 0) AS total_report_tokens,
      COALESCE(
        CASE
          WHEN SUM(CASE WHEN report_token_estimate > 0 THEN report_token_estimate ELSE 0 END) = 0 THEN 0
          ELSE SUM(CASE WHEN report_token_estimate > 0 THEN total_tokens ELSE 0 END)::DOUBLE
               / SUM(CASE WHEN report_token_estimate > 0 THEN report_token_estimate ELSE 0 END)
        END,
        0
      ) AS compression_ratio,
      COALESCE(SUM(total_cost_usd), 0) AS total_cost_delegated
    FROM delegation_rollups
    ${whereClause}
    `,
    [...filterParams],
    DelegationSummaryTotalsRowSchema
  );

  const breakdown = await typedQuery(
    conn,
    `
    SELECT
      COALESCE(agent_type, 'unknown') AS agent_type,
      COALESCE(COUNT(*), 0) AS delegation_count,
      COALESCE(SUM(total_tokens), 0) AS total_tokens,
      COALESCE(SUM(input_tokens), 0) AS input_tokens,
      COALESCE(SUM(output_tokens), 0) AS output_tokens,
      COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens,
      COALESCE(SUM(cached_tokens), 0) AS cached_tokens,
      COALESCE(SUM(cache_create_tokens), 0) AS cache_create_tokens
    FROM delegation_rollups
    ${whereClause}
    GROUP BY agent_type
    ORDER BY total_tokens DESC
    `,
    [...filterParams],
    DelegationAgentBreakdownRowSchema
  );

  return { totals, breakdown };
}

async function queryLatestProviderQuota(
  conn: DuckDBConnection,
  provider: string,
  accountKey: string | null
): Promise<ProviderQuotaSnapshotRow[]> {
  if (accountKey == null) {
    return [];
  }

  return typedQuery(
    conn,
    `
    SELECT provider, account_key, window_kind,
           COALESCE(last_observed_at, observed_at) AS observed_at,
           used_percent, remaining_percent, reset_at, source
    FROM provider_quota_snapshots
    WHERE provider = ? AND account_key = ?
    QUALIFY ROW_NUMBER() OVER (PARTITION BY window_kind ORDER BY observed_at DESC) = 1
    ORDER BY window_kind
    `,
    [provider, accountKey],
    ProviderQuotaSnapshotRowSchema
  );
}

async function queryDashboard(
  conn: DuckDBConnection,
  params: Record<string, unknown>
): Promise<DashboardQueryResult> {
  const projectPath = parseOptionalString(params.projectPath);
  const from = parseTimestampFilter(params.from);
  const to = parseTimestampFilter(params.to);
  const granularity = parseGranularity(params.granularity);
  const timingMetric = parseTimingMetric(params.timingMetric);
  const accountKey = parseOptionalString(params.codexAccountKey);
  const timezone = parseTimezone(params.timezone);
  const now = new Date();
  const localDayStart = new Date(now);
  localDayStart.setHours(0, 0, 0, 0);
  const todayStart = parseTimestampFilter(params.todayStart) ?? BigInt(localDayStart.getTime());
  const todayEnd = parseTimestampFilter(params.todayEnd) ?? BigInt(now.getTime());

  // One worker task keeps the renderer→backend boundary bulk-oriented while
  // preserving the existing query implementations and validation.
  const summary = await querySummary(conn, { projectPath, from, to, todayStart, todayEnd });
  const spendOverTime = await querySpendOverTime(conn, {
    granularity,
    projectPath,
    from,
    to,
    timezone,
  });
  const spendByProject = await querySpendByProject(conn, { from, to });
  const spendByModel = await querySpendByModel(conn, projectPath, from, to);
  const tokensByModel = await queryTokensByModel(conn, projectPath, from, to);
  const timingDistribution = await queryTimingDistribution(
    conn,
    timingMetric,
    projectPath,
    from,
    to
  );
  const agentCosts = await queryAgentCostBreakdown(conn, projectPath, from, to);
  const providerCacheHitModels = await queryCacheHitRatioByProvider(conn, projectPath, from, to);
  const delegationSummary = await queryDelegationSummary(conn, {
    projectPath,
    from,
    to,
  });
  const codexQuotaRows = await queryLatestProviderQuota(conn, "openai-codex", accountKey);

  return {
    summary,
    spendOverTime,
    spendByProject,
    spendByModel,
    tokensByModel,
    timingDistribution,
    agentCosts,
    providerCacheHitModels,
    delegationSummary,
    codexQuotaRows,
    refreshedAt: Date.now(),
  };
}

export async function executeNamedQuery(
  conn: DuckDBConnection,
  queryName: string,
  params: Record<string, unknown>
): Promise<unknown> {
  switch (queryName) {
    case "getDashboard":
      return queryDashboard(conn, params);

    case "getSummary": {
      const now = new Date();
      const localDayStart = new Date(now);
      localDayStart.setHours(0, 0, 0, 0);
      return querySummary(conn, {
        projectPath: parseOptionalString(params.projectPath),
        from: parseTimestampFilter(params.from),
        to: parseTimestampFilter(params.to),
        todayStart: parseTimestampFilter(params.todayStart) ?? BigInt(localDayStart.getTime()),
        todayEnd: parseTimestampFilter(params.todayEnd) ?? BigInt(now.getTime()),
      });
    }

    case "getSpendOverTime": {
      return querySpendOverTime(conn, {
        granularity: parseGranularity(params.granularity),
        projectPath: parseOptionalString(params.projectPath),
        from: parseTimestampFilter(params.from),
        to: parseTimestampFilter(params.to),
        timezone: parseTimezone(params.timezone),
      });
    }

    case "getSpendByProject": {
      return querySpendByProject(conn, {
        from: parseTimestampFilter(params.from),
        to: parseTimestampFilter(params.to),
      });
    }

    case "getSpendByModel": {
      return querySpendByModel(
        conn,
        parseOptionalString(params.projectPath),
        parseTimestampFilter(params.from),
        parseTimestampFilter(params.to)
      );
    }

    case "getTokensByModel": {
      return queryTokensByModel(
        conn,
        parseOptionalString(params.projectPath),
        parseTimestampFilter(params.from),
        parseTimestampFilter(params.to)
      );
    }

    case "getTimingDistribution": {
      return queryTimingDistribution(
        conn,
        parseTimingMetric(params.metric),
        parseOptionalString(params.projectPath),
        parseTimestampFilter(params.from),
        parseTimestampFilter(params.to)
      );
    }

    case "getAgentCostBreakdown": {
      return queryAgentCostBreakdown(
        conn,
        parseOptionalString(params.projectPath),
        parseTimestampFilter(params.from),
        parseTimestampFilter(params.to)
      );
    }

    case "getCacheHitRatioByProvider": {
      return queryCacheHitRatioByProvider(
        conn,
        parseOptionalString(params.projectPath),
        parseTimestampFilter(params.from),
        parseTimestampFilter(params.to)
      );
    }

    case "getDelegationSummary": {
      return queryDelegationSummary(conn, {
        projectPath: parseOptionalString(params.projectPath),
        from: parseTimestampFilter(params.from),
        to: parseTimestampFilter(params.to),
      });
    }

    default:
      throw new Error(`Unknown analytics query: ${queryName}`);
  }
}

export const RAW_QUERY_ROW_LIMIT = 10_000;

export interface RawQueryColumn {
  name: string;
  type: string;
}

export interface RawQueryResult {
  columns: RawQueryColumn[];
  rows: Array<Record<string, unknown>>;
  truncated: boolean;
  // When rowCountExact is false, this is a lower bound ("at least this many rows").
  rowCount: number;
  rowCountExact: boolean;
  durationMs: number;
}

const RAW_QUERY_DISALLOWED_PATTERNS: RegExp[] = [
  /"?\bread_csv\b"?\s*\(/i,
  /"?\bread_csv_auto\b"?\s*\(/i,
  /"?\bread_parquet\b"?\s*\(/i,
  /"?\bread_json\b"?\s*\(/i,
  /"?\bread_json_auto\b"?\s*\(/i,
  /"?\bread_ndjson\b"?\s*\(/i,
  /"?\bread_ndjson_auto\b"?\s*\(/i,
  /"?\bread_blob\b"?\s*\(/i,
  /"?\bread_text\b"?\s*\(/i,
  /"?\bhttp_get\b"?\s*\(/i,
  /"?\bhttp_post\b"?\s*\(/i,
  /"?\bglob\b"?\s*\(/i,
  /"?\blist_files\b"?\s*\(/i,
  /"?\bduckdb_tables\b"?\s*\(/i,
  /"?\bduckdb_columns\b"?\s*\(/i,
  /"?\bduckdb_views\b"?\s*\(/i,
  /"?\bduckdb_indexes\b"?\s*\(/i,
  /"?\bduckdb_constraints\b"?\s*\(/i,
  /"?\bduckdb_dependencies\b"?\s*\(/i,
  /"?\bduckdb_functions\b"?\s*\(/i,
  /"?\bduckdb_keywords\b"?\s*\(/i,
  /"?\bduckdb_types\b"?\s*\(/i,
  /"?\bduckdb_settings\b"?\s*\(/i,
  /"?\bduckdb_databases\b"?\s*\(/i,
  /"?\bduckdb_schemas\b"?\s*\(/i,
  /"?\bduckdb_sequences\b"?\s*\(/i,
  /"?\bduckdb_extensions\b"?\s*\(/i,
  /(?:"?\binformation_schema\b"?)\s*\./i,
  /(?:"?\bpg_catalog\b"?)\s*\./i,
  /"?\bgenerate_series\b"?\s*\(/i,
  /"?\b[a-zA-Z_][a-zA-Z0-9_]*_scan\b"?\s*\(/i,
  /(^|[;(])\s*copy\b/i,
  /(^|[;(])\s*export\b/i,
  /(^|[;(])\s*import\b/i,
  /(^|[;(])\s*attach\b/i,
  /(^|[;(])\s*detach\b/i,
  /(^|[;(])\s*install\b/i,
  /(^|[;(])\s*load\b/i,
  /(^|[;(])\s*pragma\b/i,
  /(^|[;(])\s*set\b/i,
];

const RAW_QUERY_REPLACEMENT_SCAN_DIRECT_PATTERN = /\b(?:FROM|JOIN)\s+'/i;
const RAW_QUERY_REPLACEMENT_SCAN_CLAUSE_TERMINATORS = new Set([
  "WHERE",
  "GROUP",
  "HAVING",
  "ORDER",
  "LIMIT",
  "QUALIFY",
  "WINDOW",
  "UNION",
  "EXCEPT",
  "INTERSECT",
]);

function isRawQueryIdentifierCharacter(character: string | undefined): boolean {
  return character !== undefined && /[a-zA-Z0-9_$]/.test(character);
}

function isRawQueryKeywordStartCharacter(character: string | undefined): boolean {
  return character !== undefined && /[a-zA-Z_]/.test(character);
}

function parseRawQueryKeyword(
  sql: string,
  startIndex: number
): { keyword: string; endIndex: number } | null {
  if (isRawQueryIdentifierCharacter(sql[startIndex - 1])) {
    return null;
  }

  const firstCharacter = sql[startIndex];
  if (!isRawQueryKeywordStartCharacter(firstCharacter)) {
    return null;
  }

  let endIndex = startIndex + 1;
  while (isRawQueryIdentifierCharacter(sql[endIndex])) {
    endIndex += 1;
  }

  return {
    keyword: sql.slice(startIndex, endIndex).toUpperCase(),
    endIndex,
  };
}

function findNextRawQueryNonWhitespaceIndex(sql: string, startIndex: number): number {
  let index = startIndex;
  while (index < sql.length && /\s/.test(sql[index])) {
    index += 1;
  }

  return index;
}

function skipRawQuerySingleQuotedLiteral(sql: string, startIndex: number): number {
  assert(sql[startIndex] === "'", "Expected to skip a single-quoted SQL literal");

  let index = startIndex + 1;
  while (index < sql.length) {
    if (sql[index] === "'" && sql[index + 1] === "'") {
      index += 2;
      continue;
    }

    if (sql[index] === "'") {
      return index + 1;
    }

    index += 1;
  }

  return index;
}

function hasRawQueryReplacementScanInFromClause(
  sql: string,
  fromClauseStartIndex: number,
  fromClauseDepth: number
): boolean {
  let depth = fromClauseDepth;
  let index = findNextRawQueryNonWhitespaceIndex(sql, fromClauseStartIndex);

  if (sql[index] === "'") {
    return true;
  }

  while (index < sql.length) {
    const character = sql[index];

    if (character === "'") {
      index = skipRawQuerySingleQuotedLiteral(sql, index);
      continue;
    }

    if (character === "(") {
      depth += 1;
      index += 1;
      continue;
    }

    if (character === ")") {
      if (depth === fromClauseDepth) {
        return false;
      }
      depth -= 1;
      index += 1;
      continue;
    }

    if (depth === fromClauseDepth) {
      if (character === ";") {
        return false;
      }

      if (character === ",") {
        const sourceStartIndex = findNextRawQueryNonWhitespaceIndex(sql, index + 1);
        if (sql[sourceStartIndex] === "'") {
          return true;
        }
      }

      const keywordMatch = parseRawQueryKeyword(sql, index);
      if (keywordMatch !== null) {
        if (keywordMatch.keyword === "JOIN") {
          const sourceStartIndex = findNextRawQueryNonWhitespaceIndex(sql, keywordMatch.endIndex);
          if (sql[sourceStartIndex] === "'") {
            return true;
          }
        }

        if (RAW_QUERY_REPLACEMENT_SCAN_CLAUSE_TERMINATORS.has(keywordMatch.keyword)) {
          return false;
        }

        index = keywordMatch.endIndex;
        continue;
      }
    }

    index += 1;
  }

  return false;
}

function hasRawQueryReplacementScan(sql: string): boolean {
  if (RAW_QUERY_REPLACEMENT_SCAN_DIRECT_PATTERN.test(sql)) {
    return true;
  }

  let depth = 0;
  let index = 0;

  while (index < sql.length) {
    const character = sql[index];

    if (character === "'") {
      index = skipRawQuerySingleQuotedLiteral(sql, index);
      continue;
    }

    if (character === "(") {
      depth += 1;
      index += 1;
      continue;
    }

    if (character === ")") {
      depth = Math.max(0, depth - 1);
      index += 1;
      continue;
    }

    const keywordMatch = parseRawQueryKeyword(sql, index);
    if (keywordMatch?.keyword === "FROM") {
      if (hasRawQueryReplacementScanInFromClause(sql, keywordMatch.endIndex, depth)) {
        return true;
      }
      index = keywordMatch.endIndex;
      continue;
    }

    index += 1;
  }

  return false;
}

function maskRawQueryLiteralsAndComments(
  sql: string,
  options: { maskStrings: boolean } = { maskStrings: true }
): string {
  const characters = Array.from(sql);
  let index = 0;
  const shouldMaskStrings = options.maskStrings;

  while (index < characters.length) {
    const char = characters[index];
    const nextChar = characters[index + 1];

    if (char === "'") {
      if (shouldMaskStrings) {
        characters[index] = " ";
      }
      index += 1;
      while (index < characters.length) {
        const current = characters[index];
        const following = characters[index + 1];
        if (shouldMaskStrings) {
          characters[index] = " ";
        }
        if (current === "'" && following === "'") {
          if (shouldMaskStrings) {
            characters[index + 1] = " ";
          }
          index += 2;
          continue;
        }

        index += 1;
        if (current === "'") {
          break;
        }
      }
      continue;
    }

    if (char === "-" && nextChar === "-") {
      characters[index] = " ";
      characters[index + 1] = " ";
      index += 2;
      while (index < characters.length && characters[index] !== "\n") {
        characters[index] = " ";
        index += 1;
      }
      continue;
    }

    if (char === "/" && nextChar === "*") {
      characters[index] = " ";
      characters[index + 1] = " ";
      index += 2;
      while (index < characters.length) {
        if (characters[index] === "*" && characters[index + 1] === "/") {
          characters[index] = " ";
          characters[index + 1] = " ";
          index += 2;
          break;
        }

        characters[index] = " ";
        index += 1;
      }
      continue;
    }

    index += 1;
  }

  return characters.join("");
}

/**
 * Security model for raw analytics SQL validation:
 * 1) mask comments while preserving string literals,
 * 2) block DuckDB replacement scans that use string literals as table sources,
 * 3) mask string literals/comments before regex matching,
 * 4) block dangerous functions/statements via RAW_QUERY_DISALLOWED_PATTERNS,
 * 5) rely on executeRawQuery subquery wrapping plus read-only DuckDB connections.
 */
function validateRawQuerySql(cleanSql: string): void {
  const commentMaskedSql = maskRawQueryLiteralsAndComments(cleanSql, {
    maskStrings: false,
  });

  // Keep quote delimiters while masking literal contents so replacement-scan detection
  // catches FROM/JOIN and comma-separated FROM sources without false positives from
  // keywords embedded inside literal text.
  const replacementScanMaskedSql = commentMaskedSql.replace(/'(?:[^']|'')*'/g, (literal) => {
    assert(literal.length >= 2, "Single-quoted SQL literal must include delimiters");
    return `'${" ".repeat(literal.length - 2)}'`;
  });

  if (hasRawQueryReplacementScan(replacementScanMaskedSql)) {
    throw new Error(
      "String literals cannot be used as table sources (DuckDB replacement scans are not allowed)"
    );
  }

  const fullyMaskedSql = maskRawQueryLiteralsAndComments(commentMaskedSql);

  for (const pattern of RAW_QUERY_DISALLOWED_PATTERNS) {
    if (pattern.test(fullyMaskedSql)) {
      throw new Error(`Query contains disallowed SQL: ${pattern.source.replace(/\b/g, "")}`);
    }
  }
}

/**
 * Execute arbitrary user SQL as a read-only subquery with a hard row cap.
 * Wrapping the statement in a subquery prevents DML/DDL execution,
 * validateRawQuerySql blocks dangerous functions/statements, and
 * the DuckDB connection remains read-only.
 */
export async function executeRawQuery(
  conn: DuckDBConnection,
  sql: string
): Promise<RawQueryResult> {
  assert(
    typeof sql === "string" && sql.trim().length > 0,
    "executeRawQuery requires non-empty SQL"
  );

  const cleanSql = sql.trim().replace(/;+$/, "").trim();
  assert(cleanSql.length > 0, "executeRawQuery requires SQL with at least one statement");

  validateRawQuerySql(cleanSql);

  const fetchLimit = RAW_QUERY_ROW_LIMIT + 1;
  const wrappedSql = `SELECT * FROM (\n${cleanSql}\n) AS __q LIMIT ${fetchLimit}`;

  const startMs = performance.now();
  const result = await conn.run(wrappedSql);
  const rawRows = await result.getRowObjectsJS();
  const durationMs = Math.round(performance.now() - startMs);

  const columns: RawQueryColumn[] = [];
  for (let index = 0; index < result.columnCount; index += 1) {
    columns.push({
      name: result.columnName(index),
      type: String(result.columnType(index)),
    });
  }

  const rowCount = rawRows.length;
  const truncated = rowCount > RAW_QUERY_ROW_LIMIT;
  const rows = truncated ? rawRows.slice(0, RAW_QUERY_ROW_LIMIT) : rawRows;
  const rowCountExact = !truncated;

  assert(
    rowCount <= fetchLimit,
    `Raw query row count (${rowCount}) exceeded fetch limit (${fetchLimit})`
  );

  return {
    columns,
    rows: rows.map(normalizeDuckDbRow),
    truncated,
    rowCount,
    rowCountExact,
    durationMs,
  };
}
