# Differential Fixture Provenance

`hello-controller.json` is a deterministic semantic regression fixture. It
keeps the canonical stop line, IDEA frame presentation, and provider-independent
values used by the Task 5 contract test.

It is not cryptographic proof of a raw capture. The original IDEA and BreakPilot
responses were not retained, and the historical capture commands, exact tool
versions, timestamps, and raw-response hashes are unavailable. Replaying the
test proves only that the checked-in semantic oracle has not changed; it cannot
independently verify the origin of those values. Do not add reconstructed commit
IDs, versions, timestamps, transcripts, or hashes to this fixture.

## Future capture and replay

Use the following procedure for the next live differential evidence set:

1. Create a new evidence directory and record the exact source revisions and
   command-line runtime versions before starting either debugger:

   ```bash
   export JAVA_PROJECT=/absolute/path/to/simple-springboot-demo
   export CAPTURE_DIR=/secure/path/to/breakpilot-differential-YYYYMMDDTHHMMSSZ
   mkdir -p "$CAPTURE_DIR/raw" "$CAPTURE_DIR/sanitized"
   git rev-parse HEAD > "$CAPTURE_DIR/breakpilot.commit"
   git -C "$JAVA_PROJECT" rev-parse HEAD > "$CAPTURE_DIR/application.commit"
   node --version > "$CAPTURE_DIR/node.version"
   java -version 2> "$CAPTURE_DIR/java.version"
   gradle --version > "$CAPTURE_DIR/gradle.version"
   ```

   Also record the IDEA build, plugin build, OS, exact application launch
   command, and exact application request in `manifest.md`. Do not infer any
   value after the run.

2. From a clean application process, use IDEA native MCP and BreakPilot MCP to
   stop the same request at `HelloController.java:24`. Save each exact tool
   request and unmodified response as `raw/idea.json` and
   `raw/breakpilot.json`. Record failures and retries instead of overwriting
   them.

3. Hash the raw files immediately, before sanitization or manual inspection:

   ```bash
   (cd "$CAPTURE_DIR" && shasum -a 256 raw/idea.json raw/breakpilot.json > SHA256SUMS)
   ```

   Retain the raw files in approved secure evidence storage. If retention is
   not permitted, label the resulting fixture as non-proving, as this fixture
   is labeled now.

4. Add and run a versioned sanitizer/normalizer. It must remove secrets,
   machine-specific absolute paths, and volatile IDs while preserving raw
   provider field structure, ordered BreakPilot paths, stop positions, and
   semantic values. Record the sanitizer revision and exact command in
   `manifest.md`; hash the sanitized outputs separately. Never replace missing
   provenance with guessed metadata.

5. Review the sanitized artifacts for secrets, update
   `hello-controller.json` only from those artifacts, and retain a field mapping
   from each fixture value to its sanitized source. Verify hashes, then replay
   the deterministic semantic contract:

   ```bash
   (cd "$CAPTURE_DIR" && shasum -a 256 -c SHA256SUMS)
   node --experimental-strip-types test/differential-debug-contract.test.ts
   ```

6. A future claim of independently repeatable capture evidence requires the
   retained raw responses, their hashes, the manifest, the versioned sanitizer,
   and a fresh live rerun. The semantic test alone is not that claim.
