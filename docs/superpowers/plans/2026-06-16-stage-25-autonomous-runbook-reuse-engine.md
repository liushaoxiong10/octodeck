# Stage 25 Autonomous Runbook Reuse Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Use archived incident knowledge to recommend safe, auditable runbook reuse for current issue runs.

**Architecture:** Add a pure `src/runbook-reuse.ts` matcher that compares the current `IncidentKnowledgeEntry` against archived incident knowledge entries derived from run events. Expose read-only recommendation and idempotent apply APIs through issue run routes, record `runbook_reuse_applied` as an audit event, map runbook reuse into Orchestration Control, and add a compact Issue Detail panel under Incident Knowledge.

**Tech Stack:** TypeScript, Hono routes, Vitest, Zustand, React, existing issue run events, Incident Knowledge, Orchestration Control.

---

## File Structure

- Create `src/runbook-reuse.ts`: pure deterministic recommendation engine. No DB or network access.
- Create `tests/runbook-reuse.test.ts`: unit tests for matching and action recommendation rules.
- Create `tests/runbook-reuse-routes.test.ts`: route tests for GET/apply behavior and idempotent audit events.
- Modify `src/routes/issues.ts`: derive archived incidents from run events, build current incident knowledge, expose runbook reuse APIs.
- Modify `src/orchestration-control.ts`: add runbook event types, map `runbook_reuse_applied`, update summary buckets.
- Modify `tests/orchestration-control.test.ts`: add runbook reuse timeline/summary assertions.
- Modify `web/src/stores/issues.ts`: add runbook reuse frontend types, cache, actions, and issue deletion cleanup.
- Modify `web/src/pages/IssueDetailPage.tsx`: add `RunbookReusePanel` below `RunIncidentKnowledgePanel` in both run detail locations.
- Modify `web/src/stores/orchestration.ts`: add frontend runbook event type union members.
- Modify `web/src/pages/OrchestrationPage.tsx`: add runbook event tone/icon/label mappings.
- Modify `tests/frontend-agents-module.test.ts`: static assertions for store symbols, panel symbols, and orchestration mappings.

---

### Task 1: Runbook Reuse pure recommendation engine

**Files:**
- Create: `src/runbook-reuse.ts`
- Test: `tests/runbook-reuse.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/runbook-reuse.test.ts` with these tests:

