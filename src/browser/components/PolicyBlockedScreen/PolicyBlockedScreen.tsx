import { useLanguage } from "@/browser/contexts/LanguageContext";
export function PolicyBlockedScreen(props: { reason?: string }) {
  const { t } = useLanguage();
  return (
    <div className="bg-bg-dark flex h-full items-center justify-center p-6">
      <div className="bg-separator border-border-light w-full max-w-xl rounded-lg border p-6 shadow-lg">
        <h1 className="text-foreground text-base font-semibold">{t("Mux is blocked by policy")}</h1>
        <p className="text-muted mt-2 text-sm">
          {props.reason ?? t("This Mux client is blocked by an admin policy.")}
        </p>
        <p className="text-muted mt-4 text-xs">{t("Contact your administrator for help.")}</p>
      </div>
    </div>
  );
}
