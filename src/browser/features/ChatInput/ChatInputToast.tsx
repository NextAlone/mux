import type { ReactNode } from "react";
import { AlertTriangle, Check } from "lucide-react";
import React, { useEffect, useCallback } from "react";
import { cn } from "@/common/lib/utils";
import { useLanguage } from "@/browser/contexts/LanguageContext";

const toastTypeStyles: Record<"success" | "error", string> = {
  success: "bg-toast-success-bg border border-accent-dark text-toast-success-text",
  error: "bg-toast-error-bg border border-toast-error-border text-toast-error-text",
};

export interface Toast {
  id: string;
  type: "success" | "error";
  title?: string;
  message: string;
  /** Stable key + values let dynamic messages translate without using interpolated dictionary keys. */
  messageKey?: string;
  messageReplacements?: Readonly<Record<string, string>>;
  solution?: ReactNode;
  duration?: number;
}

interface ChatInputToastProps {
  toast: Toast | null;
  onDismiss: () => void;
  /**
   * When false, render only the toast content (no absolute-positioned wrapper).
   * Useful for stacking multiple toasts under a single overlay container.
   */
  wrap?: boolean;
}

function translateWithReplacements(
  translationKey: string,
  replacements: Readonly<Record<string, string>> | undefined,
  t: (text: string) => string
): string {
  let translated = t(translationKey);
  for (const [key, value] of Object.entries(replacements ?? {})) {
    translated = translated.replaceAll(`{${key}}`, value);
  }
  return translated;
}

export const ToastTranslation: React.FC<{
  translationKey: string;
  replacements?: Readonly<Record<string, string>>;
}> = (props) => {
  const { t } = useLanguage();
  return translateWithReplacements(props.translationKey, props.replacements, t);
};

export const SolutionLabel: React.FC<{ translationKey: string }> = (props) => {
  const { t } = useLanguage();
  return (
    <div className="text-muted-light mb-1 text-[10px] uppercase">{t(props.translationKey)}</div>
  );
};

const wrapperClassName =
  "pointer-events-none absolute right-[15px] bottom-full left-[15px] z-[1000] mb-2 [&>*]:pointer-events-auto";

function translateToastNode(node: ReactNode, t: (text: string) => string): ReactNode {
  if (typeof node === "string") return t(node);
  if (Array.isArray(node)) {
    return (node as readonly ReactNode[]).map((child) => translateToastNode(child, t));
  }
  if (!React.isValidElement<{ children?: ReactNode }>(node) || node.props.children == null) {
    return node;
  }

  // Toast helpers are created outside React, so translate their static rich-text
  // fragments here while leaving dynamic error details and command examples intact.
  return React.cloneElement(node, undefined, translateToastNode(node.props.children, t));
}

export const ChatInputToast: React.FC<ChatInputToastProps> = ({
  toast,
  onDismiss,
  wrap = true,
}) => {
  const { t } = useLanguage();
  const [isLeaving, setIsLeaving] = React.useState(false);

  // Avoid carrying the fade-out animation state across toast changes.
  // If we auto-dismiss or manually dismiss a toast, `isLeaving` becomes true.
  // Without resetting it on new toasts, subsequent toasts can render in a permanent
  // fade-out state and appear invisible.
  useEffect(() => {
    setIsLeaving(false);
  }, [toast?.id]);

  const handleDismiss = useCallback(() => {
    setIsLeaving(true);
    setTimeout(onDismiss, 200); // Wait for fade animation
  }, [onDismiss]);

  useEffect(() => {
    if (!toast) return;

    // Use longer duration in E2E tests to give assertions time to observe the toast
    const e2eDuration = 10_000;
    const defaultSuccessDuration = window.api?.isE2E ? e2eDuration : 3000;

    // Auto-dismiss when duration is explicitly provided, regardless of toast type.
    // Otherwise, only success toasts auto-dismiss.
    const duration = toast.duration ?? (toast.type === "success" ? defaultSuccessDuration : null);
    if (duration !== null) {
      const timer = setTimeout(() => {
        handleDismiss();
      }, duration);

      return () => {
        clearTimeout(timer);
      };
    }

    // Error toasts stay until manually dismissed
    return () => {
      setIsLeaving(false);
    };
  }, [toast, handleDismiss]);

  if (!toast) return null;

  const translatedMessage = translateWithReplacements(
    toast.messageKey ?? toast.message,
    toast.messageReplacements,
    t
  );

  // Use rich error style when there's a title or solution
  const isRichError = toast.type === "error" && (toast.title ?? toast.solution);

  const content = isRichError ? (
    <div
      role="alert"
      aria-live="assertive"
      className="bg-toast-fatal-bg border-toast-fatal-border text-danger-soft animate-[toastSlideIn_0.2s_ease-out] rounded border px-3 py-2.5 text-xs shadow-[0_4px_12px_rgba(0,0,0,0.3)]"
    >
      <div className="flex items-start gap-1.5">
        <AlertTriangle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
        <div className="flex-1">
          {toast.title && <div className="mb-1.5 font-semibold">{t(toast.title)}</div>}
          <div className="text-light mt-1.5 leading-[1.4]">{translatedMessage}</div>
          {toast.solution && (
            <div className="bg-dark font-monospace text-code-type mt-2 rounded px-2 py-1.5 text-[11px]">
              {translateToastNode(toast.solution, t)}
            </div>
          )}
        </div>
        <button
          onClick={handleDismiss}
          aria-label={t("Dismiss")}
          className="flex h-4 w-4 cursor-pointer items-center justify-center border-0 bg-transparent p-0 text-base leading-none text-inherit opacity-60 transition-opacity hover:opacity-100"
        >
          ×
        </button>
      </div>
    </div>
  ) : (
    <div
      role={toast.type === "error" ? "alert" : "status"}
      aria-live={toast.type === "error" ? "assertive" : "polite"}
      className={cn(
        "px-3 py-2 rounded text-xs shadow-[0_4px_12px_rgba(0,0,0,0.3)]",
        isLeaving
          ? "animate-[toastFadeOut_0.2s_ease-out_forwards]"
          : "animate-[toastSlideIn_0.2s_ease-out]",
        toastTypeStyles[toast.type]
      )}
    >
      {/* Header row: icon + optional title + dismiss */}
      <div className="flex items-center gap-2">
        {toast.type === "success" ? (
          <Check aria-hidden="true" className="h-4 w-4 shrink-0" />
        ) : (
          <AlertTriangle aria-hidden="true" className="h-4 w-4 shrink-0" />
        )}
        {toast.title && <span className="flex-1 text-[11px] font-semibold">{t(toast.title)}</span>}
        {!toast.title && <span className="flex-1" />}
        {toast.type === "error" && (
          <button
            onClick={handleDismiss}
            aria-label={t("Dismiss")}
            className="flex h-4 w-4 cursor-pointer items-center justify-center border-0 bg-transparent p-0 text-base leading-none text-inherit opacity-60 transition-opacity hover:opacity-100"
          >
            ×
          </button>
        )}
      </div>
      {/* Message on its own line */}
      <div className="mt-1.5 opacity-90">{translatedMessage}</div>
    </div>
  );

  if (!wrap) return content;

  return <div className={wrapperClassName}>{content}</div>;
};