```ts
import { describe, expect, test } from 'vitest';

import { buildRunbookReuse, type RunbookReuseInput } from '../src/runbook-reuse.js';
import type { IncidentKnowledgeEntry } from '../src/incident-knowledge.js';

function incident(partial: Partial<IncidentKnowledgeEntry> & { fingerprint: string; title?: string }): IncidentKnowledgeEntry {
  return {
    id: partial.id ?? partial.fingerprint,
    issueId: partial.issueId ?? 'iss_1',
    runId: partial.runId ?? 'run_1',
    title: partial.title ?? 'checkout 500s',
    fingerprint: partial.fingerprint,
    severity: partial.severity ?? 'high',
    status: partial.status ?? 'open',
    symptoms: partial.symptoms ?? ['checkout 500s'],
    suspectedRootCauses: partial.suspectedRootCauses ?? [],
    remediationActions: partial.remediationActions ?? [],
    verificationSignals: partial.verificationSignals ?? [],
    preventionChecklist: partial.preventionChecklist ?? ['Verify recovery'],
    relatedEvents: partial.relatedEvents ?? [],
    createdAt: partial.createdAt ?? '2026-06-16T00:00:00.000Z',
    updatedAt: partial.updatedAt ?? '2026-06-16T00:01:00.000Z',
  };
}

function build(input: Partial<RunbookReuseInput>) {
  return buildRunbookReuse({
    issueId: 'iss_current',
    runId: 'run_current',
    currentIncident: input.currentIncident ?? null,
    archivedIncidents: input.archivedIncidents ?? [],
  });
}

describe('runbook reuse builder', () => {
  test('returns no recommendation without a current incident', () => {
    const result = build({ currentIncident: null, archivedIncidents: [incident({ fingerprint: 'ik_high_checkout-500s' })] });

    expect(result.recommendation).toBeNull();
    expect(result.matches).toEqual([]);
    expect(result.checklist[0]).toMatchObject({ id: 'current_incident', status: 'blocked' });
  });

  test('returns no recommendation when no archived incidents exist', () => {
    const result = build({ currentIncident: incident({ fingerprint: 'ik_high_checkout-500s' }), archivedIncidents: [] });

    expect(result.recommendation).toBeNull();
    expect(result.matches).toEqual([]);
  });

  test('same fingerprint recommends reusing remediation actions', () => {
    const historical = incident({
      fingerprint: 'ik_high_checkout-500s',
      status: 'resolved',
      remediationActions: [{ action: 'spawn_fix_run', summary: 'Patch checkout null guard', observedAt: '2026-06-16T00:02:00.000Z' }],
      verificationSignals: [{ eventType: 'production_recovered', summary: 'healthy again', observedAt: '2026-06-16T00:03:00.000Z' }],
    });

    const result = build({ currentIncident: incident({ fingerprint: 'ik_high_checkout-500s' }), archivedIncidents: [historical] });

    expect(result.recommendation).toMatchObject({
      status: 'reuse_recommended',
      action: 'reuse_remediation_actions',
      confidence: 'high',
      approvalRequired: false,
    });
    expect(result.matches[0]).toMatchObject({ fingerprint: 'ik_high_checkout-500s', score: 100 });
    expect(result.reusableActions).toEqual([expect.objectContaining({ action: 'spawn_fix_run' })]);
  });

  test('critical rollback incidents require approval', () => {
    const result = build({
      currentIncident: incident({ fingerprint: 'ik_critical_error-budget', severity: 'critical', symptoms: ['error budget exhausted'] }),
      archivedIncidents: [incident({
        fingerprint: 'ik_critical_error-budget',
        severity: 'critical',
        status: 'resolved',
        symptoms: ['error budget exhausted'],
        remediationActions: [{ action: 'request_rollback', summary: 'Rollback release', observedAt: '2026-06-16T00:02:00.000Z' }],
      })],
    });

    expect(result.recommendation).toMatchObject({
      status: 'approval_required',
      action: 'request_rollback',
      riskLevel: 'critical',
      approvalRequired: true,
    });
  });

  test('failed historical incidents are blocked from reuse', () => {
    const result = build({
      currentIncident: incident({ fingerprint: 'ik_high_checkout-500s' }),
      archivedIncidents: [incident({ fingerprint: 'ik_high_checkout-500s', status: 'failed' })],
    });

    expect(result.recommendation).toMatchObject({
      status: 'not_reusable',
      action: 'collect_more_signals',
      riskLevel: 'high',
      approvalRequired: true,
    });
    expect(result.matches[0]).toMatchObject({ reusable: false });
  });

  test('symptom overlap returns candidate found with medium confidence', () => {
    const result = build({
      currentIncident: incident({ fingerprint: 'ik_high_checkout-500s-new', symptoms: ['checkout 500s', 'payment timeout'] }),
      archivedIncidents: [incident({ fingerprint: 'ik_high_checkout-500s-old', status: 'resolved', symptoms: ['checkout 500s', 'cart failed'] })],
    });

    expect(result.recommendation).toMatchObject({
      status: 'candidate_found',
      confidence: 'medium',
      action: 'collect_more_signals',
    });
    expect(result.matches[0].rationale.join(' ')).toContain('symptom overlap');
  });
});
```

- [ ] **Step 2: Run RED**

Run:

```bash
npm test -- tests/runbook-reuse.test.ts
```

Expected: FAIL because `src/runbook-reuse.ts` does not exist.

- [ ] **Step 3: Implement the minimal pure engine**

Create `src/runbook-reuse.ts`:

