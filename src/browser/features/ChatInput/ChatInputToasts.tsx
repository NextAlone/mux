import type { Toast } from "./ChatInputToast";
import { SolutionLabel, ToastTranslation } from "./ChatInputToast";
import { DocsLink } from "@/browser/components/DocsLink/DocsLink";
import type { ParsedCommand } from "@/browser/utils/slashCommands/types";
import type { SendMessageError as SendMessageErrorType } from "@/common/types/errors";
import { formatSendMessageError } from "@/common/utils/errors/formatSendError";
import { PROVIDER_DISPLAY_NAMES, type ProviderName } from "@/common/constants/providers";

const getProviderDisplayName = (provider: string): string =>
  PROVIDER_DISPLAY_NAMES[provider as ProviderName] ?? provider;

export function createInvalidCompactModelToast(model: string): Toast {
  return {
    id: Date.now().toString(),
    type: "error",
    title: "Invalid Model",
    message: `Invalid model format: "${model}". Use an alias or provider:model-id.`,
    messageKey: 'Invalid model format: "{model}". Use an alias or provider:model-id.',
    messageReplacements: { model },
    solution: (
      <>
        <SolutionLabel translationKey="Try an alias:" />
        <code>/compact -m sonnet</code>
        <br />
        <code>/compact -m gpt</code>
        <br />
        <br />
        <SolutionLabel translationKey="Supported models:" />
        {/* i18n-ignore -- documentation URL */}
        <DocsLink path="/config/models">mux.coder.com/models</DocsLink>
      </>
    ),
  };
}

/**
 * Creates a toast message for command-related errors and help messages
 */
export const createCommandToast = (parsed: ParsedCommand): Toast | null => {
  if (!parsed) return null;

  switch (parsed.type) {
    case "model-help":
      return {
        id: Date.now().toString(),
        type: "error",
        title: "Model Command",
        message: "Select AI model for this session or send a one-shot message",
        solution: (
          <>
            <SolutionLabel translationKey="Set model for session:" />
            <code>/model sonnet</code>
            <br />
            <code>/model anthropic:claude-sonnet-4-5</code>
            <br />
            <br />
            <SolutionLabel translationKey="One-shot (single message):" />
            <code>/haiku explain this code</code>
            <br />
            <code>/opus review my changes</code>
            <br />
            <br />
            <SolutionLabel translationKey="With thinking override:" />
            <code>/opus+high deep review</code>
            <br />
            <code>/haiku+0 quick answer (0=lowest for model)</code>
            <br />
            <code>/+2 use current model, thinking level 2</code>
          </>
        ),
      };

    case "command-missing-args":
      return {
        id: Date.now().toString(),
        type: "error",
        title: "Missing Arguments",
        message: `/${parsed.command} requires arguments`,
        messageKey: "/{command} requires arguments",
        messageReplacements: { command: parsed.command },
        solution: (
          <>
            <SolutionLabel translationKey="Usage:" />
            {parsed.usage}
          </>
        ),
      };

    case "command-invalid-args":
      return {
        id: Date.now().toString(),
        type: "error",
        title: "Invalid Argument",
        message: `'${parsed.input}' is not valid for /${parsed.command}`,
        messageKey: "'{input}' is not valid for /{command}",
        messageReplacements: { input: parsed.input, command: parsed.command },
        solution: (
          <>
            <SolutionLabel translationKey="Usage:" />
            {parsed.usage}
          </>
        ),
      };

    case "command-unknown-flag":
      return {
        id: Date.now().toString(),
        type: "error",
        title: "Unknown Flag",
        message: `Unknown flag for /${parsed.command}: ${parsed.flag}`,
        messageKey: "Unknown flag for /{command}: {flag}",
        messageReplacements: { command: parsed.command, flag: parsed.flag },
        solution: parsed.usage ? (
          <>
            <SolutionLabel translationKey="Usage:" />
            {parsed.usage}
          </>
        ) : undefined,
      };

    case "unknown-command": {
      const cmd = "/" + parsed.command + (parsed.subcommand ? " " + parsed.subcommand : "");
      return {
        id: Date.now().toString(),
        type: "error",
        message: `Unknown command: ${cmd}`,
        messageKey: "Unknown command: {command}",
        messageReplacements: { command: cmd },
      };
    }

    default:
      return null;
  }
};

