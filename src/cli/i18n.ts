/**
 * i18n message catalog and locale resolution for the BreakPilot CLI.
 *
 * Scope (R13.6): this module ONLY covers human-readable help/version related
 * copy (usage, epilog, command and option descriptions). It never touches the
 * machine-readable JSON output of control-plane commands.
 *
 * The locale values (`en_US` / `zh_CN`) are designed to be passed directly to
 * yargs' `.locale()` so that framework labels (Usage:/Commands:/Options:) are
 * localized as well (R13.7).
 */

export type Locale = "en_US" | "zh_CN";

export const SUPPORTED_LOCALES: Locale[] = ["en_US", "zh_CN"];

export const DEFAULT_LOCALE: Locale = "en_US";

/**
 * Help/version related copy. Keys:
 * - `usage` / `epilog`: top-level program copy.
 * - `cmd[<command path>]`: command descriptions (e.g. `cmd["mcp serve"]`).
 * - `opt[<flag name>]`: option descriptions (e.g. `opt.session`).
 */
export interface MessageCatalog {
  usage: string;
  epilog: string;
  cmd: Record<string, string>;
  opt: Record<string, string>;
}

const EN_EPILOG = [
  "Examples:",
  "  breakpilot serve --auto-port",
  "  breakpilot mcp serve --policy ./breakpilot.yaml",
  "",
  "MCP client configuration (recommended when `breakpilot` is on PATH):",
  "  {",
  '    "mcpServers": {',
  '      "breakpilot-debugger": {',
  '        "command": "breakpilot",',
  '        "args": ["mcp", "serve", "--policy", "{BREAKPILOT_ROOT}/breakpilot.yaml"],',
  '        "env": { "BREAKPILOT_WORKSPACE": "{BREAKPILOT_ROOT}" }',
  "      }",
  "    }",
  "  }",
  "",
  "Environment variables:",
  "  BREAKPILOT_CONTROL_URL  Control-plane URL used when --control-url is not set",
  "                          (defaults to http://127.0.0.1:57987)."
].join("\n");

const ZH_EPILOG = [
  "示例：",
  "  breakpilot serve --auto-port",
  "  breakpilot mcp serve --policy ./breakpilot.yaml",
  "",
  "MCP 客户端配置（当 `breakpilot` 已在 PATH 中时推荐使用）：",
  "  {",
  '    "mcpServers": {',
  '      "breakpilot-debugger": {',
  '        "command": "breakpilot",',
  '        "args": ["mcp", "serve", "--policy", "{BREAKPILOT_ROOT}/breakpilot.yaml"],',
  '        "env": { "BREAKPILOT_WORKSPACE": "{BREAKPILOT_ROOT}" }',
  "      }",
  "    }",
  "  }",
  "",
  "环境变量：",
  "  BREAKPILOT_CONTROL_URL  未设置 --control-url 时使用的控制平面地址",
  "                          （默认 http://127.0.0.1:57987）。"
].join("\n");