```ts
import type { IncidentKnowledgeEntry } from './incident-knowledge.js';

export type RunbookReuseStatus = 'none' | 'candidate_found' | 'reuse_recommended' | 'approval_required' | 'not_reusable';
export type RunbookReuseAction = 'reuse_remediation_actions' | 'request_rollback' | 'verify_recovery' | 'spawn_fix_run' | 'collect_more_signals' | 'none';
export type RunbookReuseRiskLevel = 'low' | 'medium' | 'high' | 'critical';
export type RunbookReuseConfidence = 'low' | 'medium' | 'high';

export interface RunbookReuseInput {
  issueId: string;
  runId: string;
  currentIncident: IncidentKnowledgeEntry | null;
  archivedIncidents: IncidentKnowledgeEntry[];
}

export interface RunbookReuseMatch {
  id: string;
  issueId: string;
  runId: string;
  fingerprint: string;
  title: string;
  status: IncidentKnowledgeEntry['status'];
  severity: IncidentKnowledgeEntry['severity'];
  score: number;
  confidence: RunbookReuseConfidence;
  reusable: boolean;
  rationale: string[];
  remediationActions: IncidentKnowledgeEntry['remediationActions'];
  verificationSignals: IncidentKnowledgeEntry['verificationSignals'];
}

export interface RunbookReuseRecommendation {
  status: RunbookReuseStatus;
  action: RunbookReuseAction;
  riskLevel: RunbookReuseRiskLevel;
  confidence: RunbookReuseConfidence;
  approvalRequired: boolean;
  summary: string;
  detail: string;
  sourceFingerprint?: string;
}

export interface RunbookReuseChecklistItem {
  id: 'current_incident' | 'historical_match' | 'safety' | 'approval' | 'verification';
  label: string;
  status: 'pending' | 'ready' | 'blocked';
  detail?: string;
}

export interface RunbookReusePayload {
  recommendation: RunbookReuseRecommendation | null;
  matches: RunbookReuseMatch[];
  reusableActions: IncidentKnowledgeEntry['remediationActions'];
  checklist: RunbookReuseChecklistItem[];
}

function words(values: string[]): Set<string> {
  return new Set(values.join(' ').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, ' ').split(/\s+/).filter((item) => item.length >= 3));
}

function overlapCount(a: string[], b: string[]): number {
  const left = words(a);
  const right = words(b);
  let count = 0;
  for (const item of left) if (right.has(item)) count += 1;
  return count;
}

function confidence(score: number): RunbookReuseConfidence {
  if (score >= 80) return 'high';
  if (score >= 45) return 'medium';
  return 'low';
}

function scoreMatch(current: IncidentKnowledgeEntry, archived: IncidentKnowledgeEntry): RunbookReuseMatch {
  const rationale: string[] = [];
  let score = 0;
  if (current.fingerprint === archived.fingerprint) {
    score += 70;
    rationale.push('fingerprint match');
  }
  if (current.severity === archived.severity) {
    score += 10;
    rationale.push(`same severity: ${current.severity}`);
  }
  const symptomOverlap = overlapCount(current.symptoms, archived.symptoms);
  if (symptomOverlap > 0) {
    score += Math.min(20, symptomOverlap * 10);
    rationale.push(`symptom overlap: ${symptomOverlap}`);
  }
  if (archived.remediationActions.length > 0) {
    score += 10;
    rationale.push('historical remediation actions available');
  }
  const reusable = archived.status === 'resolved' && archived.remediationActions.length > 0;
  if (!reusable && archived.status === 'failed') rationale.push('historical remediation failed');
  const boundedScore = Math.min(100, score);
  return {
    id: archived.id,
    issueId: archived.issueId,
    runId: archived.runId,
    fingerprint: archived.fingerprint,
    title: archived.title,
    status: archived.status,
    severity: archived.severity,
    score: boundedScore,
    confidence: confidence(boundedScore),
    reusable,
    rationale,
    remediationActions: archived.remediationActions,
    verificationSignals: archived.verificationSignals,
  };
}

function primaryAction(match: RunbookReuseMatch | undefined): RunbookReuseAction {
  const actions = match?.remediationActions.map((item) => item.action) ?? [];
  if (actions.includes('request_rollback')) return 'request_rollback';
  if (actions.includes('spawn_fix_run')) return 'reuse_remediation_actions';
  if (actions.length > 0) return 'reuse_remediation_actions';
  return 'collect_more_signals';
}

function checklist(currentIncident: IncidentKnowledgeEntry | null, matches: RunbookReuseMatch[], recommendation: RunbookReuseRecommendation | null): RunbookReuseChecklistItem[] {
  return [
    { id: 'current_incident', label: 'Current incident detected', status: currentIncident ? 'ready' : 'blocked', detail: currentIncident?.fingerprint ?? 'No current incident knowledge available.' },
    { id: 'historical_match', label: 'Historical runbook match', status: matches.length ? 'ready' : 'pending', detail: matches[0]?.fingerprint ?? 'No archived incident matched yet.' },
    { id: 'safety', label: 'Reuse safety check', status: recommendation?.status === 'not_reusable' ? 'blocked' : recommendation ? 'ready' : 'pending', detail: recommendation?.detail },
    { id: 'approval', label: 'Approval requirement', status: recommendation?.approvalRequired ? 'blocked' : recommendation ? 'ready' : 'pending', detail: recommendation?.approvalRequired ? 'Human approval required before applying this runbook.' : 'No extra approval required.' },
    { id: 'verification', label: 'Recovery verification', status: recommendation ? 'ready' : 'pending', detail: 'Verify production recovery after any reused action.' },
  ];
}

export function buildRunbookReuse(input: RunbookReuseInput): RunbookReusePayload {
  if (!input.currentIncident) {
    return { recommendation: null, matches: [], reusableActions: [], checklist: checklist(null, [], null) };
  }
  const matches = input.archivedIncidents
    .filter((incident) => incident.runId !== input.runId || incident.issueId !== input.issueId)
    .map((incident) => scoreMatch(input.currentIncident as IncidentKnowledgeEntry, incident))
    .filter((match) => match.score > 0)
    .sort((a, b) => b.score - a.score);
  if (!matches.length) {
    return { recommendation: null, matches: [], reusableActions: [], checklist: checklist(input.currentIncident, [], null) };
  }

  const best = matches[0];
  const action = primaryAction(best);
  const riskLevel = input.currentIncident.severity;
  const failedBest = best.status === 'failed';
  const needsApproval = riskLevel === 'critical' || action === 'request_rollback' || failedBest;
  const status: RunbookReuseStatus = failedBest
    ? 'not_reusable'
    : needsApproval
      ? 'approval_required'
      : best.reusable && best.score >= 80
        ? 'reuse_recommended'
        : 'candidate_found';
  const recommendation: RunbookReuseRecommendation = {
    status,
    action: failedBest ? 'collect_more_signals' : action,
    riskLevel,
    confidence: best.confidence,
    approvalRequired: needsApproval,
    summary: failedBest ? 'Similar historical incident failed remediation; collect more signals before reuse.' : `Matched historical runbook ${best.fingerprint}`,
    detail: best.rationale.join(' · '),
    sourceFingerprint: best.fingerprint,
  };
  return {
    recommendation,
    matches,
    reusableActions: best.reusable ? best.remediationActions : [],
    checklist: checklist(input.currentIncident, matches, recommendation),
  };
}
```

