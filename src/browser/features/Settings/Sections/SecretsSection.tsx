import React, { useCallback, useEffect, useRef, useState } from "react";
import { KeyRound, Loader2, Trash2 } from "lucide-react";
import type { ProjectConfig } from "@/common/types/project";
import { isOpSecretValue, type Secret } from "@/common/types/secrets";
import { useAPI } from "@/browser/contexts/API";
import { useProjectContext } from "@/browser/contexts/ProjectContext";
import { useSettings } from "@/browser/contexts/SettingsContext";
import { useLanguage } from "@/browser/contexts/LanguageContext";
import { Button } from "@/browser/components/Button/Button";
import { Input } from "@/browser/components/Input/Input";
import { Switch } from "@/browser/components/Switch/Switch";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/browser/components/Tooltip/Tooltip";
import { OnePasswordPicker } from "../Components/OnePasswordPicker";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@/browser/components/ToggleGroupPrimitive/ToggleGroupPrimitive";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/browser/components/SelectPrimitive/SelectPrimitive";
import {
  formatProjectHierarchyLabel,
  getFirstTopLevelProjectPath,
  getTopLevelProjectEntries,
} from "@/common/utils/subProjects";

type SecretsScope = "global" | "project";

// Visibility toggle icon component
const ToggleVisibilityIcon: React.FC<{ visible: boolean }> = (props) => {
  if (props.visible) {
    // Eye-off icon (with slash) - password is visible
    return (
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
        <line x1="1" y1="1" x2="23" y2="23" />
      </svg>
    );
  }

  // Eye icon - password is hidden
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
};

function isSecretReferenceValue(value: Secret["value"]): value is { secret: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "secret" in value &&
    typeof (value as { secret?: unknown }).secret === "string"
  );
}

function secretValuesEqual(a: Secret["value"], b: Secret["value"]): boolean {
  if (typeof a === "string" && typeof b === "string") {
    return a === b;
  }

  if (isSecretReferenceValue(a) && isSecretReferenceValue(b)) {
    return a.secret === b.secret;
  }

  if (isOpSecretValue(a) && isOpSecretValue(b)) {
    return a.op === b.op && a.opLabel === b.opLabel;
  }

  return false;
}

function secretValueIsNonEmpty(value: Secret["value"]): boolean {
  if (typeof value === "string") {
    return value.trim() !== "";
  }

  if (isSecretReferenceValue(value)) {
    return value.secret.trim() !== "";
  }

  if (isOpSecretValue(value)) {
    return value.op.trim() !== "";
  }

  return false;
}

function secretsEqual(a: Secret[], b: Secret[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const left = a[i];
    const right = b[i];
    if (!left || !right) return false;
    if (left.key !== right.key) return false;
    if (!secretValuesEqual(left.value, right.value)) return false;
    if (!!left.injectAll !== !!right.injectAll) return false;
  }
  return true;
}

function isProjectSecretsTarget(
  userProjects: Map<string, ProjectConfig>,
  projectPath: string
): boolean {
  const project = userProjects.get(projectPath);
  return project !== undefined && project.parentProjectPath == null;
}

function localizeSecretsError(error: string, t: (text: string) => string): string {
  for (const prefix of [
    "Secrets loaded, but failed to load injected globals:",
    "Secrets saved, but failed to refresh injected globals:",
  ]) {
    if (error.startsWith(`${prefix} `)) {
      return `${t(prefix)} ${error.slice(prefix.length + 1)}`;
    }
  }
  return t(error);
}

