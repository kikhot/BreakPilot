import type { DebuggerFeatureMap, DebuggerProtocolInfo } from "../types/ide.ts";

const featureNames = [
  "breakpointUpdate",
  "eventStream",
  "stackPagination",
  "variableHandles",
  "nativeSetVariable",
  "causalDebugStart"
] as const;

export function negotiateDebuggerFeatures(
  client: DebuggerProtocolInfo,
  session: DebuggerProtocolInfo
): Required<DebuggerFeatureMap> {
  const clientVersion = validDebuggerProtocolVersion(client.debuggerProtocolVersion) ?? 0;
  const sessionVersion = validDebuggerProtocolVersion(session.debuggerProtocolVersion) ?? clientVersion;
  const clientV2 = clientVersion >= 2;
  const sessionV2 = sessionVersion >= 2;
  return Object.fromEntries(featureNames.map((feature) => [
    feature,
    clientV2 &&
      sessionV2 &&
      client.debuggerFeatures?.[feature] === true &&
      session.debuggerFeatures?.[feature] !== false
  ])) as Required<DebuggerFeatureMap>;
}

export function isDebuggerProtocolV2(
  client: DebuggerProtocolInfo,
  session: DebuggerProtocolInfo = {}
): boolean {
  const clientVersion = validDebuggerProtocolVersion(client.debuggerProtocolVersion) ?? 0;
  const sessionVersion = validDebuggerProtocolVersion(session.debuggerProtocolVersion) ?? clientVersion;
  return clientVersion >= 2 && sessionVersion >= 2;
}

export function validDebuggerProtocolVersion(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