- [ ] **Step 4: Run GREEN**

Run:

```bash
npm test -- tests/runbook-reuse.test.ts
```

Expected: PASS.

---

### Task 2: Issue run Runbook Reuse routes

**Files:**
- Modify: `src/routes/issues.ts`
- Test: `tests/runbook-reuse-routes.test.ts`

- [ ] **Step 1: Write failing route tests**

Create `tests/runbook-reuse-routes.test.ts` following the existing route test style in `tests/incident-knowledge-routes.test.ts`. Cover:

- `GET /api/issues/:id/runs/:runId/runbook-reuse` returns recommendation using archived incident knowledge from previous runs.
- `GET` is read-only and does not create `runbook_reuse_applied` events.
- `POST /api/issues/:id/runs/:runId/runbook-reuse/apply` records exactly one `runbook_reuse_applied` event.
- no current incident returns `{ runbookReuse: { recommendation: null, matches: [] } }`.

Use this assertion shape in the tests:

```ts
expect(body.runbookReuse.recommendation.status).toBe('reuse_recommended');
expect(body.runbookReuse.matches[0].fingerprint).toBe('ik_high_checkout-500s');
expect(events.filter((event) => event.event_type === 'runbook_reuse_applied')).toHaveLength(1);
```

- [ ] **Step 2: Run RED**

Run:

```bash
npm test -- tests/runbook-reuse-routes.test.ts
```

Expected: FAIL because runbook reuse routes do not exist.

- [ ] **Step 3: Implement route helpers and routes**

In `src/routes/issues.ts`:

1. Import the builder:

```ts
import { buildRunbookReuse, type RunbookReusePayload } from '../runbook-reuse.js';
```

