import { Button } from "@/browser/components/Button/Button";
import { useLanguage } from "@/browser/contexts/LanguageContext";

interface StartupConnectionErrorProps {
  error: string;
  onRetry: () => void;
}

export function StartupConnectionError(props: StartupConnectionErrorProps) {
  const { t } = useLanguage();
  return (
    <div className="boot-loader" role="alert" aria-live="polite">
      <div className="boot-loader__inner">
        <p className="boot-loader__text">{t("Unable to connect to the Mux backend.")}</p>

        <p className="boot-loader__text max-w-[720px] text-center">
          <span className="font-medium">{t("Details:")}</span> {props.error}
        </p>

        <p className="boot-loader__text max-w-[720px] text-center">
          {t("If you're using a reverse proxy, ensure it supports WebSocket upgrades to")}{" "}
          <code>/orpc/ws</code>.
        </p>

        <Button onClick={props.onRetry}>{t("Retry")}</Button>
      </div>
    </div>
  );
}
