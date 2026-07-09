import { existsSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

export interface KiroOauthCredentials {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  profileArn?: string;
  region?: string;
  ssoRegion?: string;
  clientId?: string;
  clientSecret?: string;
}

type KiroProviderConfig = Record<string, unknown> & {
  accessToken?: unknown;
  access_token?: unknown;
  refreshToken?: unknown;
  refresh_token?: unknown;
  expiresAt?: unknown;
  expires_at?: unknown;
  profileArn?: unknown;
  profile_arn?: unknown;
  region?: unknown;
  ssoRegion?: unknown;
  sso_region?: unknown;
  apiRegion?: unknown;
  api_region?: unknown;
  clientId?: unknown;
  client_id?: unknown;
  clientSecret?: unknown;
  client_secret?: unknown;
  oauthCredentialsPath?: unknown;
  oauthSqlitePath?: unknown;
};

const DEFAULT_REGION = "us-east-1";
const TOKEN_REFRESH_THRESHOLD_MS = 10 * 60 * 1000;
const KIRO_DESKTOP_REFRESH_URL_TEMPLATE =
  "https://prod.{region}.auth.desktop.kiro.dev/refreshToken";
const AWS_SSO_OIDC_REFRESH_URL_TEMPLATE = "https://oidc.{region}.amazonaws.com/token";
const JSON_CREDENTIAL_CANDIDATES = ["~/.aws/sso/cache/kiro-auth-token.json"] as const;
const SQLITE_CREDENTIAL_CANDIDATES = [
  "~/Library/Application Support/kiro-cli/data.sqlite3",
  "~/.local/share/kiro-cli/data.sqlite3",
  "~/.local/share/amazon-q/data.sqlite3",
] as const;

const SQLITE_TOKEN_KEYS = [
  "kirocli:social:token",
  "kirocli:odic:token",
  "codewhisperer:odic:token",
] as const;

const SQLITE_REGISTRATION_KEYS = [
  "kirocli:odic:device-registration",
  "codewhisperer:odic:device-registration",
] as const;

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const parsed = nonEmptyString(value);
    if (parsed) {
      return parsed;
    }
  }
  return undefined;
}

function expandHome(filePath: string, homeDir = os.homedir()): string {
  if (filePath === "~") {
    return homeDir;
  }
  return filePath.startsWith("~/") ? path.join(homeDir, filePath.slice(2)) : filePath;
}

function readableFileExists(filePath: string, homeDir?: string): boolean {
  try {
    const stat = statSync(expandHome(filePath, homeDir));
    return stat.isFile();
  } catch {
    return false;
  }
}

function parseExpiresAt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  const raw = nonEmptyString(value);
  if (!raw) {
    return undefined;
  }

  // kiro-cli can persist nanosecond RFC3339 values. JavaScript Date accepts milliseconds.
  const normalized = raw.replace(/(\.\d{3})\d+(Z|[+-]\d\d:\d\d)?$/, "$1$2");
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseCredentialRecord(record: Record<string, unknown>): KiroOauthCredentials | null {
  const accessToken = firstString(record.accessToken, record.access_token);
  const refreshToken = firstString(record.refreshToken, record.refresh_token);
  if (!accessToken && !refreshToken) {
    return null;
  }

  return {
    accessToken,
    refreshToken,
    expiresAt: parseExpiresAt(record.expiresAt ?? record.expires_at),
    profileArn: firstString(record.profileArn, record.profile_arn),
    region:
      firstString(record.apiRegion, record.api_region, record.region) ??
      firstString(record.ssoRegion, record.sso_region) ??
      DEFAULT_REGION,
    ssoRegion: firstString(record.ssoRegion, record.sso_region, record.region),
    clientId: firstString(record.clientId, record.client_id),
    clientSecret: firstString(record.clientSecret, record.client_secret),
  };
}