2. Add helper functions near `buildIssueRunIncidentKnowledgePayload`:

```ts
function archivedIncidentKnowledgeEntriesForIssue(issueId: string, currentRunId: string) {
  return listIssueAgentRuns(issueId).flatMap((run) => {
    if (run.id === currentRunId) return [];
    return incidentKnowledgeEventsFromRunEvents(run.id).flatMap((event) => {
      if (event.eventType !== 'incident_knowledge_archived') return [];
      const payload = event.payload && typeof event.payload === 'object' ? event.payload : null;
      const direct = payload?.incidentKnowledge;
      const nested = payload?.incidentKnowledge && typeof payload.incidentKnowledge === 'object'
        ? (payload.incidentKnowledge as Record<string, unknown>).incidentKnowledge
        : null;
      const entry = direct && typeof direct === 'object' && 'fingerprint' in direct
        ? direct
        : nested;
      return entry && typeof entry === 'object' ? [entry as IncidentKnowledgeEntry] : [];
    });
  });
}

function buildIssueRunRunbookReusePayload(issue: WorkspaceIssue, run: IssueAgentRun): { runbookReuse: RunbookReusePayload } {
  const currentIncident = buildIssueRunIncidentKnowledgePayload(run).incidentKnowledge;
  const archivedIncidents = archivedIncidentKnowledgeEntriesForIssue(issue.id, run.id);
  return {
    runbookReuse: buildRunbookReuse({
      issueId: issue.id,
      runId: run.id,
      currentIncident,
      archivedIncidents,
    }),
  };
}
```

3. Add GET route:

```ts
issueRoutes.get('/:id/runs/:runId/runbook-reuse', authMiddleware, async (c) => {
  const user = c.get('user');
  const issue = getIssue(c.req.param('id'));
  if (!issue) return c.json({ error: 'Issue not found' }, 404);
  if (!ensureIssueAccess(issue, user)) return c.json({ error: 'Forbidden' }, 403);
  const run = listIssueAgentRuns(issue.id).find((item) => item.id === c.req.param('runId'));
  if (!run) return c.json({ error: 'Run not found' }, 404);
  return c.json(buildIssueRunRunbookReusePayload(issue, run));
});
```

4. Add apply route:

```ts
issueRoutes.post('/:id/runs/:runId/runbook-reuse/apply', authMiddleware, async (c) => {
  const user = c.get('user');
  const issue = getIssue(c.req.param('id'));
  if (!issue) return c.json({ error: 'Issue not found' }, 404);
  if (!ensureIssueAccess(issue, user)) return c.json({ error: 'Forbidden' }, 403);
  const run = listIssueAgentRuns(issue.id).find((item) => item.id === c.req.param('runId'));
  if (!run) return c.json({ error: 'Run not found' }, 404);
  const payload = buildIssueRunRunbookReusePayload(issue, run);
  if (payload.runbookReuse.recommendation) {
    recordIssueRunDeliveryEventOnce(
      issue.id,
      run.id,
      'runbook_reuse_applied',
      'Runbook reuse applied',
      payload.runbookReuse.recommendation.summary,
      payload.runbookReuse.recommendation.detail,
      payload as unknown as Record<string, unknown>,
    );
  }
  return c.json(buildIssueRunRunbookReusePayload(issue, run));
});
```

- [ ] **Step 4: Run GREEN**

Run:

```bash
npm test -- tests/runbook-reuse-routes.test.ts
```

Expected: PASS.

---

### Task 3: Orchestration Control runbook reuse timeline

**Files:**
- Modify: `src/orchestration-control.ts`
- Test: `tests/orchestration-control.test.ts`

- [ ] **Step 1: Write failing tests**

Extend `tests/orchestration-control.test.ts` with `runbook_reuse_applied` issue run event assertions:

```ts
expect(snapshot.events.some((event) => event.type === 'runbook_reuse_applied')).toBe(true);
expect(snapshot.summary.manualReview).toBeGreaterThanOrEqual(1);
```

Add separate assertion for approval-required payload:

```ts
expect(snapshot.summary.waitingApproval).toBeGreaterThanOrEqual(1);
```

- [ ] **Step 2: Run RED**

Run:

```bash
npm test -- tests/orchestration-control.test.ts
```

Expected: FAIL until runbook event mapping is added.

