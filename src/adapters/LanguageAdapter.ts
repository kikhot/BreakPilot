import fs from "node:fs";
import { DapClient } from "../dap/DapClient.ts";
import {
  DapProcessTransport,
  DapServerProcessTransport,
  DapSocketTransport
} from "../dap/DapTransport.ts";
import type { AnyRecord, DebugLanguage } from "../types.ts";
import { DebugMcpError, ErrorCodes } from "../utils/errors.ts";

interface LanguageAdapterOptions {
  language: DebugLanguage;
  adapterId: string;
  defaultCommand?: string;
  defaultArgs?: string[];
  envCommandName: string;
}

export class LanguageAdapter {
  language: DebugLanguage;
  adapterId: string;
  defaultCommand?: string;
  defaultArgs: string[];
  envCommandName: string;

  constructor({ language, adapterId, defaultCommand, defaultArgs = [], envCommandName }: LanguageAdapterOptions) {
    this.language = language;
    this.adapterId = adapterId;
    this.defaultCommand = defaultCommand;
    this.defaultArgs = defaultArgs;
    this.envCommandName = envCommandName;
  }

  createClient(args: AnyRecord = {}): DapClient {
    if (args.dapHost && args.dapPort) {
      return new DapClient(new DapSocketTransport(args.dapHost, Number(args.dapPort)));
    }
    const command =
      args.adapterCommand ||
      process.env[this.envCommandName] ||
      this.defaultCommand;
    const adapterArgs =
      Array.isArray(args.adapterArgs) && args.adapterArgs.length > 0
        ? args.adapterArgs
        : this.defaultArgs;
    if (!command) {
      throw new DebugMcpError(
        ErrorCodes.ADAPTER_START_FAILED,
        `No debug adapter command configured for ${this.language}.`,
        { language: this.language, envCommandName: this.envCommandName }
      );
    }
    return new DapClient(
      new DapProcessTransport(command, adapterArgs, {
        cwd: args.workspaceRoot,
        env: args.env
      })
    );
  }

  normalizeLaunchArgs(args: AnyRecord = {}): AnyRecord {
    return args.dap || args;
  }

  normalizeAttachArgs(args: AnyRecord = {}): AnyRecord {
    return args.dap || args;
  }
}

let nextPythonAdapterPort = 27892;

export class PythonAdapter extends LanguageAdapter {
  constructor() {
    super({
      language: "python",
      adapterId: "python",
      defaultCommand: fs.existsSync(".venv/bin/python") ? ".venv/bin/python" : "python3",
      defaultArgs: ["-m", "debugpy.adapter"],
      envCommandName: "DEBUG_MCP_PYTHON_ADAPTER"
    });
  }

  override createClient(args: AnyRecord = {}): DapClient {
    if (args.dapHost && args.dapPort) {
      return new DapClient(new DapSocketTransport(args.dapHost, Number(args.dapPort)));
    }
    if (
      args.attachMode &&
      args.host &&
      args.port &&
      !args.adapterCommand &&
      !args.adapterPort &&
      !args.adapterArgs &&
      !process.env[this.envCommandName]
    ) {
      return new DapClient(new DapSocketTransport(String(args.host), Number(args.port)));
    }
    const command =
      args.adapterCommand ||
      process.env[this.envCommandName] ||
      this.defaultCommand;
    if (!command) {
      throw new DebugMcpError(
        ErrorCodes.ADAPTER_START_FAILED,
        "No Python debug adapter command configured.",
        { envCommandName: this.envCommandName }
      );
    }
    const host = String(args.adapterHost ?? "127.0.0.1");
    const port = Number(args.adapterPort ?? nextPythonAdapterPort++);
    const baseAdapterArgs =
      Array.isArray(args.adapterArgs) && args.adapterArgs.length > 0
        ? args.adapterArgs
        : this.defaultArgs;
    const adapterArgs = [
      ...baseAdapterArgs,
      "--host",
      host,
      "--port",
      String(port)
    ];
    return new DapClient(
      new DapServerProcessTransport(command, adapterArgs, {
        host,
        port,
        cwd: args.workspaceRoot,
        env: args.env
      })
    );
  }

  override normalizeLaunchArgs(args: AnyRecord = {}): AnyRecord {
    if (args.dap) return args.dap;
    return {
      program: args.program,
      module: args.module,
      args: args.args ?? [],
      cwd: args.cwd ?? args.workspaceRoot,
      env: args.env,
      justMyCode: args.justMyCode ?? true,
      stopOnEntry: args.stopOnEntry ?? false
    };
  }

  override normalizeAttachArgs(args: AnyRecord = {}): AnyRecord {
    if (args.dap) return args.dap;
    return {
      connect: {
        host: args.host ?? "127.0.0.1",
        port: Number(args.port ?? 5678)
      },
      justMyCode: args.justMyCode ?? true
    };
  }
}

export class NodeAdapter extends LanguageAdapter {
  constructor(language: DebugLanguage = "node") {
    super({
      language,
      adapterId: "pwa-node",
      defaultCommand: process.env.DEBUG_MCP_JS_DEBUG_COMMAND,
      defaultArgs: process.env.DEBUG_MCP_JS_DEBUG_ARGS
        ? process.env.DEBUG_MCP_JS_DEBUG_ARGS.split(" ")
        : [],
      envCommandName: "DEBUG_MCP_JS_DEBUG_COMMAND"
    });
  }

  override normalizeLaunchArgs(args: AnyRecord = {}): AnyRecord {
    if (args.dap) return args.dap;
    return {
      type: "pwa-node",
      request: "launch",
      name: args.name ?? "Debug MCP Node Launch",
      program: args.program,
      args: args.args ?? [],
      cwd: args.cwd ?? args.workspaceRoot,
      env: args.env,
      stopOnEntry: args.stopOnEntry ?? false,
      sourceMaps: args.sourceMaps ?? true
    };
  }

  override normalizeAttachArgs(args: AnyRecord = {}): AnyRecord {
    if (args.dap) return args.dap;
    return {
      type: "pwa-node",
      request: "attach",
      name: args.name ?? "Debug MCP Node Attach",
      address: args.host ?? "127.0.0.1",
      port: Number(args.port ?? 9229),
      cwd: args.cwd ?? args.workspaceRoot,
      sourceMaps: args.sourceMaps ?? true
    };
  }
}

export class JavaAdapter extends LanguageAdapter {
  constructor() {
    super({
      language: "java",
      adapterId: "java",
      defaultCommand: process.env.DEBUG_MCP_JAVA_ADAPTER_COMMAND,
      defaultArgs: process.env.DEBUG_MCP_JAVA_ADAPTER_ARGS
        ? process.env.DEBUG_MCP_JAVA_ADAPTER_ARGS.split(" ")
        : [],
      envCommandName: "DEBUG_MCP_JAVA_ADAPTER_COMMAND"
    });
  }
}