export const SecretsSection: React.FC = () => {
  const { api } = useAPI();
  const { t } = useLanguage();
  const { userProjects } = useProjectContext();
  const { secretsProjectPath, setSecretsProjectPath } = useSettings();
  const projectList = getTopLevelProjectEntries(userProjects).map(([projectPath]) => projectPath);

  // Consume one-shot project scope hint from the sidebar secrets button. Secrets
  // are applied from the parent workspace owner, so sub-projects stay out of the
  // project picker until runtime injection supports child-specific secrets.
  const initialScope: SecretsScope =
    secretsProjectPath && isProjectSecretsTarget(userProjects, secretsProjectPath)
      ? "project"
      : "global";
  const initialProject = initialScope === "project" ? secretsProjectPath! : "";

  const [scope, setScope] = useState<SecretsScope>(initialScope);
  const [selectedProject, setSelectedProject] = useState<string>(initialProject);

  const [loadedSecrets, setLoadedSecrets] = useState<Secret[]>([]);
  const [secrets, setSecrets] = useState<Secret[]>([]);
  const [visibleSecrets, setVisibleSecrets] = useState<Set<number>>(() => new Set());

  const [globalSecretKeys, setGlobalSecretKeys] = useState<string[]>([]);
  const [opAvailable, setOpAvailable] = useState(false);
  const [opPickerIndex, setOpPickerIndex] = useState<number | null>(null);

  const [opAccountName, setOpAccountName] = useState("");
  const [opAvailabilityVersion, setOpAvailabilityVersion] = useState(0);
  const [injectedGlobalSecretKeys, setInjectedGlobalSecretKeys] = useState<string[]>([]);

  // Track the last plaintext value per row index so toggling Source back to
  // "Value" restores the user's input instead of clearing it.
  const lastLiteralValuesRef = useRef<Map<number, string>>(new Map());

  // Ignore stale async loads after the user switches projects or scope so older
  // responses cannot overwrite state for the latest selection.
  const loadSecretsRequestVersionRef = useRef(0);

  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const scopeLabel = t(scope === "global" ? "Global" : "Project");
  const showSourceColumn = scope === "project" || opAvailable;
  const secretGridColumns =
    scope === "global"
      ? showSourceColumn
        ? "@[512px]:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_auto_auto_auto]"
        : "@[512px]:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto_auto_auto]"
      : "@[512px]:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_auto_auto]";

  // When re-opened with a new project hint (e.g., clicking the secrets button again
  // for a different project), sync the scope and clear the one-shot hint.
  // Only clear the hint once the project is actually found in the project list;
  // projects load asynchronously, so we must keep the hint alive until then.
  useEffect(() => {
    if (!secretsProjectPath) return;
    if (!isProjectSecretsTarget(userProjects, secretsProjectPath)) return;
    setScope("project");
    setSelectedProject(secretsProjectPath);
    setSecretsProjectPath(null);
  }, [secretsProjectPath, userProjects, setSecretsProjectPath]);

  // Default to the first project when switching into Project scope.
  useEffect(() => {
    if (scope !== "project") {
      return;
    }

    if (selectedProject && isProjectSecretsTarget(userProjects, selectedProject)) {
      return;
    }

    setSelectedProject(getFirstTopLevelProjectPath(userProjects) ?? "");
  }, [scope, selectedProject, userProjects]);

  const currentProjectPath = scope === "project" ? selectedProject : undefined;

  const isDirty = !secretsEqual(secrets, loadedSecrets);

  const sortedGlobalSecretKeys = globalSecretKeys
    .slice()
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));

  const sortedInjectedGlobalSecretKeys = injectedGlobalSecretKeys
    .slice()
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));

  const loadSecrets = useCallback(async () => {
    const requestVersion = loadSecretsRequestVersionRef.current + 1;
    loadSecretsRequestVersionRef.current = requestVersion;

    const isStaleRequest = () => loadSecretsRequestVersionRef.current !== requestVersion;

    if (!api) {
      setLoadedSecrets([]);
      setSecrets([]);
      setInjectedGlobalSecretKeys([]);
      setVisibleSecrets(new Set());
      setOpPickerIndex(null);
      setError(null);
      setLoading(false);
      return;
    }

    if (scope === "project" && !currentProjectPath) {
      setLoadedSecrets([]);
      setSecrets([]);
      setInjectedGlobalSecretKeys([]);
      setVisibleSecrets(new Set());
      setOpPickerIndex(null);
      setError(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      if (scope === "project") {
        const projectPath = currentProjectPath;
        if (!projectPath) {
          setLoadedSecrets([]);
          setSecrets([]);
          setInjectedGlobalSecretKeys([]);
          setVisibleSecrets(new Set());
          setError(null);
          setLoading(false);
          return;
        }

        const nextSecrets = await api.secrets.get({ projectPath });
        if (isStaleRequest()) {
          return;
        }
        setLoadedSecrets(nextSecrets);
        setSecrets(nextSecrets);

        try {
          const injectedKeys = await api.secrets.getInjectedGlobals({ projectPath });
          if (isStaleRequest()) {
            return;
          }
          setInjectedGlobalSecretKeys(injectedKeys);
        } catch (err) {
          if (isStaleRequest()) {
            return;
          }
          const message = err instanceof Error ? err.message : "Failed to load injected globals";
          setInjectedGlobalSecretKeys([]);
          setError(`Secrets loaded, but failed to load injected globals: ${message}`);
        }
      } else {
        const nextSecrets = await api.secrets.get({});
        if (isStaleRequest()) {
          return;
        }
        setLoadedSecrets(nextSecrets);
        setSecrets(nextSecrets);
        setInjectedGlobalSecretKeys([]);
      }

      if (isStaleRequest()) {
        return;
      }
      setVisibleSecrets(new Set());
      setOpPickerIndex(null);
      lastLiteralValuesRef.current = new Map();
    } catch (err) {
      if (isStaleRequest()) {
        return;
      }
      const message = err instanceof Error ? err.message : "Failed to load secrets";
      setLoadedSecrets([]);
      setSecrets([]);
      setInjectedGlobalSecretKeys([]);
      setVisibleSecrets(new Set());
      setOpPickerIndex(null);
      lastLiteralValuesRef.current = new Map();
      setError(message);
    } finally {
      if (!isStaleRequest()) {
        setLoading(false);
      }
    }
  }, [api, currentProjectPath, scope]);

  useEffect(() => {
    void loadSecrets();
  }, [loadSecrets]);

  useEffect(() => {
    if (!api) {
      setOpAvailable(false);
      setOpPickerIndex(null);
      return;
    }

    let cancelled = false;
    void api.onePassword
      .isAvailable()
      .then((result) => {
        if (cancelled) {
          return;
        }

        setOpAvailable(result.available);
        if (!result.available) {
          setOpPickerIndex(null);
        }
      })
      .catch(() => {
        if (cancelled) {
          return;
        }

        setOpAvailable(false);
        setOpPickerIndex(null);
      });

    return () => {
      cancelled = true;
    };
  }, [api, opAvailabilityVersion]);

  useEffect(() => {
    if (!api) {
      setOpAccountName("");
      return;
    }

    let cancelled = false;
    void api.config
      .getConfig()
      .then((config) => {
        if (cancelled) {
          return;
        }

        setOpAccountName(config.onePasswordAccountName ?? "");
      })
      .catch(() => {
        // Best-effort only.
      });

    return () => {
      cancelled = true;
    };
  }, [api]);

  const handleOpAccountNameChange = useCallback((value: string) => {
    setOpAccountName(value);
  }, []);

  const handleOpAccountNameBlur = useCallback(
    (value: string) => {
      void api?.config
        .updateOnePasswordAccountName({ onePasswordAccountName: value || null })
        .then(() => {
          // Trigger a fresh availability check after account changes.
          setOpAvailabilityVersion((version) => version + 1);
        });
    },
    [api]
  );

  // Load global secret keys (used for {secret:"KEY"} project secret values).
  useEffect(() => {
    if (!api) {
      setGlobalSecretKeys([]);
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        const secrets = await api.secrets.get({});
        if (cancelled) return;
        setGlobalSecretKeys(secrets.map((s) => s.key));
      } catch (err) {
        if (cancelled) return;
        console.error("Failed to load global secrets:", err);
        setGlobalSecretKeys([]);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [api]);

  const addSecret = useCallback(() => {
    setSecrets((prev) => [...prev, { key: "", value: "" }]);
  }, []);

  const removeSecret = useCallback((index: number) => {
    setSecrets((prev) => prev.filter((_, i) => i !== index));

    // Keep visibility state aligned with the remaining rows.
    //
    // Visibility is tracked by array index; deleting a row shifts later indices.
    // If we don't shift the visibility set too, we can end up revealing a different secret.
    setVisibleSecrets((prev) => {
      const next = new Set<number>();
      for (const visibleIndex of prev) {
        if (visibleIndex === index) {
          continue;
        }
        next.add(visibleIndex > index ? visibleIndex - 1 : visibleIndex);
      }
      return next;
    });

    setOpPickerIndex((prev) => {
      if (prev == null) {
        return prev;
      }

      if (prev === index) {
        return null;
      }

      return prev > index ? prev - 1 : prev;
    });

    // Shift cached literal values the same way so the right value is restored
    // if the user toggles the source back on a shifted row.
    const cache = lastLiteralValuesRef.current;
    const shifted = new Map<number, string>();
    for (const [i, val] of cache) {
      if (i === index) continue;
      shifted.set(i > index ? i - 1 : i, val);
    }
    lastLiteralValuesRef.current = shifted;
  }, []);

  const updateSecretKey = useCallback((index: number, value: string) => {
    setSecrets((prev) => {
      const next = [...prev];
      const existing = next[index] ?? { key: "", value: "" };

      // Auto-capitalize key field for env variable convention.
      next[index] = { ...existing, key: value.toUpperCase() };
      return next;
    });
  }, []);

  const updateSecretValue = useCallback((index: number, value: Secret["value"]) => {
    setSecrets((prev) => {
      const next = [...prev];
      const existing = next[index] ?? { key: "", value: "" };
      next[index] = { ...existing, value };
      return next;
    });
  }, []);

  const updateSecretInjectAll = useCallback((index: number, checked: boolean) => {
    setSecrets((prev) => {
      const next = [...prev];
      const existing = next[index] ?? { key: "", value: "" };
      next[index] = {
        ...existing,
        injectAll: checked || undefined,
      };
      return next;
    });
  }, []);

  const updateSecretValueKind = useCallback(
    (index: number, kind: "literal" | "global") => {
      setSecrets((prev) => {
        const next = [...prev];
        const existing = next[index] ?? { key: "", value: "" };
        const cache = lastLiteralValuesRef.current;

        if (kind === "literal") {
          // Restore the last plaintext value the user typed, if any.
          const restored = cache.get(index) ?? "";
          next[index] = {
            ...existing,
            value: typeof existing.value === "string" ? existing.value : restored,
          };
          return next;
        }

        if (isSecretReferenceValue(existing.value)) {
          return next;
        }

        // Stash the current plaintext value before switching to a global ref.
        if (typeof existing.value === "string") {
          cache.set(index, existing.value);
        }

        const defaultKey = globalSecretKeys[0] ?? "";
        next[index] = {
          ...existing,
          value: { secret: defaultKey },
        };
        return next;
      });
    },
    [globalSecretKeys]
  );

  const toggleVisibility = useCallback((index: number) => {
    setVisibleSecrets((prev) => {
      const next = new Set(prev);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  }, []);

  const handleReset = useCallback(() => {
    setSecrets(loadedSecrets);
    setVisibleSecrets(new Set());
    setOpPickerIndex(null);
    lastLiteralValuesRef.current = new Map();
    setError(null);
  }, [loadedSecrets]);

  const handleSave = useCallback(async () => {
    if (!api) return;

    if (scope === "project" && !currentProjectPath) {
      setError("Select a project to save project secrets.");
      return;
    }

    setSaving(true);
    setError(null);

    try {
      // Filter out empty rows.
      const validSecrets = secrets.filter(
        (s) => s.key.trim() !== "" && secretValueIsNonEmpty(s.value)
      );

      const result = await api.secrets.update(
        scope === "project"
          ? { projectPath: currentProjectPath, secrets: validSecrets }
          : { secrets: validSecrets }
      );

      if (!result.success) {
        setError(result.error ?? "Failed to save secrets");
        return;
      }

      setLoadedSecrets(validSecrets);
      setSecrets(validSecrets);

      if (scope === "global") {
        setGlobalSecretKeys(validSecrets.map((s) => s.key));
        setInjectedGlobalSecretKeys([]);
      } else {
        const projectPath = currentProjectPath;
        if (!projectPath) {
          setInjectedGlobalSecretKeys([]);
        } else {
          try {
            const injectedKeys = await api.secrets.getInjectedGlobals({ projectPath });
            setInjectedGlobalSecretKeys(injectedKeys);
          } catch (err) {
            const message =
              err instanceof Error ? err.message : "Failed to refresh injected globals";
            setError(`Secrets saved, but failed to refresh injected globals: ${message}`);
          }
        }
      }
      setVisibleSecrets(new Set());
      setOpPickerIndex(null);
      // Save compacts rows (filters out empty entries), which shifts indices.
      // Clear the cached literal values so stale entries can't be misattributed.
      lastLiteralValuesRef.current = new Map();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save secrets");
    } finally {
      setSaving(false);
    }
  }, [api, currentProjectPath, scope, secrets]);

  return (
    <div className="@container space-y-6">
      {/* Narrow Settings views stack the fixed-size account input so the explanatory copy
          and account domain never compete for the same horizontal space. */}
      <div className="flex flex-col gap-4 @[512px]:flex-row @[512px]:items-center @[512px]:justify-between">
        <div className="min-w-0 flex-1">
          <div className="text-foreground text-sm">{t("1Password Account")}</div>
          <div className="text-muted text-xs">
            {t(
              "Your 1Password account name (for example 'my-team.1password.com'). Required for 1Password integration."
            )}
          </div>
        </div>
        <Input
          value={opAccountName}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
            handleOpAccountNameChange(e.target.value)
          }
          onBlur={(e: React.FocusEvent<HTMLInputElement>) =>
            handleOpAccountNameBlur(e.target.value)
          }
          placeholder={"my-team.1password.com" /* i18n-ignore: example 1Password account domain */}
          className="border-border-medium bg-background-secondary h-9 w-full @[512px]:w-64 @[512px]:shrink-0"
        />
      </div>

      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-muted text-xs">
            {t("Secrets are stored in")} <code className="text-accent">~/.mux/secrets.json</code>{" "}
            {t("(kept out of source control).")}
          </p>
          <p className="text-muted mt-1 text-xs">
            {t("Scope:")} <span className="text-foreground">{scopeLabel}</span>
          </p>
          <p className="text-muted mt-1 text-xs">
            {t("Toggle Inject on a global secret to automatically inject it into every project.")}
          </p>
          <p className="text-muted mt-1 text-xs">
            {t("Project secrets control injection. Use Type: Global to reference a global value.")}
          </p>
        </div>

        <ToggleGroup
          type="single"
          value={scope}
          onValueChange={(value) => {
            if (value !== "global" && value !== "project") {
              return;
            }
            setScope(value);
          }}
          size="sm"
          className="h-9"
          disabled={saving}
        >
          <ToggleGroupItem value="global" size="sm" className="h-7 px-3 text-[13px]">
            {t("Global")}
          </ToggleGroupItem>
          <ToggleGroupItem value="project" size="sm" className="h-7 px-3 text-[13px]">
            {t("Project")}
          </ToggleGroupItem>
        </ToggleGroup>
      </div>

      {scope === "project" && (
        <div className="flex items-center justify-between">
          <div>
            <div className="text-foreground text-sm">{t("Project")}</div>
            <div className="text-muted text-xs">{t("Select a project to configure")}</div>
          </div>
          <Select value={selectedProject} onValueChange={setSelectedProject}>
            <SelectTrigger
              className="border-border-medium bg-background-secondary hover:bg-hover h-9 w-auto min-w-[160px] cursor-pointer rounded-md border px-3 text-sm transition-colors"
              aria-label={t("Project")}
            >
              <SelectValue placeholder={t("Select project")} />
            </SelectTrigger>
            <SelectContent>
              {projectList.map((path) => (
                <SelectItem key={path} value={path}>
                  {formatProjectHierarchyLabel(path, userProjects)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {scope === "project" && currentProjectPath && (
        <div className="space-y-2">
          <div>
            <div className="text-foreground text-sm">{t("Injected from Global")}</div>
            <div className="text-muted text-xs">
              {t("Read-only. Project secrets override injected globals when keys match.")}
            </div>
          </div>

          {sortedInjectedGlobalSecretKeys.length === 0 ? (
            <div className="text-muted border-border-medium rounded-md border border-dashed px-3 py-2 text-xs">
              {t("No global secrets are currently injected into this project.")}
            </div>
          ) : (
            <div className="border-border-medium bg-background-secondary rounded-md border px-3 py-2">
              <div className="flex flex-wrap gap-1.5">
                {sortedInjectedGlobalSecretKeys.map((key) => (
                  <code
                    key={key}
                    className="bg-modal-bg border-border-medium text-foreground inline-flex items-center rounded border px-2 py-0.5 font-mono text-[12px]"
                  >
                    {key}
                  </code>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {error && (
        <div className="bg-destructive/10 text-destructive flex items-center gap-2 rounded-md px-3 py-2 text-sm">
          {localizeSecretsError(error, t)}
        </div>
      )}

      {loading ? (
        <div className="text-muted flex items-center gap-2 py-4 text-sm">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t("Loading secrets…")}
        </div>
      ) : scope === "project" && !currentProjectPath ? (
        <div className="text-muted py-2 text-sm">
          {t("No projects configured. Add a project first to manage project secrets.")}
        </div>
      ) : secrets.length === 0 ? (
        <div className="text-muted border-border-medium rounded-md border border-dashed px-3 py-3 text-center text-xs">
          {t("No secrets configured")}
        </div>
      ) : (
        /* Each narrow secret becomes a stacked card. The container-query contents wrappers
           preserve the existing desktop column grid without duplicating controls or state. */
        <div
          className={`[&>label]:text-muted grid grid-cols-1 items-end gap-2 @[512px]:gap-1 ${secretGridColumns} [&>label]:mb-0.5 [&>label]:text-[11px]`}
        >
          <label className="hidden @[512px]:block">{t("Key")}</label>
          {showSourceColumn && <label className="hidden @[512px]:block">{t("Source")}</label>}
          <label className="hidden @[512px]:block">{t("Value")}</label>
          <div className="hidden @[512px]:block" />
          {scope === "global" && (
            <label className="hidden text-center @[512px]:block">{t("Inject")}</label>
          )}
          <div className="hidden @[512px]:block" />

          {secrets.map((secret, index) => {
            const secretValue = secret.value;
            const isOp = isOpSecretValue(secretValue);
            const isReference = scope === "project" && isSecretReferenceValue(secretValue);
            const kind: "literal" | "global" | "op" = isOp
              ? "op"
              : isReference
                ? "global"
                : "literal";
            const referencedKey = isSecretReferenceValue(secretValue) ? secretValue.secret : "";
            const opReference = isOp ? secretValue.op : "";
            const opLabel = isOp ? secretValue.opLabel : undefined;
            const availableKeys =
              referencedKey && !sortedGlobalSecretKeys.includes(referencedKey)
                ? [referencedKey, ...sortedGlobalSecretKeys]
                : sortedGlobalSecretKeys;

            return (
              <div
                key={index}
                className="border-border-medium grid min-w-0 gap-2 rounded-md border p-2 @[512px]:contents"
              >
                <div className="grid min-w-0 gap-1 @[512px]:contents">
                  <label className="text-muted text-[11px] @[512px]:hidden">{t("Key")}</label>
                  <input
                    type="text"
                    value={secret.key}
                    onChange={(e) => updateSecretKey(index, e.target.value)}
                    placeholder={"SECRET_NAME" /* i18n-ignore: environment variable example */}
                    aria-label={t("Secret key")}
                    disabled={saving}
                    spellCheck={false}
                    className="bg-modal-bg border-border-medium focus:border-accent placeholder:text-dim text-foreground min-w-0 rounded border px-2.5 py-1.5 font-mono text-[13px] focus:outline-none disabled:opacity-50"
                  />
                </div>

                {showSourceColumn && (
                  <div className="grid min-w-0 gap-1 @[512px]:contents">
                    <label className="text-muted text-[11px] @[512px]:hidden">{t("Source")}</label>
                    <Select
                      value={kind}
                      onValueChange={(value) => {
                        if (value === "op") {
                          if (!opAvailable) {
                            return;
                          }

                          setOpPickerIndex(index);
                          return;
                        }

                        if (value !== "literal" && value !== "global") {
                          return;
                        }

                        if (value === "global" && scope !== "project") {
                          return;
                        }

                        setOpPickerIndex(null);
                        updateSecretValueKind(index, value);
                      }}
                      disabled={saving}
                    >
                      <SelectTrigger
                        className="border-border-medium bg-modal-bg hover:bg-hover h-[34px] w-full px-2.5 text-[13px] @[512px]:w-[100px]"
                        aria-label={t("Secret source")}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="literal">{t("Value")}</SelectItem>
                        {scope === "project" && (
                          <SelectItem value="global" disabled={availableKeys.length === 0}>
                            {t("Global")}
                          </SelectItem>
                        )}
                        {opAvailable && (
                          <SelectItem value="op">
                            {/* i18n-ignore: product name */}
                            1Password
                          </SelectItem>
                        )}
                      </SelectContent>
                    </Select>
                  </div>
                )}

                <div className="grid min-w-0 gap-1 @[512px]:contents">
                  <label className="text-muted text-[11px] @[512px]:hidden">{t("Value")}</label>
                  {isOp ? (
                    <span className="text-foreground flex min-w-0 items-center gap-1 self-center px-2.5 font-mono text-[13px]">
                      <KeyRound className="h-3 w-3 shrink-0" />
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="truncate">{opLabel ?? opReference}</span>
                        </TooltipTrigger>
                        <TooltipContent side="top">{opReference}</TooltipContent>
                      </Tooltip>
                    </span>
                  ) : isReference ? (
                    <Select
                      value={referencedKey || undefined}
                      onValueChange={(value) => updateSecretValue(index, { secret: value })}
                      disabled={saving}
                    >
                      <SelectTrigger
                        className="border-border-medium bg-modal-bg hover:bg-hover h-[34px] w-full min-w-0 px-2.5 font-mono text-[13px]"
                        aria-label={t("Global secret key")}
                      >
                        <SelectValue placeholder={t("Select global secret")} />
                      </SelectTrigger>
                      <SelectContent>
                        {availableKeys.map((key) => (
                          <SelectItem key={key} value={key}>
                            {key}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <input
                      type={visibleSecrets.has(index) ? "text" : "password"}
                      value={
                        typeof secret.value === "string"
                          ? secret.value
                          : isSecretReferenceValue(secret.value)
                            ? secret.value.secret
                            : ""
                      }
                      onChange={(e) => updateSecretValue(index, e.target.value)}
                      placeholder={t("secret value")}
                      aria-label={t("Secret value")}
                      disabled={saving}
                      spellCheck={false}
                      className="bg-modal-bg border-border-medium focus:border-accent placeholder:text-dim text-foreground min-w-0 rounded border px-2.5 py-1.5 font-mono text-[13px] focus:outline-none disabled:opacity-50"
                    />
                  )}
                </div>

                <div className="flex items-center justify-end gap-2 @[512px]:contents">
                  {isReference || isOp ? (
                    <div className="hidden @[512px]:block" />
                  ) : (
                    <button
                      type="button"
                      onClick={() => toggleVisibility(index)}
                      disabled={saving}
                      className="text-muted hover:text-foreground flex cursor-pointer items-center justify-center self-center rounded-sm border-none bg-transparent px-1 py-0.5 text-base transition-all duration-200 disabled:cursor-not-allowed disabled:opacity-50"
                      aria-label={t(visibleSecrets.has(index) ? "Hide secret" : "Show secret")}
                    >
                      <ToggleVisibilityIcon visible={visibleSecrets.has(index)} />
                    </button>
                  )}

                  {scope === "global" && (
                    <div className="flex items-center justify-center gap-2 self-center">
                      <span className="text-muted text-[11px] @[512px]:hidden">{t("Inject")}</span>
                      <Switch
                        size="sm"
                        checked={!!secret.injectAll}
                        onCheckedChange={(checked) => updateSecretInjectAll(index, checked)}
                        disabled={saving}
                        aria-label={t("Inject into all projects")}
                      />
                    </div>
                  )}

                  <button
                    type="button"
                    onClick={() => removeSecret(index)}
                    disabled={saving}
                    className="text-danger-light border-danger-light hover:bg-danger-light/10 cursor-pointer rounded border bg-transparent px-2.5 py-1.5 text-[13px] transition-all duration-200 disabled:cursor-not-allowed disabled:opacity-50"
                    aria-label={t("Remove secret")}
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>

                {opPickerIndex === index && (
                  <div className="col-span-full">
                    <OnePasswordPicker
                      onSelect={(opRef, opLabel) => {
                        setOpPickerIndex(null);
                        setVisibleSecrets((prev) => {
                          if (!prev.has(index)) {
                            return prev;
                          }

                          const next = new Set(prev);
                          next.delete(index);
                          return next;
                        });
                        updateSecretValue(index, { op: opRef, opLabel });
                      }}
                      onCancel={() => setOpPickerIndex(null)}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <button
        onClick={addSecret}
        disabled={saving || (scope === "project" && !currentProjectPath)}
        className="text-muted border-border-medium hover:bg-hover hover:border-border-darker hover:text-foreground w-full cursor-pointer rounded border border-dashed bg-transparent px-3 py-2 text-[13px] transition-all duration-200 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {t("+ Add Secret")}
      </button>

      <div className="flex items-center justify-end gap-2">
        <Button
          variant="secondary"
          type="button"
          onClick={handleReset}
          disabled={!isDirty || saving || loading}
        >
          {t("Reset")}
        </Button>
        <Button
          type="button"
          onClick={() => void handleSave()}
          disabled={!isDirty || saving || loading}
        >
          {t(saving ? "Saving..." : "Save")}
        </Button>
      </div>
    </div>
  );
};
