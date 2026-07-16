import { useEffect, useState } from "react";
import { Loader2, Plus, Trash2 } from "lucide-react";

import { Button } from "@/browser/components/Button/Button";
import { useAPI } from "@/browser/contexts/API";
import { useLanguage } from "@/browser/contexts/LanguageContext";
import { SearchableModelSelect } from "@/browser/features/Settings/Components/SearchableModelSelect";
import { useModelsFromSettings } from "@/browser/hooks/useModelsFromSettings";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/browser/components/SelectPrimitive/SelectPrimitive";
import type { FusionConfig, FusionModelConfig } from "@/common/config/schemas/appConfigOnDisk";
import { getThinkingOptionLabel, type ThinkingLevel } from "@/common/types/thinking";
import { getErrorMessage } from "@/common/utils/errors";
import { getThinkingPolicyForModel } from "@/common/utils/thinking/policy";

const EMPTY_PANEL: FusionModelConfig[] = [{ modelString: "" }, { modelString: "" }];
const DEFAULT_THINKING = "__default__";

function ThinkingSelect(props: {
  value: ThinkingLevel | undefined;
  modelString: string;
  onChange: (value: ThinkingLevel | undefined) => void;
  ariaLabel: string;
}) {
  const { t } = useLanguage();
  const allowedLevels = getThinkingPolicyForModel(props.modelString);
  const value = props.value && allowedLevels.includes(props.value) ? props.value : DEFAULT_THINKING;
  return (
    <Select
      value={value}
      onValueChange={(value) =>
        props.onChange(value === DEFAULT_THINKING ? undefined : (value as ThinkingLevel))
      }
    >
      <SelectTrigger
        className="border-border-medium bg-modal-bg h-8 w-full text-xs"
        aria-label={props.ariaLabel}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={DEFAULT_THINKING}>{t("Inherit agent reasoning")}</SelectItem>
        {allowedLevels.map((level) => (
          <SelectItem key={level} value={level}>
            {t(getThinkingOptionLabel(level, props.modelString))}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function FusionSection() {
  const { api } = useAPI();
  const { t } = useLanguage();
  const { models } = useModelsFromSettings();
  const [panel, setPanel] = useState<FusionModelConfig[]>(EMPTY_PANEL);
  const [judge, setJudge] = useState<FusionModelConfig>({ modelString: "" });
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    void api.config
      .getConfig()
      .then((config) => {
        if (cancelled) return;
        if (config.fusion) {
          setPanel(config.fusion.panel);
          setJudge(config.fusion.judge);
        }
        setLoaded(true);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setMessage(`Failed to load Fusion settings: ${getErrorMessage(error)}`);
        setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  const updatePanelModel = (index: number, modelString: string) => {
    setPanel((current) =>
      current.map((entry, entryIndex) =>
        entryIndex === index
          ? { modelString, ...(entry.modelString === modelString ? entry : {}) }
          : entry
      )
    );
    setMessage(null);
  };

  const removePanelModel = (index: number) => {
    setPanel((current) => current.filter((_, entryIndex) => entryIndex !== index));
    setMessage(null);
  };

  const normalizedModels = panel.map((entry) => entry.modelString.trim());
  const configuredModels = normalizedModels.filter(Boolean);
  const hasDuplicates = new Set(configuredModels).size !== configuredModels.length;
  const canSave =
    loaded &&
    !saving &&
    panel.length >= 2 &&
    panel.length <= 8 &&
    normalizedModels.every(Boolean) &&
    !hasDuplicates &&
    Boolean(judge.modelString.trim());

  const save = async () => {
    if (!api || !canSave) return;
    setSaving(true);
    setMessage(null);
    const fusion: FusionConfig = {
      panel: panel.map((entry) => ({
        modelString: entry.modelString.trim(),
        ...(entry.thinkingLevel != null &&
        getThinkingPolicyForModel(entry.modelString).includes(entry.thinkingLevel)
          ? { thinkingLevel: entry.thinkingLevel }
          : {}),
      })),
      judge: {
        modelString: judge.modelString.trim(),
        ...(judge.thinkingLevel != null &&
        getThinkingPolicyForModel(judge.modelString).includes(judge.thinkingLevel)
          ? { thinkingLevel: judge.thinkingLevel }
          : {}),
      },
    };
    try {
      await api.config.saveConfig({ fusion });
      setPanel(fusion.panel);
      setJudge(fusion.judge);
      setMessage("Fusion defaults saved.");
    } catch (error: unknown) {
      setMessage(`Failed to save Fusion settings: ${getErrorMessage(error)}`);
    } finally {
      setSaving(false);
    }
  };

  if (!loaded) {
    return (
      <div className="flex items-center justify-center gap-2 py-12">
        <Loader2 className="text-muted h-5 w-5 animate-spin" />
        <span className="text-muted text-sm">{t("Loading Fusion settings...")}</span>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-foreground text-sm font-medium">{t("Fusion defaults")}</h3>
        <p className="text-muted mt-1 text-xs">
          {t(
            "Every Fusion run starts from this panel and judge. Phrases such as “use Mimo and Gemini to review” override only that run."
          )}
        </p>
      </div>

      <div className="space-y-3">
        <div>
          <div className="text-foreground text-sm">{t("Panel models")}</div>
          <div className="text-muted text-xs">
            {t("Two to eight models run independently in parallel.")}
          </div>
        </div>
        {panel.map((entry, index) => (
          <div
            key={index}
            className="border-border-medium bg-background-secondary flex min-w-0 items-start gap-2 rounded-md border p-2"
          >
            <div className="grid min-w-0 flex-1 grid-cols-1 gap-2 sm:grid-cols-2">
              <SearchableModelSelect
                value={entry.modelString}
                onChange={(value) => updatePanelModel(index, value)}
                models={models}
                emptyOption={{
                  value: "",
                  label: t("Select panel model {number}").replace("{number}", String(index + 1)),
                }}
                compact
              />
              <ThinkingSelect
                value={entry.thinkingLevel}
                modelString={entry.modelString}
                onChange={(thinkingLevel) => {
                  setPanel((current) =>
                    current.map((currentEntry, entryIndex) =>
                      entryIndex === index
                        ? {
                            modelString: currentEntry.modelString,
                            ...(thinkingLevel != null ? { thinkingLevel } : {}),
                          }
                        : currentEntry
                    )
                  );
                  setMessage(null);
                }}
                ariaLabel={t("Panel model {number} reasoning").replace(
                  "{number}",
                  String(index + 1)
                )}
              />
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              disabled={panel.length <= 2}
              onClick={() => removePanelModel(index)}
              aria-label={t("Remove panel model {number}").replace("{number}", String(index + 1))}
              tooltip={t("Remove model")}
            >
              <Trash2 />
            </Button>
          </div>
        ))}
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={panel.length >= 8}
          onClick={() => {
            setPanel((current) => [...current, { modelString: "" }]);
            setMessage(null);
          }}
        >
          <Plus />
          {t("Add panel model")}
        </Button>
      </div>

      <div className="space-y-2">
        <div>
          <div className="text-foreground text-sm">{t("Judge model")}</div>
          <div className="text-muted text-xs">
            {t("Synthesizes agreement, disagreement, blind spots, and the final recommendation.")}
          </div>
        </div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <SearchableModelSelect
            value={judge.modelString}
            onChange={(modelString) => {
              setJudge({ modelString });
              setMessage(null);
            }}
            models={models}
            emptyOption={{ value: "", label: t("Select judge model") }}
            compact
          />
          <ThinkingSelect
            value={judge.thinkingLevel}
            modelString={judge.modelString}
            onChange={(thinkingLevel) => {
              setJudge((current) => ({
                modelString: current.modelString,
                ...(thinkingLevel != null ? { thinkingLevel } : {}),
              }));
              setMessage(null);
            }}
            ariaLabel={t("Judge model reasoning")}
          />
        </div>
      </div>

      {hasDuplicates ? (
        <div className="text-error text-xs">{t("Panel models must be distinct.")}</div>
      ) : null}
      {message ? (
        <div className="text-muted text-xs">
          {message.startsWith("Failed to load Fusion settings: ")
            ? `${t("Failed to load Fusion settings:")} ${message.slice("Failed to load Fusion settings: ".length)}`
            : message.startsWith("Failed to save Fusion settings: ")
              ? `${t("Failed to save Fusion settings:")} ${message.slice("Failed to save Fusion settings: ".length)}`
              : t(message)}
        </div>
      ) : null}

      <div className="flex justify-end">
        <Button type="button" disabled={!canSave} onClick={() => void save()}>
          {t(saving ? "Saving..." : "Save Fusion defaults")}
        </Button>
      </div>
    </div>
  );
}
