/**
 * Framework-agnostic argument helpers retained after the yargs migration.
 *
 * The hand-written-parser helpers (`parseFlags`, `stringFlag`, `stringArrayFlag`
 * and the `CliFlags`/`CliFlagValue` types) were removed once every command was
 * migrated to yargs command modules; only these small value-coercion helpers,
 * which the command handlers still reuse, remain.
 */

/** A raw flag value as produced by yargs (or absent). */
type FlagValue = string | boolean | number | string[] | undefined;

/**
 * Coerce a flag value to a finite number, or `undefined` when absent, an array,
 * or not a valid number. Mirrors the pre-migration `numberOrUndefined` behavior.
 */
export function parseNumber(value: FlagValue): number | undefined {
  if (value === undefined || Array.isArray(value)) return undefined;
  const parsed = Number(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * Split a space-separated flag value into a string array. Arrays pass through
 * unchanged; falsy values yield an empty array.
 */
export function splitArgs(value: FlagValue): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  return String(value).split(" ").filter(Boolean);
}

/**
 * Like {@link splitArgs} but returns `undefined` instead of an empty array,
 * preserving the optional-list semantics expected by the control plane.
 */
export function optionalSplitArgs(value: FlagValue): string[] | undefined {
  const args = splitArgs(value);
  return args.length > 0 ? args : undefined;
}
