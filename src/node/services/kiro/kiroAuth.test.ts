import { describe, expect, it } from "bun:test";
import * as fs from "fs";
import { writeFile } from "fs/promises";
import * as os from "os";
import * as path from "path";

import {
  isKiroOauthConfigured,
  loadKiroOauthCredentials,
  refreshKiroOauthCredentials,
} from "./kiroAuth";

async function withTempDir(run: (dir: string) => Promise<void> | void): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mux-kiro-auth-"));
  try {
    await run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

function requestUrlToString(url: RequestInfo | URL): string {
  if (typeof url === "string") {
    return url;
  }
  return url instanceof URL ? url.href : url.url;
}

describe("Kiro OAuth credentials", () => {
  it("loads Kiro JSON OAuth credentials from an explicit path", async () => {
    await withTempDir(async (dir) => {
      const credentialPath = path.join(dir, "kiro-auth-token.json");
      await writeFile(
        credentialPath,
        JSON.stringify({
          accessToken: "kiro-access-token",
          refreshToken: "kiro-refresh-token",
          expiresAt: "2099-01-01T00:00:00Z",
          profileArn: "arn:aws:codewhisperer:us-east-1:123456789012:profile/test",
          region: "us-east-1",
        }),
        "utf-8"
      );

      const credentials = loadKiroOauthCredentials({ oauthCredentialsPath: credentialPath });

      expect(credentials).toEqual({
        accessToken: "kiro-access-token",
        refreshToken: "kiro-refresh-token",
        expiresAt: Date.parse("2099-01-01T00:00:00Z"),
        profileArn: "arn:aws:codewhisperer:us-east-1:123456789012:profile/test",
        region: "us-east-1",
        ssoRegion: "us-east-1",
        clientId: undefined,
        clientSecret: undefined,
      });
      expect(isKiroOauthConfigured({ oauthCredentialsPath: credentialPath })).toBe(true);
    });
  });

  it("loads refresh-token-only Kiro JSON OAuth credentials", async () => {
    await withTempDir(async (dir) => {
      const credentialPath = path.join(dir, "kiro-refresh-token.json");
      await writeFile(
        credentialPath,
        JSON.stringify({
          refreshToken: "desktop-refresh-token",
          region: "us-east-1",
        }),
        "utf-8"
      );

      const credentials = loadKiroOauthCredentials({ oauthCredentialsPath: credentialPath });

      expect(credentials?.accessToken).toBeUndefined();
      expect(credentials?.refreshToken).toBe("desktop-refresh-token");
      expect(credentials?.region).toBe("us-east-1");
      expect(isKiroOauthConfigured({ oauthCredentialsPath: credentialPath })).toBe(true);
    });
  });

  it("loads kiro-cli snake_case OAuth credentials", async () => {
    await withTempDir(async (dir) => {
      const credentialPath = path.join(dir, "kiro-cli-token.json");
      await writeFile(
        credentialPath,
        JSON.stringify({
          access_token: "kiro-cli-access-token",
          refresh_token: "kiro-cli-refresh-token",
          expires_at: "2099-02-03T04:05:06.123456789Z",
          profile_arn: "arn:aws:codewhisperer:eu-central-1:123456789012:profile/test",
          region: "eu-central-1",
          client_id: "client-id",
          client_secret: "client-secret",
        }),
        "utf-8"
      );

      const credentials = loadKiroOauthCredentials({ oauthCredentialsPath: credentialPath });

      expect(credentials?.accessToken).toBe("kiro-cli-access-token");
      expect(credentials?.refreshToken).toBe("kiro-cli-refresh-token");
      expect(credentials?.profileArn).toBe(
        "arn:aws:codewhisperer:eu-central-1:123456789012:profile/test"
      );
      expect(credentials?.region).toBe("eu-central-1");
      expect(credentials?.clientId).toBe("client-id");
      expect(credentials?.clientSecret).toBe("client-secret");
      expect(credentials?.expiresAt).toBe(Date.parse("2099-02-03T04:05:06.123Z"));
    });
  });

  it("loads process environment OAuth credentials by default", () => {
    const previousToken = process.env.KIRO_ACCESS_TOKEN;
    const previousRegion = process.env.KIRO_REGION;
    try {
      process.env.KIRO_ACCESS_TOKEN = "env-access-token";
      process.env.KIRO_REGION = "ap-southeast-1";

      expect(loadKiroOauthCredentials({})).toEqual({
        accessToken: "env-access-token",
        refreshToken: undefined,
        expiresAt: undefined,
        profileArn: undefined,
        region: "ap-southeast-1",
        ssoRegion: "ap-southeast-1",
        clientId: undefined,
        clientSecret: undefined,
      });
    } finally {
      restoreEnv("KIRO_ACCESS_TOKEN", previousToken);
      restoreEnv("KIRO_REGION", previousRegion);
    }
  });

  it("treats missing OAuth files as not configured", async () => {
    await withTempDir((dir) => {
      const missingPath = path.join(dir, "missing.json");

      expect(loadKiroOauthCredentials({ oauthCredentialsPath: missingPath })).toBeNull();
      expect(isKiroOauthConfigured({ oauthCredentialsPath: missingPath })).toBe(false);
    });
  });

  it("refreshes Kiro Desktop OAuth credentials", async () => {
    let capturedUrl = "";
    let capturedBody: unknown;
    const fetchMock = ((url: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = requestUrlToString(url);
      capturedBody = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            accessToken: "new-desktop-token",
            refreshToken: "new-refresh-token",
            expiresIn: 3600,
            profileArn: "arn:aws:codewhisperer:us-west-2:123456789012:profile/test",
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      );
    }) as typeof globalThis.fetch;

    const refreshed = await refreshKiroOauthCredentials(
      {
        accessToken: "old-token",
        refreshToken: "desktop-refresh-token",
        region: "us-west-2",
      },
      { fetch: fetchMock }
    );

    expect(capturedUrl).toBe("https://prod.us-west-2.auth.desktop.kiro.dev/refreshToken");
    expect(capturedBody).toEqual({ refreshToken: "desktop-refresh-token" });
    expect(refreshed.accessToken).toBe("new-desktop-token");
    expect(refreshed.refreshToken).toBe("new-refresh-token");
    expect(refreshed.profileArn).toBe("arn:aws:codewhisperer:us-west-2:123456789012:profile/test");
    expect(refreshed.expiresAt).toBeGreaterThan(Date.now());
  });

  it("refreshes AWS SSO OIDC OAuth credentials", async () => {
    let capturedUrl = "";
    let capturedBody: unknown;
    const fetchMock = ((url: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = requestUrlToString(url);
      capturedBody = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            accessToken: "new-sso-token",
            refreshToken: "new-sso-refresh-token",
            expiresIn: 1800,
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      );
    }) as typeof globalThis.fetch;

    const refreshed = await refreshKiroOauthCredentials(
      {
        accessToken: "old-token",
        refreshToken: "sso-refresh-token",
        region: "eu-central-1",
        ssoRegion: "us-east-1",
        clientId: "client-id",
        clientSecret: "client-secret",
      },
      { fetch: fetchMock }
    );

    expect(capturedUrl).toBe("https://oidc.us-east-1.amazonaws.com/token");
    expect(capturedBody).toEqual({
      grantType: "refresh_token",
      clientId: "client-id",
      clientSecret: "client-secret",
      refreshToken: "sso-refresh-token",
    });
    expect(refreshed.accessToken).toBe("new-sso-token");
    expect(refreshed.refreshToken).toBe("new-sso-refresh-token");
    expect(refreshed.region).toBe("eu-central-1");
    expect(refreshed.ssoRegion).toBe("us-east-1");
  });
});
