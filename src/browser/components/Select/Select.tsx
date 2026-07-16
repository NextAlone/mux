import {
  Select as ShadcnSelect,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/browser/components/SelectPrimitive/SelectPrimitive";
import { useLanguage } from "@/browser/contexts/LanguageContext";

interface SelectOption {
  value: string;
  label: string;
}

interface SelectProps {
  value: string;
  options: SelectOption[] | string[];
  onChange: (value: string) => void;
  disabled?: boolean;
  className?: string;
  id?: string;
  "aria-label"?: string;
}

/**
 * Reusable select component with consistent styling
 * Wraps shadcn Select with a simpler API for common use cases
 */
export function Select({
  value,
  options,
  onChange,
  disabled = false,
  className = "",
  id,
  "aria-label": ariaLabel,
}: SelectProps) {
  const { t } = useLanguage();
  // Normalize options to SelectOption format
  const normalizedOptions: SelectOption[] = options.map((opt) =>
    typeof opt === "string" ? { value: opt, label: opt } : opt
  );

  return (
    <ShadcnSelect value={value} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger id={id} className={className} aria-label={ariaLabel}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {normalizedOptions.map((opt) => (
          <SelectItem key={opt.value} value={opt.value}>
            {t(opt.label)}
          </SelectItem>
        ))}
      </SelectContent>
    </ShadcnSelect>
  );
}
