import { FEATURES_ZH_CN } from "./features";
import { SETTINGS_ZH_CN } from "./settings";
import { SHELL_ZH_CN } from "./shell";

export const ZH_CN: Record<string, string> = {
  ...SHELL_ZH_CN,
  ...FEATURES_ZH_CN,
  ...SETTINGS_ZH_CN,
};
