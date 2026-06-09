#!/usr/bin/env node
import { runCli, output } from "../dist/src/cli/main.js";

runCli().catch((error) => {
  const typedError = error;
  output({ ok: false, error: { message: typedError.message, stack: typedError.stack } }, true);
  process.exit(1);
});
