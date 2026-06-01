# Codex Native Session Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable Codex custom/device backends to use `codex exec resume <sessionId> <prompt>` instead of OctoDeck `<system_context>` history injection.

**Architecture:** Add a generic `resumeArgvTemplate` to custom backend definitions. Dynamic backends render this full argv template when a native session id exists; existing append-style `sessionArgvTemplate` remains for Claude Code and TraeCLI.

**Tech Stack:** TypeScript, Bun, Vitest, OctoDeck backend registry/custom backend loader.

---

### Task 1: Add full resume argv template support

**Files:**
- Modify: `src/backends/dynamic.ts`
- Modify: `src/backends/validation.ts`
- Modify: `src/backends/custom-loader.ts`
- Test: `tests/agent-backend-device.test.ts`

- [ ] Add `resumeArgvTemplate?: string[]` to `CustomBackendDef`.
- [ ] Add validation for `resumeArgvTemplate` that requires `{prompt}` and `{sessionId}` when present.
- [ ] In `buildDynamicBackend`, when `supportsNativeSessions === true`, `ctx.sessionId` exists, and `resumeArgvTemplate` exists, render `resumeArgvTemplate` instead of `argvTemplate`.
- [ ] Add a Vitest test proving full-template resume replaces argv rather than appending.

### Task 2: Switch Codex adapter to native sessions

**Files:**
- Modify: `src/backends/agent-client-adapter.ts`
- Test: `tests/agent-client-adapter.test.ts`

- [ ] Extend the template return type to include `resumeArgvTemplate`.
- [ ] Set Codex `supportsNativeSessions: true`.
- [ ] Configure Codex `resumeArgvTemplate` as `['exec', 'resume', '--skip-git-repo-check', '-m', '{model}', '{sessionId}', '{prompt}']`.
- [ ] Add tests for Codex native session fields.

### Task 3: Verify behavior

**Files:**
- Test: `tests/agent-backend-device.test.ts`
- Test: `tests/agent-client-adapter.test.ts`

- [ ] Run targeted tests: `npx vitest run tests/agent-backend-device.test.ts tests/agent-client-adapter.test.ts`.
- [ ] Run broader backend/session tests: `npx vitest run tests/backend-session-policy.test.ts tests/host-cli-driver-stream-json.test.ts tests/agent-link-run-context.test.ts`.
- [ ] Run typecheck/build command available in the repo if configured.

### Self-review

- Spec coverage: supports full Codex resume argv, preserves append-style resume, updates adapter and tests.
- Placeholder scan: no TBD/TODO placeholders.
- Type consistency: `resumeArgvTemplate` is used consistently across definition, validation, adapter, and dynamic backend rendering.