const EN_CATALOG: MessageCatalog = {
  usage: "breakpilot <command> [options]\n\nAI-callable multi-language runtime debugger (MCP / DAP / CLI / IDE bridge).",
  epilog: EN_EPILOG,
  cmd: {
    serve: "Start the BreakPilot HTTP control daemon (optionally with the IDE bridge).",
    daemon: "Inspect the running BreakPilot daemon.",
    "daemon status": "Print the daemon status as JSON.",
    "daemon stop": "Ask the workspace daemon to shut down.",
    "daemon restart": "Restart the workspace daemon.",
    mcp: "Model Context Protocol (MCP) server commands.",
    "mcp serve": "Start the stdio MCP server (stdout carries only MCP protocol traffic).",
    tools: "Print the available control-plane tool definitions as JSON.",
    policy: "Inspect BreakPilot policy configuration.",
    "policy print": "Print the resolved policy as pretty JSON.",
    call: "Invoke a control-plane tool directly with optional JSON arguments.",
    launch: "Launch a new debug session for a program.",
    attach: "Attach to an existing debuggee over a debug adapter.",
    wait: "Wait until the session stops at a breakpoint.",
    snapshot: "Capture a runtime snapshot of the stopped session.",
    "inspect-variable": "Inspect a variable by its variables reference.",
    eval: "Evaluate an expression in the context of the stopped session.",
    continue: "Resume execution of the session.",
    "step-over": "Step over the current line.",
    "step-into": "Step into the current call.",
    "step-out": "Step out of the current frame.",
    disconnect: "Disconnect from the debug session.",
    sessions: "List active debug sessions.",
    breakpoint: "Manage breakpoints (alias: bp).",
    "breakpoint set": "Set a breakpoint in a file at a given line.",
    "breakpoint remove": "Remove a breakpoint by id.",
    "breakpoint list": "List breakpoints for a session.",
    ide: "IDE bridge commands.",
    "ide status": "Print the IDE bridge status as JSON.",
    "ide sessions": "List IDE sessions known to the bridge.",
    "ide adopt": "Adopt an IDE session as a BreakPilot debug session.",
    "ide context": "Fetch the active breakpoint context from the IDE."
  },
  opt: {
    "control-url": "Control-plane URL (overrides BREAKPILOT_CONTROL_URL).",
    pretty: "Pretty-print JSON output.",
    policy: "Path to the policy file.",
    locale: "Language for help/version copy (en_US or zh_CN).",
    session: "Debug session id.",
    file: "Source file path.",
    line: "Line number (1-based).",
    column: "Column number (1-based).",
    condition: "Breakpoint condition expression.",
    "hit-condition": "Breakpoint hit-count condition.",
    "log-message": "Logpoint message to emit instead of stopping.",
    "require-verified": "Require the breakpoint to be verified by the adapter.",
    id: "Breakpoint id.",
    lang: "Target language (e.g. python, node).",
    program: "Program entry point to launch.",
    module: "Module to launch instead of a program file.",
    args: "Program arguments (space-separated).",
    cwd: "Working directory for the launched program.",
    mode: "Execution mode (e.g. readonly).",
    owner: "Session owner identifier.",
    "adapter-command": "Debug adapter command to spawn.",
    "adapter-args": "Debug adapter arguments (space-separated).",
    "adapter-port": "Debug adapter port.",
    host: "Host to bind or connect to.",
    port: "Port to connect to.",
    "dap-host": "Debug Adapter Protocol host.",
    "dap-port": "Debug Adapter Protocol port.",
    timeout: "Timeout in milliseconds.",
    thread: "Thread id.",
    frame: "Stack frame index.",
    profile: "Snapshot profile (e.g. focused, full).",
    category: "Snapshot category to include (repeatable).",
    scope: "Snapshot scope to include (repeatable).",
    objects: "Object field expansion strategy (e.g. deep).",
    depth: "Maximum expansion depth.",
    "max-items": "Maximum number of items to include.",
    "max-string-length": "Maximum string length before truncation.",
    ref: "Variables reference id.",
    start: "Start index for paged children.",
    count: "Number of children to fetch.",
    terminate: "Terminate the debuggee on disconnect.",
    client: "IDE client id.",
    ide: "IDE type (vscode or idea).",
    workspace: "Workspace path or identifier.",
    "ide-session": "IDE session id.",
    "http-port": "HTTP control port to listen on.",
    "ide-bridge-port": "IDE bridge port to listen on.",
    "ide-bridge": "Enable the IDE bridge.",
    "auto-port": "Allow BreakPilot to choose free local ports when defaults are occupied.",
    lifecycle: "Daemon lifecycle; persistent daemons stay running until stopped."
  }
};