- [ ] **Step 3: Implement mapping**

In `src/orchestration-control.ts`:

1. Add event types:

```ts
| 'runbook_reuse_recommended'
| 'runbook_reuse_applied'
| 'runbook_reuse_blocked'
```

2. Add helper:

```ts
function runbookReuseEventType(eventType: string, payload: Record<string, unknown> | null): OrchestrationControlEventType | null {
  if (eventType !== 'runbook_reuse_applied') return null;
  const runbookReuse = asObject(payload?.runbookReuse);
  const recommendation = asObject(runbookReuse?.recommendation);
  if (recommendation?.status === 'not_reusable') return 'runbook_reuse_blocked';
  if (recommendation?.approvalRequired === true) return 'runbook_reuse_recommended';
  return 'runbook_reuse_applied';
}
```

3. Include it in the issue run event mapping chain after incident mapping:

```ts
const payload = asObject(event.payload);
const type = deliveryEventType(event.event_type)
  ?? releaseEventType(event.event_type)
  ?? productionEventType(event.event_type)
  ?? remediationEventType(event.event_type)
  ?? incidentKnowledgeEventType(event.event_type, payload)
  ?? runbookReuseEventType(event.event_type, payload);
```

4. Update `countSummary`:

```ts
waitingApproval: events.filter((event) => event.type === 'approval_requested' || event.type === 'remediation_waiting_approval' || event.type === 'runbook_reuse_recommended' && event.payload && asObject(asObject(event.payload)?.runbookReuse)?.recommendation && asObject(asObject(asObject(event.payload)?.runbookReuse)?.recommendation)?.approvalRequired === true).length,
blocked: events.filter((event) => /* existing */ || event.type === 'runbook_reuse_blocked').length,
manualReview: events.filter((event) => event.type === 'manual_review' || event.type === 'runbook_reuse_recommended' || event.type === 'runbook_reuse_applied').length,
```

Keep the expression readable by extracting a `runbookApprovalRequired(event)` helper if needed.

- [ ] **Step 4: Run GREEN**

Run:

```bash
npm test -- tests/orchestration-control.test.ts
```

Expected: PASS.

---

### Task 4: Frontend Runbook Reuse store and panel

**Files:**
- Modify: `web/src/stores/issues.ts`
- Modify: `web/src/pages/IssueDetailPage.tsx`
- Modify: `web/src/stores/orchestration.ts`
- Modify: `web/src/pages/OrchestrationPage.tsx`
- Test: `tests/frontend-agents-module.test.ts`

- [ ] **Step 1: Write failing static tests**

Extend `tests/frontend-agents-module.test.ts` with assertions:

```ts
expect(issueStore).toContain('IssueRunRunbookReuseDraft');
expect(issueStore).toContain('runbookReuseByRun');
expect(issueStore).toContain('loadIssueRunRunbookReuse');
expect(issueStore).toContain('applyIssueRunRunbookReuse');
expect(issueDetail).toContain('Runbook Reuse Engine');
expect(issueDetail).toContain('RunbookReusePanel');
expect(orchestrationStore).toContain("'runbook_reuse_applied'");
expect(orchestrationPage).toContain('runbook_reuse_applied');
```

- [ ] **Step 2: Run RED**

Run:

```bash
npm test -- tests/frontend-agents-module.test.ts
```

Expected: FAIL until frontend symbols exist.

- [ ] **Step 3: Implement store and panel**

In `web/src/stores/issues.ts`:

1. Add types:

```ts
export type IssueRunRunbookReuseStatus = 'none' | 'candidate_found' | 'reuse_recommended' | 'approval_required' | 'not_reusable';
export type IssueRunRunbookReuseAction = 'reuse_remediation_actions' | 'request_rollback' | 'verify_recovery' | 'spawn_fix_run' | 'collect_more_signals' | 'none';

export interface IssueRunRunbookReuseDraft {
  runbookReuse: {
    recommendation: {
      status: IssueRunRunbookReuseStatus;
      action: IssueRunRunbookReuseAction;
      riskLevel: 'low' | 'medium' | 'high' | 'critical';
      confidence: 'low' | 'medium' | 'high';
      approvalRequired: boolean;
      summary: string;
      detail: string;
      sourceFingerprint?: string;
    } | null;
    matches: Array<{
      id: string;
      issueId: string;
      runId: string;
      fingerprint: string;
      title: string;
      score: number;
      confidence: 'low' | 'medium' | 'high';
      reusable: boolean;
      rationale: string[];
      remediationActions: IssueRunIncidentKnowledgeRemediationAction[];
      verificationSignals: IssueRunIncidentKnowledgeVerificationSignal[];
    }>;
    reusableActions: IssueRunIncidentKnowledgeRemediationAction[];
    checklist: Array<{ id: string; label: string; status: 'pending' | 'ready' | 'blocked'; detail?: string }>;
  };
}
```

