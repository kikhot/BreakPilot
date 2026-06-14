#!/usr/bin/env -S node --experimental-strip-types
import { runCli } from "./cli/main.ts";

if (import.meta.url === `file://${process.argv[1]}`) {
  runCli(["serve", ...process.argv.slice(2)]).catch((error: unknown) => {
    const typedError = error as Error;
    process.stderr.write(`${typedError.stack || typedError.message}\n`);
    process.exit(1);
  });
}
