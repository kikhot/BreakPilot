const provider = process.argv[2] === "idea" ? "idea" : "breakpilot";
let buffer = "";
let calls = 0;

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  while (buffer.includes("\n")) {
    const index = buffer.indexOf("\n");
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.method === "initialize") {
      process.stdout.write(`${JSON.stringify({
        jsonrpc: "2.0",
        id: message.id,
        result: { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: `fake-${provider}`, version: "1" } }
      })}\n`);
      continue;
    }
    if (message.id === undefined) continue;
    calls += 1;
    if (provider === "idea" && message.params?.arguments?.failOnce === true && calls === 1) {
      process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: "transient debugger failure" } })}\n`);
      continue;
    }
    process.stdout.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        sessionId: `${provider}-session-from-native-response`,
        position: { line: 2 },
        values: { "analysis.score": 28 },
        ...(message.params?.arguments?.returnUnknown === true ? { providerPrivateMetadata: "unreviewed" } : {})
      }
    })}\n`);
  }
});
