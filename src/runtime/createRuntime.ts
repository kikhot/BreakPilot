import type { ToolRouter } from "../control/ToolRouter.ts";
import { ToolRouter as ControlToolRouter } from "../control/ToolRouter.ts";
import { AuditLogger } from "../audit/AuditLogger.ts";
import { IdeBridgeServer } from "../ide/IdeBridgeServer.ts";
import { loadPolicy } from "../security/PolicyLoader.ts";
import { DebugSessionManager } from "../sessions/DebugSessionManager.ts";
import type { BreakPilotPolicy } from "../types/policy.ts";

export interface RuntimeOptions {
  policyPath?: string;
  enableIdeBridge?: boolean;
  ideBridgePort?: number | string;
}

export interface RuntimeContext {
  policy: BreakPilotPolicy;
  manager: DebugSessionManager;
  router: ToolRouter;
  ideBridge: IdeBridgeServer | null;
}

export function createRuntime(options: RuntimeOptions = {}): RuntimeContext {
  const policy = loadPolicy(options.policyPath);
  const audit = new AuditLogger(policy);
  let ideBridge: IdeBridgeServer | null = null;
  const bridgePort = options.ideBridgePort ?? policy.ide?.bridge?.port;
  if (options.enableIdeBridge && policy.ide?.enabled) {
    ideBridge = new IdeBridgeServer({
      host: policy.ide.bridge.host,
      port: bridgePort,
      audit
    });
  }
  const manager = new DebugSessionManager({ policy, ideBridge });
  const router = new ControlToolRouter(manager);
  return { policy, manager, router, ideBridge };
}