2. Add state/actions:

```ts
runbookReuseByRun: Record<string, IssueRunRunbookReuseDraft | null>;
loadIssueRunRunbookReuse: (issueId: string, runId: string) => Promise<IssueRunRunbookReuseDraft | null>;
applyIssueRunRunbookReuse: (issueId: string, runId: string) => Promise<IssueRunRunbookReuseDraft | null>;
```

3. Implement actions:

```ts
loadIssueRunRunbookReuse: async (issueId, runId) => {
  try {
    const data = await api.get<IssueRunRunbookReuseDraft>(
      `/api/issues/${encodeURIComponent(issueId)}/runs/${encodeURIComponent(runId)}/runbook-reuse`,
    );
    set((state) => ({ runbookReuseByRun: { ...state.runbookReuseByRun, [runId]: data } }));
    return data;
  } catch (err) {
    set({ error: err instanceof Error ? err.message : String(err) });
    return null;
  }
},
applyIssueRunRunbookReuse: async (issueId, runId) => {
  try {
    const data = await api.post<IssueRunRunbookReuseDraft>(
      `/api/issues/${encodeURIComponent(issueId)}/runs/${encodeURIComponent(runId)}/runbook-reuse/apply`,
      {},
    );
    set((state) => ({ runbookReuseByRun: { ...state.runbookReuseByRun, [runId]: data } }));
    await get().loadIssueEvents(issueId);
    await get().loadIssueRunEvents(issueId, runId);
    return data;
  } catch (err) {
    set({ error: err instanceof Error ? err.message : String(err) });
    return null;
  }
},
```

4. Cleanup `runbookReuseByRun` on issue deletion exactly like `runIncidentKnowledgeByRun`.

In `web/src/pages/IssueDetailPage.tsx`:

1. Import `IssueRunRunbookReuseDraft`.
2. Add `RunbookReusePanel` below `RunIncidentKnowledgePanel`.
3. Display recommendation status/action/risk/confidence, approval badge, matches, reusable actions, checklist, Load and Apply buttons.
4. Add auto-load effect for completed selected run.
5. Render panel in both duplicated run panel locations.

In orchestration frontend files add `runbook_reuse_recommended`, `runbook_reuse_applied`, `runbook_reuse_blocked` type/tone/icon/label mappings.

- [ ] **Step 4: Run GREEN**

Run:

```bash
npm test -- tests/frontend-agents-module.test.ts
```

Expected: PASS.

---

### Task 5: Final verification and review

**Files:**
- All Stage 25 files above.

- [ ] **Step 1: Run targeted tests**

Run:

```bash
npm test -- tests/runbook-reuse.test.ts tests/runbook-reuse-routes.test.ts tests/orchestration-control.test.ts tests/frontend-agents-module.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run typecheck and builds**

Run:

```bash
npm run typecheck && npm run build && npm run build:web
```

Expected: PASS. Existing Vite chunk-size warnings are acceptable.

- [ ] **Step 3: Request code review**

Dispatch a code review agent for Stage 25 changes. Fix all Critical and Important findings, then re-run the targeted tests and typecheck/build commands.

---

## Self-review

- Spec coverage: pure runbook matcher, API routes, orchestration timeline, frontend panel, tests, and final review are covered.
- Placeholder scan: no TBD/TODO/later placeholders remain.
- Type consistency: backend uses `runbookReuse`; source event uses `runbook_reuse_applied`; orchestration event types use `runbook_reuse_*`; frontend store uses `IssueRunRunbookReuseDraft` and `runbookReuseByRun`.
- Scope check: first version is deterministic and event-sourced; no new DB table, vector search, or automatic rollback execution is included.
