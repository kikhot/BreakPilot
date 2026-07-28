# Differential Evidence

`hello-controller.json` is retained only as the historical deterministic
semantic baseline. It is not raw-capture proof.

The executable offline bundle is `test/fixtures/evidence/differential-v1`.
Its manifest says `rawRetention:"unavailable"`, so successful replay proves
sanitized transcript integrity, lineage, and semantic consistency, not a live
IDEA capture. Verify it with:

```bash
npm run evidence:differential:verify -- \
  --evidence-dir "$PWD/test/fixtures/evidence/differential-v1"
```

Live raw evidence must be written only below the ignored directory
`.breakpilot/evidence/differential/<runId>/`. Use an absolute ignored config:

```bash
npm run test:e2e:idea-differential -- \
  --config /absolute/ignored/differential-config.json
```

The command exits non-zero with `EVIDENCE_INFRASTRUCTURE_UNAVAILABLE` when the
native IDEA MCP command, BreakPilot MCP command, current source marker, bridge,
or paused session is unavailable. It never promotes the synthetic fixture to a
live success. Raw SHA-256 digests prove file integrity, not independent origin;
the manifest, provider-local session identities, and lineage carry that context.