/**
 * Converts a SendMessageError to a Toast for display
 */
export const createErrorToast = (error: SendMessageErrorType): Toast => {
  switch (error.type) {
    case "api_key_not_found": {
      return {
        id: Date.now().toString(),
        type: "error",
        title: "API Key Not Found",
        message: `The ${error.provider} provider requires an API key to function.`,
        messageKey: "The {provider} provider requires an API key to function.",
        messageReplacements: { provider: error.provider },
        solution: (
          <>
            <SolutionLabel translationKey="Fix:" />
            <ToastTranslation
              translationKey="Open Settings → Providers and add an API key for {provider}."
              replacements={{ provider: getProviderDisplayName(error.provider) }}
            />
            <br />
            {/* i18n-ignore -- documentation URL */}
            <DocsLink path="/config/providers">mux.coder.com/providers</DocsLink>
          </>
        ),
      };
    }

    case "oauth_not_connected": {
      return {
        id: Date.now().toString(),
        type: "error",
        title: "OAuth Not Connected",
        message: `The ${error.provider} provider requires an OAuth connection to function.`,
        messageKey: "The {provider} provider requires an OAuth connection to function.",
        messageReplacements: { provider: error.provider },
        solution: (
          <>
            <SolutionLabel translationKey="Fix:" />
            <ToastTranslation
              translationKey="Open Settings → Providers and connect your {provider} account."
              replacements={{ provider: getProviderDisplayName(error.provider) }}
            />
            <br />
            {/* i18n-ignore -- documentation URL */}
            <DocsLink path="/config/providers">mux.coder.com/providers</DocsLink>
          </>
        ),
      };
    }

    case "provider_disabled": {
      const formatted = formatSendMessageError(error);
      return {
        id: Date.now().toString(),
        type: "error",
        title: "Provider Disabled",
        message: formatted.message,
        messageKey: "Provider {provider} is disabled.",
        messageReplacements: { provider: getProviderDisplayName(error.provider) },
        solution: (
          <>
            <SolutionLabel translationKey="Fix:" />
            <ToastTranslation
              translationKey="Open Settings → Providers and enable {provider}."
              replacements={{ provider: getProviderDisplayName(error.provider) }}
            />
            <br />
            {/* i18n-ignore -- documentation URL */}
            <DocsLink path="/config/providers">mux.coder.com/providers</DocsLink>
          </>
        ),
      };
    }

    case "provider_not_supported": {
      const formatted = formatSendMessageError(error);
      return {
        id: Date.now().toString(),
        type: "error",
        title: "Provider Not Supported",
        message: formatted.message,
        messageKey: "Provider {provider} is not supported yet.",
        messageReplacements: { provider: getProviderDisplayName(error.provider) },
        solution: (
          <>
            <SolutionLabel translationKey="Try This:" />
            <ToastTranslation translationKey="Choose a supported provider in Settings → Providers." />
            <br />
            {/* i18n-ignore -- documentation URL */}
            <DocsLink path="/config/providers">mux.coder.com/providers</DocsLink>
          </>
        ),
      };
    }

    case "invalid_model_string": {
      const formatted = formatSendMessageError(error);
      return {
        id: Date.now().toString(),
        type: "error",
        title: "Invalid Model Format",
        message: formatted.message,
        solution: (
          <>
            <SolutionLabel translationKey="Expected Format:" />
            <code>provider:model-name (e.g., anthropic:claude-opus-4-1)</code>
          </>
        ),
      };
    }

    case "incompatible_workspace": {
      return {
        id: Date.now().toString(),
        type: "error",
        title: "Incompatible Workspace",
        message: error.message,
        solution: (
          <>
            <SolutionLabel translationKey="Solution:" />
            <ToastTranslation translationKey="Upgrade mux to use this workspace, or delete it and create a new one." />
          </>
        ),
      };
    }

    case "unknown":
    default: {
      const formatted = formatSendMessageError(error);
      return {
        id: Date.now().toString(),
        type: "error",
        title: "Message Send Failed",
        message: formatted.message,
      };
    }
  }
};
