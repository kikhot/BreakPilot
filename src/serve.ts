#!/usr/bin/env -S node --experimental-strip-types
import { startHttp } from "./http/controlServer.ts";
import { LocalControlGateway } from "./control/ControlGateway.ts";
import { startStdio } from "./mcp/stdioServer.ts";
import { createRuntime } from "./runtime/createRuntime.ts";

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const args: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token) continue;
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) args[key] = true;
      else {
        args[key] = next;
        i += 1;
      }
    }
  }
  return args;
}

function stringArg(args: Record<string, string | boolean>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" ? value : undefined;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const enableIdeBridge = Boolean(args["ide-bridge-port"] || args["ide-bridge"]);
  const runtime = createRuntime({
    policyPath: stringArg(args, "policy"),
    enableIdeBridge,
    ideBridgePort: stringArg(args, "ide-bridge-port")
  });

  if (args["http-port"]) {
    const host = stringArg(args, "host") || "127.0.0.1";
    const port = stringArg(args, "http-port") || "27890";
    const http = await startHttp(runtime.router, port, host);
    process.stderr.write(`breakpilot HTTP listening on ${http.url}\n`);
  }

  if (enableIdeBridge && runtime.ideBridge) {
    await runtime.ideBridge.start();
    const bridge = runtime.ideBridge.status();
    process.stderr.write(`breakpilot IDE bridge listening on ${bridge.host}:${bridge.port}\n`);
  }

  if (!args["http-port"] || args.stdio) {
    startStdio(new LocalControlGateway(runtime.router));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    const typedError = error as Error;
    process.stderr.write(`${typedError.stack || typedError.message}\n`);
    process.exit(1);
  });
}
