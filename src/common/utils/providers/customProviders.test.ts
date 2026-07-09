import { describe, expect, test } from "bun:test";
import { SUPPORTED_PROVIDERS } from "@/common/constants/providers";
import type { ProvidersConfig } from "@/common/config/schemas/providersConfig";
import {
  formatProviderDisplayName,
  getCustomProviderIds,
  getCustomOpenAICompatibleProviderIds,
  getShadowedCustomProviderIds,
  getShadowedCustomOpenAICompatibleProviderIds,
  isBuiltInProvider,
  isCustomAnthropicCompatibleProviderConfig,
  isCustomProviderConfig,
  isCustomGoogleCompatibleProviderConfig,
  isCustomOpenAICompatibleProviderConfig,
  isValidCustomProviderId,
  validateCustomProviderId,
} from "./customProviders";

describe("custom provider id validation", () => {
  test("accepts valid custom provider ids", () => {
    for (const id of ["local-vllm", "llama_cpp", "lm-studio", "proxy1", "123"]) {
      expect(isValidCustomProviderId(id)).toBe(true);
      expect(validateCustomProviderId(id)).toEqual({ ok: true });
    }
  });

  test("rejects invalid custom provider ids", () => {
    const invalidIds = [
      "",
      "Local-VLLM",
      "-local-vllm",
      "local.vllm",
      "local:vllm",
      "local/vllm",
      "local vllm",
      "__proto__",
      "prototype",
      "constructor",
      "hasOwnProperty",
    ];

    for (const id of invalidIds) {
      expect(isValidCustomProviderId(id)).toBe(false);

      const validation = validateCustomProviderId(id);
      expect(validation.ok).toBe(false);
      if (!validation.ok) {
        expect(validation.reason.length).toBeGreaterThan(0);
      }
    }
  });

  test("rejects built-in provider ids", () => {
    for (const provider of SUPPORTED_PROVIDERS) {
      expect(isValidCustomProviderId(provider)).toBe(false);
      expect(validateCustomProviderId(provider).ok).toBe(false);
      expect(isBuiltInProvider(provider)).toBe(true);
    }
  });
});

describe("isCustomOpenAICompatibleProviderConfig", () => {
  test("returns true for OpenAI-compatible custom provider config", () => {
    expect(
      isCustomOpenAICompatibleProviderConfig({
        providerType: "openai-compatible",
        baseUrl: "http://localhost:8000/v1",
      })
    ).toBe(true);
  });

  test("returns false for non-custom provider config", () => {
    expect(isCustomOpenAICompatibleProviderConfig({ apiKey: "key" })).toBe(false);
    expect(isCustomOpenAICompatibleProviderConfig(null)).toBe(false);
  });
});

describe("isCustomAnthropicCompatibleProviderConfig", () => {
  test("returns true for Anthropic-compatible custom provider config", () => {
    expect(
      isCustomAnthropicCompatibleProviderConfig({
        providerType: "anthropic-compatible",
        baseUrl: "http://localhost:8000/v1",
      })
    ).toBe(true);
  });

  test("returns false for OpenAI-compatible custom provider config", () => {
    expect(
      isCustomAnthropicCompatibleProviderConfig({
        providerType: "openai-compatible",
        baseUrl: "http://localhost:8000/v1",
      })
    ).toBe(false);
  });
});

describe("isCustomGoogleCompatibleProviderConfig", () => {
  test("returns true for Google-compatible custom provider config", () => {
    expect(
      isCustomGoogleCompatibleProviderConfig({
        providerType: "google-compatible",
        baseUrl: "http://localhost:8000/v1",
      })
    ).toBe(true);
  });
});

describe("isCustomProviderConfig", () => {
  test("accepts supported custom provider API formats", () => {
    expect(isCustomProviderConfig({ providerType: "openai-compatible" })).toBe(true);
    expect(isCustomProviderConfig({ providerType: "anthropic-compatible" })).toBe(true);
    expect(isCustomProviderConfig({ providerType: "google-compatible" })).toBe(true);
  });
});

describe("getCustomOpenAICompatibleProviderIds", () => {
  test("returns custom OpenAI-compatible providers in config key order", () => {
    const providersConfig: ProvidersConfig = {
      openai: { providerType: "openai-compatible", apiKey: "key" },
      "legacy-custom": { apiKey: "legacy-key" },
      "local-vllm": {
        providerType: "openai-compatible",
        baseUrl: "http://localhost:8000/v1",
      },
      "llama-cpp": {
        providerType: "openai-compatible",
        baseUrl: "http://localhost:8080/v1",
      },
    };

    expect(getCustomOpenAICompatibleProviderIds(providersConfig)).toEqual([
      "openai",
      "local-vllm",
      "llama-cpp",
    ]);
    expect(getShadowedCustomOpenAICompatibleProviderIds(providersConfig)).toEqual(["openai"]);
  });
});

describe("getCustomProviderIds", () => {
  test("returns all supported custom provider types in config key order", () => {
    const providersConfig: ProvidersConfig = {
      anthropic: { providerType: "anthropic-compatible", apiKey: "key" },
      "legacy-custom": { apiKey: "legacy-key" },
      "local-vllm": {
        providerType: "openai-compatible",
        baseUrl: "http://localhost:8000/v1",
      },
      "claude-proxy": {
        providerType: "anthropic-compatible",
        baseUrl: "http://localhost:8080/v1",
      },
      "gemini-proxy": {
        providerType: "google-compatible",
        baseUrl: "http://localhost:9000/v1",
      },
    };

    expect(getCustomProviderIds(providersConfig)).toEqual([
      "anthropic",
      "local-vllm",
      "claude-proxy",
      "gemini-proxy",
    ]);
    expect(getShadowedCustomProviderIds(providersConfig)).toEqual(["anthropic"]);
  });
});

describe("formatProviderDisplayName", () => {
  test("prefers shadowed custom display name over built-in display name", () => {
    expect(
      formatProviderDisplayName("openai", {
        providerType: "openai-compatible",
        displayName: "Shadowed OpenAI",
      })
    ).toBe("Shadowed OpenAI");
  });

  test("prefers Anthropic-compatible custom display name over built-in display name", () => {
    expect(
      formatProviderDisplayName("anthropic", {
        providerType: "anthropic-compatible",
        displayName: "Shadowed Anthropic",
      })
    ).toBe("Shadowed Anthropic");
  });

  test("uses built-in provider display names", () => {
    expect(formatProviderDisplayName("openai")).toBe("OpenAI");
    expect(formatProviderDisplayName("github-copilot")).toBe("GitHub Copilot");
  });

  test("uses custom display name when present", () => {
    expect(formatProviderDisplayName("local-vllm", { displayName: "Local vLLM" })).toBe(
      "Local vLLM"
    );
  });

  test("falls back to custom provider id for an empty display name", () => {
    expect(formatProviderDisplayName("local-vllm", { displayName: "" })).toBe("local-vllm");
  });

  test("falls back to custom provider id", () => {
    expect(formatProviderDisplayName("local-vllm")).toBe("local-vllm");
  });
});
