import type { ToolRouter } from "../control/ToolRouter.ts";
import { ToolRouter as ControlToolRouter } from "../control/ToolRouter.ts";
import { AuditLogger } from "../audit/AuditLogger.ts";
import { IdeBridgeServer } from "../ide/IdeBridgeServer.ts";
import { loadPolicy } from "../security/PolicyLoader.ts";
import { DebugSessionManager } from "../sessions/DebugSessionManager.ts";
import type { BreakPilotPolicy } from "../types/policy.ts";

export interface RuntimeOptions {
  policyPath?: string;
  workspaceRoot?: string;
  enableIdeBridge?: boolean;
  ideBridgePort?: number | string;
  ideBridge?: IdeBridgeServer | null;
  bridgeInstanceId?: string;
  bridgePolicyHash?: string;
  bridgeLifecycle?: string;
}

export interface RuntimeContext {
  policy: BreakPilotPolicy;
  manager: DebugSessionManager;
  router: ToolRouter;
  ideBridge: IdeBridgeServer | null;
}

export function createRuntime(options: RuntimeOptions = {}): RuntimeContext {
  const policy = loadPolicy(options.policyPath, options.workspaceRoot
    ? { ...process.env, BREAKPILOT_WORKSPACE: options.workspaceRoot }
    : process.env);
  const audit = new AuditLogger(policy);
  let ideBridge: IdeBridgeServer | null = options.ideBridge ?? null;
  const bridgePort = options.ideBridgePort ?? policy.ide?.bridge?.port;
  if (!ideBridge && options.enableIdeBridge && policy.ide?.enabled) {
    ideBridge = new IdeBridgeServer({
      host: policy.ide.bridge.host,
      port: bridgePort,
      audit,
      workspaceRoot: policy.workspace.root,
      policyHash: options.bridgePolicyHash,
      instanceId: options.bridgeInstanceId,
      lifecycle: options.bridgeLifecycle
    });
  }
  const manager = new DebugSessionManager({ policy, ideBridge });
  const router = new ControlToolRouter(manager);
  return { policy, manager, router, ideBridge };
}
