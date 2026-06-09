#!/usr/bin/env -S node --experimental-strip-types
import { runCli, output } from "./cli/main.ts";

runCli().catch((error: unknown) => {
  const typedError = error as Error;
  output({ ok: false, error: { message: typedError.message, stack: typedError.stack } }, true);
  process.exit(1);
});
