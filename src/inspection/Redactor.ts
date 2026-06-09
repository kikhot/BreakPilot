export class Redactor {
  patterns: RegExp[];

  constructor(patterns: string[] = []) {
    this.patterns = patterns.map((pattern) => new RegExp(String(pattern), "i"));
  }

  shouldRedact(name: string): boolean {
    return this.patterns.some((pattern) => pattern.test(String(name || "")));
  }

  redact(value: unknown = "[REDACTED]"): "[REDACTED]" {
    if (typeof value === "string") return "[REDACTED]";
    return value === undefined ? "[REDACTED]" : "[REDACTED]";
  }
}
