export type UiLanguage = "en" | "zh-CN";

export function normalizeUiLanguage(value: unknown): UiLanguage {
  return value === "zh-CN" ? "zh-CN" : "en";
}

export function uiLanguageFromLocale(locale: string): UiLanguage {
  return locale.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}

const DESKTOP_ZH_CN: Record<string, string> = {
  Edit: "编辑",
  Undo: "撤销",
  Redo: "重做",
  Cut: "剪切",
  Copy: "复制",
  Paste: "粘贴",
  "Select All": "全选",
  View: "显示",
  Reload: "重新载入",
  "Force Reload": "强制重新载入",
  "Toggle Developer Tools": "切换开发者工具",
  "Actual Size": "实际大小",
  "Zoom In": "放大",
  "Zoom Out": "缩小",
  "Toggle Full Screen": "切换全屏",
  Window: "窗口",
  Minimize: "最小化",
  Close: "关闭",
  About: "关于",
  "Settings...": "设置…",
  Services: "服务",
  Hide: "隐藏",
  "Hide Others": "隐藏其他窗口",
  "Show All": "全部显示",
  Quit: "退出",
  "Open mux": "打开 mux",
  Exit: "退出",
  "Application Error": "应用错误",
  "An unexpected error occurred:": "发生意外错误：",
  "Stack trace:": "堆栈信息：",
  "No stack trace available": "没有可用的堆栈信息",
  "Unhandled Promise Rejection": "未处理的 Promise 拒绝",
  "An unhandled promise rejection occurred:": "发生未处理的 Promise 拒绝：",
  "Select Project Directory": "选择项目目录",
  "Select Project": "选择项目",
  "Startup Failed": "启动失败",
  "The application failed to start:": "应用启动失败：",
  "Please check the console for details.": "请查看控制台了解详情。",
  "Install & restart": "安装并重启",
  Later: "稍后",
  Cancel: "取消",
  "An update is ready to install.": "更新已准备好安装。",
  "Install now to restart and apply the update, or keep Mux running in the tray.":
    "立即安装并重启以应用更新，或让 Mux 继续在状态栏运行。",
};

export function translateDesktopUi(language: UiLanguage, text: string): string {
  return language === "zh-CN" ? (DESKTOP_ZH_CN[text] ?? text) : text;
}
