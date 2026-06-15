import * as vscode from "vscode";
import { BridgeMessage } from "../bridge/MessageProtocol";

export class DebugPanelProvider {
  private panel?: vscode.WebviewPanel;
  private readonly entries: unknown[] = [];

  constructor(private readonly onAction: (action: string) => void = () => {}) {}

  show() {
    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel("breakpilot", "AI Debugger", vscode.ViewColumn.Beside, {
        enableScripts: true
      });
      this.panel.onDidDispose(() => {
        this.panel = undefined;
      });
      this.panel.webview.onDidReceiveMessage((message: { command?: string }) => {
        if (message.command === "requestAnalysis") this.onAction("requestAnalysis");
      });
      this.panel.webview.html = this.html(this.panel.webview);
      for (const entry of this.entries) this.post(entry);
    }
    this.panel.reveal();
  }

  append(data: unknown) {
    this.entries.push(data);
    if (this.entries.length > 200) this.entries.splice(0, this.entries.length - 200);
    if (this.panel) this.post(data);
  }

  private post(data: unknown) {
    this.panel?.webview.postMessage({
      type: "append",
      entry: this.formatEntry(data)
    });
  }

  private formatEntry(data: unknown) {
    const message = data as BridgeMessage;
    const type = typeof message?.type === "string" ? message.type : "event";
    const summary = this.summaryFor(message);
    return {
      type,
      summary,
      timestamp: new Date().toLocaleTimeString(),
      detail: JSON.stringify(data, null, 2)
    };
  }

  private summaryFor(message: BridgeMessage): string {
    if (!message || typeof message.type !== "string") return "BreakPilot event";
    if (message.error) return `${message.type}: ${String(message.error.message ?? "error")}`;
    if (message.type.includes("session")) return `${message.type}: ${message.name ?? message.ideSessionId ?? "debug session"}`;
    if (message.type.includes("breakpoint")) return `${message.type}: ${message.breakpoint?.file ?? message.breakpointId ?? ""}`;
    if (message.type.includes("variables")) return `${message.type}: snapshot`;
    if (message.state) return `${message.type}: ${message.state}`;
    return message.type;
  }

  private html(webview: vscode.Webview): string {
    const nonce = this.nonce();
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`
    ].join("; ");
    return `
      <!doctype html>
      <html lang="en">
        <head>
          <meta charset="UTF-8">
          <meta http-equiv="Content-Security-Policy" content="${csp}">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <style>
            body {
              font-family: var(--vscode-font-family);
              color: var(--vscode-foreground);
              background: var(--vscode-editor-background);
              margin: 0;
            }
            header {
              display: flex;
              align-items: center;
              justify-content: space-between;
              border-bottom: 1px solid var(--vscode-panel-border);
              padding: 10px 12px;
            }
            h2 {
              font-size: 14px;
              font-weight: 600;
              margin: 0;
            }
            button {
              background: var(--vscode-button-background);
              color: var(--vscode-button-foreground);
              border: 0;
              border-radius: 2px;
              padding: 4px 8px;
            }
            #log {
              display: grid;
              gap: 6px;
              padding: 10px;
            }
            .entry {
              border: 1px solid var(--vscode-panel-border);
              border-radius: 4px;
              padding: 8px;
            }
            .summary {
              font-weight: 600;
              margin-bottom: 4px;
            }
            .meta {
              color: var(--vscode-descriptionForeground);
              font-size: 11px;
              margin-bottom: 6px;
            }
            pre {
              white-space: pre-wrap;
              word-break: break-word;
              margin: 0;
              max-height: 260px;
              overflow: auto;
            }
          </style>
        </head>
        <body>
          <header>
            <h2>BreakPilot Debugger</h2>
            <button id="analyze" title="Request AI analysis">Analyze</button>
          </header>
          <main id="log"></main>
          <script nonce="${nonce}">
            const vscode = acquireVsCodeApi();
            const log = document.getElementById('log');
            document.getElementById('analyze').addEventListener('click', () => {
              vscode.postMessage({ command: 'requestAnalysis' });
            });
            window.addEventListener('message', event => {
              if (event.data?.type !== 'append') return;
              const entry = event.data.entry;
              const item = document.createElement('section');
              item.className = 'entry';
              const summary = document.createElement('div');
              summary.className = 'summary';
              summary.textContent = entry.summary;
              const meta = document.createElement('div');
              meta.className = 'meta';
              meta.textContent = entry.timestamp + ' - ' + entry.type;
              const detail = document.createElement('pre');
              detail.textContent = entry.detail;
              item.append(summary, meta, detail);
              log.prepend(item);
            });
          </script>
        </body>
      </html>
    `;
  }

  private nonce(): string {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let text = "";
    for (let index = 0; index < 32; index += 1) {
      text += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return text;
  }
}
