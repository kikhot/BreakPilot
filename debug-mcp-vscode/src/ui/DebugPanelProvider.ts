import * as vscode from "vscode";

export class DebugPanelProvider {
  private panel?: vscode.WebviewPanel;

  show() {
    this.panel =
      this.panel ??
      vscode.window.createWebviewPanel("debugMcp", "AI Debugger", vscode.ViewColumn.Beside, {
        enableScripts: true
      });
    this.panel.webview.html = `
      <!doctype html>
      <html>
        <body>
          <h2>AI Debugger</h2>
          <pre id="log"></pre>
        </body>
      </html>
    `;
    this.panel.reveal();
  }

  append(data: unknown) {
    this.show();
    this.panel?.webview.postMessage(data);
  }
}
