# Java Debug Example (JDI bridge)

Java cannot be debugged over DAP directly: a JVM started with `-agentlib:jdwp=...`
speaks **JDWP**, not DAP, and the JDK ships no DAP adapter. BreakPilot solves this
with a vendored **JDI-to-DAP bridge** (`src/debug-adapters/java/JdiDapServer.java`)
that it compiles on demand with the local JDK and drives over TCP. You only need a
**JDK 21+** on `PATH` or `JAVA_HOME` — no extra dependencies.

`Calculator.java` has a `calculateTotal` method; line 6 (`int total = amount - discount;`)
is the natural breakpoint.

## Prerequisites

```bash
java -version    # JDK 21+
javac -version
```

## Compile WITH debug info

You must compile with `-g` so the JVM keeps the `LocalVariableTable`; otherwise
the debugger returns empty variable lists even when stopped.

```bash
cd examples/java
javac -g Calculator.java
```

## Option A — Launch mode (BreakPilot starts the JVM)

The bridge spawns the JVM under JDWP and JDI-attaches automatically. `lang` may be
omitted — it is inferred from the `.java` extension.

```json
{"tool":"debug_launch","arguments":{"lang":"java","program":"examples/java/Calculator.java","classpath":"examples/java","stopOnEntry":true}}
{"tool":"set_breakpoint","arguments":{"sessionId":"<id>","file":"examples/java/Calculator.java","line":6}}
{"tool":"wait_for_breakpoint","arguments":{"sessionId":"<id>","timeoutMs":30000}}
{"tool":"get_runtime_snapshot","arguments":{"sessionId":"<id>","profile":"focused"}}
{"tool":"evaluate","arguments":{"sessionId":"<id>","expression":"amount - discount","mode":"readonly"}}
{"tool":"continue_execution","arguments":{"sessionId":"<id>"}}
{"tool":"disconnect","arguments":{"sessionId":"<id>"}}
```

CLI equivalent:

```bash
breakpilot launch --lang java --program examples/java/Calculator.java --classpath examples/java --pretty
breakpilot bp set --session <id> --file examples/java/Calculator.java --line 6 --pretty
breakpilot wait --session <id> --timeout 30000 --pretty
breakpilot snapshot --session <id> --profile focused --pretty
```

## Option B — Attach mode (attach to a running JVM started with JDWP)

This is the original "DAP can't see JDWP" case the bridge fixes.

Terminal 1 — start the JVM under JDWP (port `5005` is already in
`breakpilot.yaml` `network.allowedPorts`):

```bash
cd examples/java
javac -g Calculator.java
java -agentlib:jdwp=transport=dt_socket,server=y,suspend=y,address=*:5005 -cp . Calculator
# prints: Listening for transport dt_socket at address: 5005
```

Terminal 2 — attach with BreakPilot. The host/port is a **JDWP endpoint**; the
bridge connects to it via JDI (it is never dialed as a raw DAP socket).

```json
{"tool":"debug_attach","arguments":{"lang":"java","host":"127.0.0.1","port":5005,"sourcePaths":["examples/java"]}}
{"tool":"set_breakpoint","arguments":{"sessionId":"<id>","file":"examples/java/Calculator.java","line":6}}
{"tool":"continue_execution","arguments":{"sessionId":"<id>"}}
{"tool":"wait_for_breakpoint","arguments":{"sessionId":"<id>","timeoutMs":30000}}
{"tool":"get_runtime_snapshot","arguments":{"sessionId":"<id>","profile":"focused"}}
{"tool":"disconnect","arguments":{"sessionId":"<id>"}}
```

CLI equivalent:

```bash
breakpilot attach --lang java --host 127.0.0.1 --port 5005 --pretty
breakpilot bp set --session <id> --file examples/java/Calculator.java --line 6 --pretty
breakpilot continue --session <id> --pretty
breakpilot wait --session <id> --timeout 30000 --pretty
breakpilot snapshot --session <id> --profile focused --pretty
```

With `suspend=y` the JVM waits until a debugger attaches, so you must
`continue_execution` after attaching to let it run to the breakpoint.

## Notes

- The bridge is compiled on first use into `dist/.../java/out/` (recompiled when
  the source changes). Set `BREAKPILOT_JDI_BRIDGE_DIR` to override its location.
- Use `list_supported_languages` to confirm Java is available (it probes for `javac`).