const ZH_CATALOG: MessageCatalog = {
  usage: "breakpilot <命令> [选项]\n\n面向 AI 调用的多语言运行时调试器（MCP / DAP / CLI / IDE 桥接）。",
  epilog: ZH_EPILOG,
  cmd: {
    serve: "启动 BreakPilot HTTP 控制守护进程（可选启用 IDE 桥接）。",
    daemon: "查看正在运行的 BreakPilot 守护进程。",
    "daemon status": "以 JSON 输出守护进程状态。",
    "daemon stop": "请求当前工作区守护进程关闭。",
    "daemon restart": "重启当前工作区守护进程。",
    mcp: "Model Context Protocol（MCP）服务相关命令。",
    "mcp serve": "启动 stdio MCP server（stdout 仅承载 MCP 协议内容）。",
    tools: "以 JSON 输出可用的控制平面工具定义。",
    policy: "查看 BreakPilot 策略配置。",
    "policy print": "以美化 JSON 输出解析后的策略。",
    call: "直接调用控制平面工具，并可附带 JSON 参数。",
    launch: "为程序启动一个新的调试会话。",
    attach: "通过调试适配器附加到已有的被调试进程。",
    wait: "等待会话在断点处停下。",
    snapshot: "采集已停止会话的运行时快照。",
    "inspect-variable": "通过变量引用检视某个变量。",
    eval: "在已停止会话的上下文中求值表达式。",
    continue: "恢复会话执行。",
    "step-over": "单步跳过当前行。",
    "step-into": "单步进入当前调用。",
    "step-out": "单步跳出当前栈帧。",
    disconnect: "断开调试会话。",
    sessions: "列出活动的调试会话。",
    breakpoint: "管理断点（别名：bp）。",
    "breakpoint set": "在文件指定行设置断点。",
    "breakpoint remove": "按 id 移除断点。",
    "breakpoint list": "列出某个会话的断点。",
    ide: "IDE 桥接相关命令。",
    "ide status": "以 JSON 输出 IDE 桥接状态。",
    "ide sessions": "列出桥接已知的 IDE 会话。",
    "ide adopt": "将某个 IDE 会话接管为 BreakPilot 调试会话。",
    "ide context": "从 IDE 获取当前活动断点的上下文。"
  },
  opt: {
    "control-url": "控制平面地址（覆盖 BREAKPILOT_CONTROL_URL）。",
    pretty: "美化 JSON 输出。",
    policy: "策略文件路径。",
    locale: "帮助/版本文案的语言（en_US 或 zh_CN）。",
    session: "调试会话 id。",
    file: "源文件路径。",
    line: "行号（从 1 开始）。",
    column: "列号（从 1 开始）。",
    condition: "断点条件表达式。",
    "hit-condition": "断点命中次数条件。",
    "log-message": "日志断点输出的消息（不停下执行）。",
    "require-verified": "要求断点被适配器校验通过。",
    id: "断点 id。",
    lang: "目标语言（如 python、node）。",
    program: "要启动的程序入口。",
    module: "以模块方式启动（替代程序文件）。",
    args: "程序参数（空格分隔）。",
    cwd: "被启动程序的工作目录。",
    mode: "执行模式（如 readonly）。",
    owner: "会话所有者标识。",
    "adapter-command": "要启动的调试适配器命令。",
    "adapter-args": "调试适配器参数（空格分隔）。",
    "adapter-port": "调试适配器端口。",
    host: "绑定或连接的主机。",
    port: "要连接的端口。",
    "dap-host": "Debug Adapter Protocol 主机。",
    "dap-port": "Debug Adapter Protocol 端口。",
    timeout: "超时时间（毫秒）。",
    thread: "线程 id。",
    frame: "栈帧索引。",
    profile: "快照配置（如 focused、full）。",
    category: "要包含的快照类别（可重复）。",
    scope: "要包含的快照作用域（可重复）。",
    objects: "对象字段展开策略（如 deep）。",
    depth: "最大展开深度。",
    "max-items": "包含的最大条目数。",
    "max-string-length": "字符串截断前的最大长度。",
    ref: "变量引用 id。",
    start: "分页子项的起始索引。",
    count: "要获取的子项数量。",
    terminate: "断开时终止被调试进程。",
    client: "IDE 客户端 id。",
    ide: "IDE 类型（vscode 或 idea）。",
    workspace: "工作区路径或标识。",
    "ide-session": "IDE 会话 id。",
    "http-port": "监听的 HTTP 控制端口。",
    "ide-bridge-port": "监听的 IDE 桥接端口。",
    "ide-bridge": "启用 IDE 桥接。",
    "auto-port": "默认端口被占用时允许 BreakPilot 自动选择本地空闲端口。",
    lifecycle: "守护进程生命周期；persistent 会保持运行直到显式停止。"
  }
};

const catalogs: Record<Locale, MessageCatalog> = {
  en_US: EN_CATALOG,
  zh_CN: ZH_CATALOG
};

function isSupportedLocale(value: string): value is Locale {
  return (SUPPORTED_LOCALES as string[]).includes(value);
}

/**
 * Resolve the locale from argv (R13.2/R13.3/R13.4).
 *
 * Scans for `--locale <value>` or `--locale=<value>`. Returns the matching
 * supported locale, otherwise falls back to {@link DEFAULT_LOCALE}. This is a
 * total function: it never throws for any input (Correctness Property 1).
 */
export function resolveLocale(argv: string[]): Locale {
  if (!Array.isArray(argv)) return DEFAULT_LOCALE;
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (typeof token !== "string") continue;
    if (token === "--locale") {
      const next = argv[i + 1];
      if (typeof next === "string" && isSupportedLocale(next)) return next;
      // Unsupported or missing value -> fall back to default (R13.4).
      continue;
    }
    if (token.startsWith("--locale=")) {
      const value = token.slice("--locale=".length);
      if (isSupportedLocale(value)) return value;
    }
  }
  return DEFAULT_LOCALE;
}

function lookup(catalog: MessageCatalog, key: string): string | undefined {
  if (key === "usage") return catalog.usage;
  if (key === "epilog") return catalog.epilog;
  const dot = key.indexOf(".");
  if (dot > 0) {
    const group = key.slice(0, dot);
    const name = key.slice(dot + 1);
    if (group === "cmd") return catalog.cmd[name];
    if (group === "opt") return catalog.opt[name];
  }
  return undefined;
}

/**
 * Build a translator for the given locale.
 *
 * Resolution order: requested locale -> English fallback (R13.8). A missing
 * translation never yields an empty string or the raw key; for unknown keys a
 * generic non-empty placeholder is returned (Correctness Property 6).
 */
export function createTranslator(locale: Locale): (key: string) => string {
  const primary = catalogs[locale] ?? EN_CATALOG;
  return (key: string): string => {
    const direct = lookup(primary, key);
    if (typeof direct === "string" && direct.length > 0) return direct;
    const fallback = lookup(EN_CATALOG, key);
    if (typeof fallback === "string" && fallback.length > 0) return fallback;
    return "(no description available)";
  };
}
