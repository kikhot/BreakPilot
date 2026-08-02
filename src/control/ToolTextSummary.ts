import type { AnyRecord } from "../types/json.ts";

const MAX_SUMMARY = 160;

function bounded(text: string): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  if (singleLine.length <= MAX_SUMMARY) return singleLine;
  return `${singleLine.slice(0, MAX_SUMMARY - 1)}…`;
}

function location(result: AnyRecord): string | undefined {
  const at = result.at as AnyRecord | undefined;
  if (typeof at?.filePath !== "string" || !Number.isSafeInteger(at.line)) return undefined;
  return `${at.filePath}:${at.line}`;
}

function pausedSummary(result: AnyRecord): string {
  const at = location(result);
  const locals = Array.isArray(result.locals) ? result.locals.length : 0;
  return at
    ? `Paused at ${at}${locals ? ` with ${locals} local${locals === 1 ? "" : "s"}` : ""}.`
    : `Paused${locals ? ` with ${locals} local${locals === 1 ? "" : "s"}` : ""}.`;
}

export function summarizeToolResult(toolName: string, result: AnyRecord): string {
  const error = result.error as AnyRecord | undefined;
  if (error) return bounded(String(error.message ?? error.code ?? "Debugger tool failed."));

  if (toolName === "bp_debug_status") {
    const count = Array.isArray(result.sessions) ? result.sessions.length : 0;
    if (count === 0) return result.ideConnected === true
      ? "IDE connected; no active debug sessions."
      : "No active debug sessions; IDE disconnected.";
    return bounded(`${count} active debug session${count === 1 ? "" : "s"}.`);
  }
  if (
    (toolName === "bp_debug_control" || toolName === "bp_debug_context" || toolName === "bp_debug_run_to_line") &&
    result.state === "paused"
  ) {
    return bounded(pausedSummary(result));
  }
  if (toolName === "bp_debug_frame") {
    const frame = result.frame as AnyRecord | undefined;
    const at = frame?.at as AnyRecord | undefined;
    const locals = Array.isArray(result.locals) ? result.locals.length : 0;
    if (typeof at?.filePath === "string" && Number.isSafeInteger(at.line)) {
      return bounded(`Frame at ${at.filePath}:${at.line}${locals ? ` with ${locals} locals` : ""}.`);
    }
  }
  if (toolName === "bp_debug_value") {
    const value = result.value as AnyRecord | undefined;
    if (typeof value?.name === "string") return bounded(`Read ${value.name}: ${String(value.value)}.`);
  }
  if (toolName === "bp_debug_start" && typeof result.sessionId === "string") {
    return bounded(`Started ${String(result.startMode ?? "debug")} session ${result.sessionId} (${String(result.state ?? "unknown")}).`);
  }
  if (toolName === "bp_debug_eval") return bounded(`Evaluated ${String(result.expression ?? "expression")}: ${String(result.value)}.`);
  if (toolName === "bp_debug_list_breakpoints") {
    const count = Array.isArray(result.breakpoints) ? result.breakpoints.length : 0;
    return `${count} breakpoint${count === 1 ? "" : "s"}.`;
  }
  return bounded(`Completed ${toolName}.`);
}