function canRefreshWithAwsSsoOidc(credentials: KiroOauthCredentials): boolean {
  return Boolean(credentials.clientId && credentials.clientSecret);
}

function readJsonFile(filePath: string, homeDir?: string): Record<string, unknown> | null {
  try {
    const expanded = expandHome(filePath, homeDir);
    if (!existsSync(expanded) || !statSync(expanded).isFile()) {
      return null;
    }
    const parsed = JSON.parse(readFileSync(expanded, "utf-8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function loadJsonCredentials(filePath: string, homeDir?: string): KiroOauthCredentials | null {
  const record = readJsonFile(filePath, homeDir);
  const credentials = record ? parseCredentialRecord(record) : null;
  if (!record || !credentials || canRefreshWithAwsSsoOidc(credentials)) {
    return credentials;
  }

  const clientIdHash = firstString(record.clientIdHash, record.client_id_hash);
  if (!clientIdHash) {
    return credentials;
  }

  const registration = readJsonFile(
    path.join(path.dirname(expandHome(filePath, homeDir)), `${clientIdHash}.json`)
  );
  if (!registration) {
    return credentials;
  }

  credentials.clientId ??= firstString(registration.clientId, registration.client_id);
  credentials.clientSecret ??= firstString(registration.clientSecret, registration.client_secret);
  credentials.ssoRegion =
    firstString(registration.ssoRegion, registration.sso_region, registration.region) ??
    credentials.ssoRegion;
  // AWS SSO cache `region` is the login/OIDC region, not necessarily a Kiro runtime region.
  credentials.region = firstString(record.apiRegion, record.api_region) ?? DEFAULT_REGION;
  return credentials;
}

function readSqliteJsonRows(
  dbPath: string,
  table: "auth_kv" | "state",
  keys: readonly string[],
  homeDir?: string
): Record<string, Record<string, unknown>> {
  const expanded = expandHome(dbPath, homeDir);
  if (!readableFileExists(expanded)) {
    return {};
  }

  const quotedKeys = keys.map((key) => `'${key.replaceAll("'", "''")}'`).join(",");
  const sql = `SELECT json_object('key', key, 'value', value) FROM ${table} WHERE key IN (${quotedKeys});`;

  try {
    const output = execFileSync("sqlite3", ["-readonly", "-batch", expanded, sql], {
      encoding: "utf-8",
      timeout: 2_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const rows: Record<string, Record<string, unknown>> = {};
    for (const line of output.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      const row = JSON.parse(trimmed) as { key?: unknown; value?: unknown };
      const key = nonEmptyString(row.key);
      if (!key || typeof row.value !== "string") {
        continue;
      }
      const value = JSON.parse(row.value) as unknown;
      if (value && typeof value === "object" && !Array.isArray(value)) {
        rows[key] = value as Record<string, unknown>;
      }
    }
    return rows;
  } catch {
    return {};
  }
}

function loadSqliteCredentials(dbPath: string, homeDir?: string): KiroOauthCredentials | null {
  const tokenRows = readSqliteJsonRows(dbPath, "auth_kv", SQLITE_TOKEN_KEYS, homeDir);
  const tokenRecord = SQLITE_TOKEN_KEYS.map((key) => tokenRows[key]).find(Boolean);
  if (!tokenRecord) {
    return null;
  }

  const credentials = parseCredentialRecord(tokenRecord);
  if (!credentials) {
    return null;
  }
  const registrationRows = readSqliteJsonRows(dbPath, "auth_kv", SQLITE_REGISTRATION_KEYS, homeDir);
  const registration = SQLITE_REGISTRATION_KEYS.map((key) => registrationRows[key]).find(Boolean);
  if (registration) {
    credentials.clientId ??= firstString(registration.clientId, registration.client_id);
    credentials.clientSecret ??= firstString(registration.clientSecret, registration.client_secret);
    // Device registration owns the IAM Identity Center OIDC region; the token row's
    // region can be the CodeWhisperer runtime/profile region.
    credentials.ssoRegion = firstString(registration.region) ?? credentials.ssoRegion;
    credentials.region ??= credentials.ssoRegion;
  }

  const stateRows = readSqliteJsonRows(dbPath, "state", ["api.codewhisperer.profile"], homeDir);
  const profile = stateRows["api.codewhisperer.profile"];
  const arn = firstString(profile?.arn);
  if (arn) {
    credentials.profileArn ??= arn;
    credentials.region = arn.split(":")[3] || credentials.region;
  }

  credentials.region ??= DEFAULT_REGION;
  credentials.ssoRegion ??= credentials.region;
  return credentials;
}

function explicitJsonPath(config: KiroProviderConfig, env: Record<string, string | undefined>) {
  return firstString(config.oauthCredentialsPath, env.KIRO_CREDS_FILE);
}

function explicitSqlitePath(config: KiroProviderConfig, env: Record<string, string | undefined>) {
  return firstString(config.oauthSqlitePath, env.KIRO_CLI_DB_FILE);
}

export function getKiroOauthCredentialPaths(
  config: KiroProviderConfig,
  env: Record<string, string | undefined> = process.env
): { jsonPaths: string[]; sqlitePaths: string[] } {
  return {
    jsonPaths: [explicitJsonPath(config, env), ...JSON_CREDENTIAL_CANDIDATES].flatMap((value) =>
      value ? [value] : []
    ),
    sqlitePaths: [explicitSqlitePath(config, env), ...SQLITE_CREDENTIAL_CANDIDATES].flatMap(
      (value) => (value ? [value] : [])
    ),
  };
}

export function loadKiroOauthCredentials(
  config: KiroProviderConfig,
  options?: {
    env?: Record<string, string | undefined>;
    homeDir?: string;
  }
): KiroOauthCredentials | null {
  const env = options?.env ?? process.env;
  const inline = parseCredentialRecord({
    ...config,
    accessToken: config.accessToken ?? env.KIRO_ACCESS_TOKEN,
    refreshToken: config.refreshToken ?? env.KIRO_REFRESH_TOKEN,
    profileArn: config.profileArn ?? env.KIRO_PROFILE_ARN,
    region: config.region ?? env.KIRO_API_REGION ?? env.KIRO_REGION,
    ssoRegion: config.ssoRegion ?? env.KIRO_REGION,
  });
  if (inline) {
    return inline;
  }

  const explicitJson = explicitJsonPath(config, env);
  if (explicitJson) {
    return loadJsonCredentials(explicitJson, options?.homeDir);
  }

  const { jsonPaths, sqlitePaths } = getKiroOauthCredentialPaths(config, env);
  const fallbackJsonCredentials: KiroOauthCredentials[] = [];
  for (const jsonPath of jsonPaths) {
    const credentials = loadJsonCredentials(jsonPath, options?.homeDir);
    if (credentials) {
      fallbackJsonCredentials.push(credentials);
    }
  }

  let fallbackSqliteCredentials: KiroOauthCredentials | null = null;
  for (const sqlitePath of sqlitePaths) {
    const credentials = loadSqliteCredentials(sqlitePath, options?.homeDir);
    if (credentials && canRefreshWithAwsSsoOidc(credentials)) {
      // AWS IAM Identity Center tokens must refresh against oidc.{region}.amazonaws.com.
      return credentials;
    }
    fallbackSqliteCredentials ??= credentials;
  }

  return fallbackJsonCredentials[0] ?? fallbackSqliteCredentials;
}

export function isKiroOauthConfigured(
  config: KiroProviderConfig,
  env: Record<string, string | undefined> = process.env
): boolean {
  if (loadKiroOauthCredentials(config, { env }) !== null) {
    return true;
  }

  if (explicitJsonPath(config, env)) {
    return false;
  }

  const { jsonPaths, sqlitePaths } = getKiroOauthCredentialPaths(config, env);
  return [...jsonPaths, ...sqlitePaths].some((candidate) => readableFileExists(candidate));
}

export function isKiroOauthCredentialExpired(credentials: KiroOauthCredentials): boolean {
  return credentials.expiresAt == null || Date.now() >= credentials.expiresAt;
}

export function isKiroOauthCredentialExpiring(credentials: KiroOauthCredentials): boolean {
  return (
    credentials.expiresAt == null ||
    credentials.expiresAt <= Date.now() + TOKEN_REFRESH_THRESHOLD_MS
  );
}

export async function refreshKiroOauthCredentials(
  credentials: KiroOauthCredentials,
  options?: { fetch?: typeof globalThis.fetch }
): Promise<KiroOauthCredentials> {
  if (!credentials.refreshToken) {
    throw new Error("Kiro OAuth refresh token is missing. Run Kiro login again.");
  }

  const fetchFn = options?.fetch ?? globalThis.fetch;
  return credentials.clientId && credentials.clientSecret
    ? refreshAwsSsoOidcCredentials(credentials, fetchFn)
    : refreshKiroDesktopCredentials(credentials, fetchFn);
}

async function refreshKiroDesktopCredentials(
  credentials: KiroOauthCredentials,
  fetchFn: typeof globalThis.fetch
): Promise<KiroOauthCredentials> {
  const region = credentials.ssoRegion ?? credentials.region ?? DEFAULT_REGION;
  const response = await postRefreshJson(
    fetchFn,
    KIRO_DESKTOP_REFRESH_URL_TEMPLATE.replace("{region}", region),
    { refreshToken: credentials.refreshToken },
    {
      "content-type": "application/json",
      "user-agent": "Mux-KiroProvider",
    }
  );

  return mergeRefreshResponse(credentials, response);
}

async function refreshAwsSsoOidcCredentials(
  credentials: KiroOauthCredentials,
  fetchFn: typeof globalThis.fetch
): Promise<KiroOauthCredentials> {
  const region = credentials.ssoRegion ?? credentials.region ?? DEFAULT_REGION;
  const response = await postRefreshJson(
    fetchFn,
    AWS_SSO_OIDC_REFRESH_URL_TEMPLATE.replace("{region}", region),
    {
      grantType: "refresh_token",
      clientId: credentials.clientId,
      clientSecret: credentials.clientSecret,
      refreshToken: credentials.refreshToken,
    },
    { "content-type": "application/json" }
  );

  return mergeRefreshResponse(credentials, response);
}

async function postRefreshJson(
  fetchFn: typeof globalThis.fetch,
  url: string,
  body: JsonRecord,
  headers: Record<string, string>
): Promise<JsonRecord> {
  const response = await fetchFn(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(
      `Kiro OAuth refresh failed with status ${response.status}: ${response.statusText}`
    );
  }

  const parsed = (await response.json()) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Kiro OAuth refresh returned an invalid response.");
  }
  return parsed as JsonRecord;
}

type JsonRecord = Record<string, unknown>;

function mergeRefreshResponse(
  credentials: KiroOauthCredentials,
  response: JsonRecord
): KiroOauthCredentials {
  const accessToken = firstString(response.accessToken, response.access_token);
  if (!accessToken) {
    throw new Error("Kiro OAuth refresh response did not include an access token.");
  }

  const expiresAt = parseExpiresAt(response.expiresAt ?? response.expires_at);
  return {
    ...credentials,
    accessToken,
    refreshToken:
      firstString(response.refreshToken, response.refresh_token) ?? credentials.refreshToken,
    expiresAt: expiresAt ?? expiresAtFromSeconds(response.expiresIn ?? response.expires_in),
    profileArn: firstString(response.profileArn, response.profile_arn) ?? credentials.profileArn,
  };
}

function expiresAtFromSeconds(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? Date.now() + Math.max(0, value - 60) * 1000
    : undefined;
}
