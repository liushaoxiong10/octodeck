import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { getMetadataValue, setMetadataValue } from './db.js';

export type AgentTeamShape =
  | 'auto'
  | 'pipeline'
  | 'parallel'
  | 'leader-worker'
  | 'judge-route';
export type AgentTeamPermissionLevel = 'L0' | 'L1' | 'L2' | 'L3' | 'L4' | 'L5';
export type AgentTeamWorkspacePolicy =
  | 'none'
  | 'read-only'
  | 'sandbox'
  | 'worktree'
  | 'device';

export interface AgentTeamRolePolicy {
  permissionLevel?: AgentTeamPermissionLevel;
  workspacePolicy?: AgentTeamWorkspacePolicy;
  requiresApproval?: boolean;
}

export interface AgentTeamRoleBudget {
  maxDurationMs?: number;
  maxTokens?: number;
  maxOutputBytes?: number;
}

export interface AgentTeamRole {
  id: string;
  name: string;
  responsibility: string;
  /** Optional lane name. Roles sharing the same lane form an ordered parallel chain. */
  parallelGroup?: string;
  inputs?: string[];
  outputs?: string[];
  skills?: string[];
  guardrails?: string[];
  requiredSkills?: string[];
  preferredAgentMd?: string[];
  policy?: AgentTeamRolePolicy;
  budget?: AgentTeamRoleBudget;
}

export type AgentTeamWorkflowStepType = 'role' | 'parallel' | 'route' | 'verify' | 'vote';

export interface AgentTeamWorkflowApprovalPolicy {
  mode: 'single' | 'any_of' | 'all_of' | 'quorum';
  approverRoleIds: string[];
  quorum?: number;
  timeoutMs?: number;
  onTimeout?: 'reject' | 'approve' | 'fallback';
}

export interface AgentTeamWorkflowAction {
  roleId: string;
  phase?: string;
  instructions?: string;
  outputKey?: string;
}

export interface AgentTeamWorkflowFailurePolicy {
  action: 'continue' | 'abort' | 'run_role' | 'retry';
  targetRoleId?: string;
  phase?: string;
  maxIterations?: number;
  instructions?: string;
}

export interface AgentTeamWorkflowRoute {
  judgeRoleId: string;
  candidateRoleIds: string[];
  fallbackRoleId?: string;
  finalRoleId?: string;
}

export interface AgentTeamWorkflowVerify {
  verifierRoleId: string;
  subjectKeys: string[];
  rubric?: string;
}

export interface AgentTeamWorkflowVote {
  voterRoleIds: string[];
  subjectKeys: string[];
  threshold?: number;
}

export interface AgentTeamWorkflowStep {
  id: string;
  type: AgentTeamWorkflowStepType;
  roleId?: string;
  phase?: string;
  instructions?: string;
  inputKeys?: string[];
  outputKey?: string;
  dependsOn?: string[];
  parallel?: AgentTeamWorkflowAction[][];
  route?: AgentTeamWorkflowRoute;
  verify?: AgentTeamWorkflowVerify;
  vote?: AgentTeamWorkflowVote;
  approvalPolicy?: AgentTeamWorkflowApprovalPolicy;
  onFailure?: AgentTeamWorkflowFailurePolicy;
}

export interface AgentTeam {
  id: string;
  name: string;
  goal: string;
  shape: AgentTeamShape;
  description: string;
  roles: AgentTeamRole[];
  workflow: string;
  workflowSteps?: AgentTeamWorkflowStep[];
  successCriteria: string[];
  createdByAgentId: string;
  createdByUserId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AgentMdDefinition {
  id: string;
  name: string;
  summary: string;
  content: string;
  createdByAgentId: string;
  createdByUserId?: string;
  /** agent.md definitions generated as part of an Agent Team carry this marker. */
  createdByTeamId?: string;
  createdByTeamName?: string;
  createdAt: string;
  updatedAt: string;
}

export type AgentMdReferenceKind = 'team' | 'agent';

export interface AgentMdReference {
  kind: AgentMdReferenceKind;
  id: string;
  name: string;
  detail?: string;
}

export interface AgentMdSummary {
  id: string;
  name: string;
  summary: string;
  content?: string;
}

export type AgentTeamInput = Omit<AgentTeam, 'id' | 'createdAt' | 'updatedAt'>;
export type AgentTeamPatch = Partial<AgentTeamInput>;
export type AgentMdDefinitionInput = Omit<
  AgentMdDefinition,
  'id' | 'createdAt' | 'updatedAt'
>;
export type AgentMdDefinitionPatch = Partial<AgentMdDefinitionInput>;

export interface AgentTeamGenerationResult {
  draft: AgentTeamInput;
  agentMdDefinitionsToCreate: Omit<
    AgentMdDefinitionInput,
    'createdByAgentId'
  >[];
}

export interface AgentTeamDraftInput {
  generatorAgentId: string;
  goal: string;
  shape: AgentTeamShape;
}

interface StoredAgentTeamsFile {
  version: 1;
  teams: AgentTeam[];
  updatedAt: string;
}

interface StoredAgentMdDefinitionsFile {
  version: 1;
  definitions: AgentMdDefinition[];
  updatedAt: string;
}

const AGENT_TEAMS_FILE = path.join(DATA_DIR, 'config', 'agent-teams.json');
const AGENT_MD_FILE = path.join(
  DATA_DIR,
  'config',
  'agent-md-definitions.json',
);
const AGENT_TEAMS_METADATA_KEY = 'agent_teams';
const AGENT_MD_METADATA_KEY = 'agent_md_definitions';
const AGENCY_AGENTS_REPO_OWNER = 'msitarzewski';
const AGENCY_AGENTS_REPO_NAME = 'agency-agents';
const AGENCY_AGENTS_BRANCH = 'main';
const AGENCY_AGENTS_RAW_BASE_URL = `https://raw.githubusercontent.com/${AGENCY_AGENTS_REPO_OWNER}/${AGENCY_AGENTS_REPO_NAME}/${AGENCY_AGENTS_BRANCH}`;
const AGENCY_AGENTS_CATEGORIES = new Set([
  'academic',
  'design',
  'engineering',
  'finance',
  'game-development',
  'marketing',
  'paid-media',
  'product',
  'project-management',
  'sales',
  'security',
  'spatial-computing',
  'specialized',
  'support',
  'testing',
]);

function ensureDir(filePath = AGENT_TEAMS_FILE): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function nowIso(): string {
  return new Date().toISOString();
}

function makeTeamId(): string {
  return `team_${crypto.randomBytes(6).toString('hex')}`;
}

function makeAgentMdId(): string {
  return `agent_md_${crypto.randomBytes(6).toString('hex')}`;
}

function sanitizeLines(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return values
    .map((value) => String(value).trim())
    .filter(Boolean)
    .slice(0, 12);
}

function normalizeRolePolicy(
  policy: AgentTeamRole['policy'],
): AgentTeamRolePolicy | undefined {
  if (!policy || typeof policy !== 'object') return undefined;
  const normalized: AgentTeamRolePolicy = {};
  if (
    ['L0', 'L1', 'L2', 'L3', 'L4', 'L5'].includes(
      String(policy.permissionLevel),
    )
  ) {
    normalized.permissionLevel = policy.permissionLevel;
  }
  if (
    ['none', 'read-only', 'sandbox', 'worktree', 'device'].includes(
      String(policy.workspacePolicy),
    )
  ) {
    normalized.workspacePolicy = policy.workspacePolicy;
  }
  if (typeof policy.requiresApproval === 'boolean')
    normalized.requiresApproval = policy.requiresApproval;
  return Object.keys(normalized).length ? normalized : undefined;
}

function normalizeRoleBudget(
  budget: AgentTeamRole['budget'],
): AgentTeamRoleBudget | undefined {
  if (!budget || typeof budget !== 'object') return undefined;
  const normalized: AgentTeamRoleBudget = {};
  if (Number.isFinite(budget.maxDurationMs) && Number(budget.maxDurationMs) > 0)
    normalized.maxDurationMs = Math.trunc(Number(budget.maxDurationMs));
  if (Number.isFinite(budget.maxTokens) && Number(budget.maxTokens) > 0)
    normalized.maxTokens = Math.trunc(Number(budget.maxTokens));
  if (
    Number.isFinite(budget.maxOutputBytes) &&
    Number(budget.maxOutputBytes) > 0
  )
    normalized.maxOutputBytes = Math.trunc(Number(budget.maxOutputBytes));
  return Object.keys(normalized).length ? normalized : undefined;
}

function normalizeRole(role: AgentTeamRole, index: number): AgentTeamRole {
  return {
    id: role.id?.trim() || `role_${index + 1}`,
    name: role.name?.trim() || `Role ${index + 1}`,
    responsibility:
      role.responsibility?.trim() || '负责完成团队中的一个明确子任务。',
    parallelGroup: role.parallelGroup?.trim() || undefined,
    inputs: sanitizeLines(role.inputs),
    outputs: sanitizeLines(role.outputs),
    skills: sanitizeLines(role.skills),
    guardrails: sanitizeLines(role.guardrails),
    requiredSkills: sanitizeLines(role.requiredSkills),
    preferredAgentMd: sanitizeLines(role.preferredAgentMd),
    policy: normalizeRolePolicy(role.policy),
    budget: normalizeRoleBudget(role.budget),
  };
}

function normalizeWorkflowAction(
  action: AgentTeamWorkflowAction,
): AgentTeamWorkflowAction | null {
  const roleId = action.roleId?.trim();
  if (!roleId) return null;
  return {
    roleId,
    phase: action.phase?.trim() || undefined,
    instructions: action.instructions?.trim() || undefined,
    outputKey: action.outputKey?.trim() || undefined,
  };
}

function normalizeWorkflowSteps(
  steps: AgentTeamInput['workflowSteps'],
): AgentTeamWorkflowStep[] | undefined {
  if (!Array.isArray(steps)) return undefined;
  const normalized = steps
    .slice(0, 24)
    .map((step, index): AgentTeamWorkflowStep | null => {
      if (!step || typeof step !== 'object') return null;
      const type = step.type;
      if (!['role', 'parallel', 'route', 'verify', 'vote'].includes(String(type))) return null;
      const id = step.id?.trim() || `step_${index + 1}`;
      const onFailure = step.onFailure
        ? {
            action: ['continue', 'abort', 'run_role', 'retry'].includes(
              String(step.onFailure.action),
            )
              ? step.onFailure.action
              : 'abort',
            targetRoleId: step.onFailure.targetRoleId?.trim() || undefined,
            phase: step.onFailure.phase?.trim() || undefined,
            maxIterations:
              Number.isFinite(step.onFailure.maxIterations) &&
              Number(step.onFailure.maxIterations) > 0
                ? Math.min(5, Math.trunc(Number(step.onFailure.maxIterations)))
                : undefined,
            instructions: step.onFailure.instructions?.trim() || undefined,
          }
        : undefined;
      if (type === 'role') {
        const roleId = step.roleId?.trim();
        if (!roleId) return null;
        return {
          id,
          type,
          roleId,
          phase: step.phase?.trim() || undefined,
          instructions: step.instructions?.trim() || undefined,
          inputKeys: sanitizeLines(step.inputKeys),
          outputKey: step.outputKey?.trim() || undefined,
          dependsOn: sanitizeLines(step.dependsOn),
          onFailure,
        };
      }
      if (type === 'parallel') {
        const parallel = Array.isArray(step.parallel)
          ? step.parallel
              .slice(0, 8)
              .map((chain) =>
                Array.isArray(chain)
                  ? chain
                      .slice(0, 8)
                      .map(normalizeWorkflowAction)
                      .filter(Boolean)
                  : [],
              )
              .filter((chain) => chain.length > 0)
          : [];
        if (parallel.length === 0) return null;
        return {
          id,
          type,
          instructions: step.instructions?.trim() || undefined,
          inputKeys: sanitizeLines(step.inputKeys),
          dependsOn: sanitizeLines(step.dependsOn),
          parallel: parallel as AgentTeamWorkflowAction[][],
          onFailure,
        };
      }
      if (type === 'verify') {
        const verifierRoleId = step.verify?.verifierRoleId?.trim();
        if (!verifierRoleId) return null;
        return {
          id,
          type,
          instructions: step.instructions?.trim() || undefined,
          inputKeys: sanitizeLines(step.inputKeys),
          outputKey: step.outputKey?.trim() || undefined,
          dependsOn: sanitizeLines(step.dependsOn),
          verify: {
            verifierRoleId,
            subjectKeys: sanitizeLines(step.verify?.subjectKeys),
            rubric: step.verify?.rubric?.trim() || undefined,
          },
          onFailure,
        };
      }
      if (type === 'vote') {
        const voterRoleIds = sanitizeLines(step.vote?.voterRoleIds);
        if (voterRoleIds.length === 0) return null;
        return {
          id,
          type,
          instructions: step.instructions?.trim() || undefined,
          inputKeys: sanitizeLines(step.inputKeys),
          outputKey: step.outputKey?.trim() || undefined,
          dependsOn: sanitizeLines(step.dependsOn),
          vote: {
            voterRoleIds,
            subjectKeys: sanitizeLines(step.vote?.subjectKeys),
            threshold:
              Number.isFinite(step.vote?.threshold) && Number(step.vote?.threshold) > 0
                ? Math.min(1, Number(step.vote?.threshold))
                : undefined,
          },
          onFailure,
        };
      }
      const route = step.route;
      if (!route?.judgeRoleId?.trim()) return null;
      const candidateRoleIds = sanitizeLines(route.candidateRoleIds);
      if (candidateRoleIds.length === 0) return null;
      return {
        id,
        type,
        instructions: step.instructions?.trim() || undefined,
        inputKeys: sanitizeLines(step.inputKeys),
        dependsOn: sanitizeLines(step.dependsOn),
        route: {
          judgeRoleId: route.judgeRoleId.trim(),
          candidateRoleIds,
          fallbackRoleId: route.fallbackRoleId?.trim() || undefined,
          finalRoleId: route.finalRoleId?.trim() || undefined,
        },
        onFailure,
      };
    })
    .filter(Boolean) as AgentTeamWorkflowStep[];
  return normalized.length ? normalized : undefined;
}

function normalizeTeamInput(input: AgentTeamInput): AgentTeamInput {
  const roles = (Array.isArray(input.roles) ? input.roles : [])
    .slice(0, 12)
    .map(normalizeRole);
  if (roles.length === 0) {
    roles.push(
      normalizeRole(
        {
          id: 'lead',
          name: 'Lead',
          responsibility: '理解目标并协调团队产出。',
        },
        0,
      ),
    );
  }
  return {
    name: input.name?.trim() || 'Untitled Agent Team',
    goal: input.goal?.trim() || '未描述目标',
    shape: input.shape || 'auto',
    description: input.description?.trim() || '由 Agent 生成的抽象团队定义。',
    roles,
    workflow:
      input.workflow?.trim() || '团队按角色职责协作，并在完成后汇总结果。',
    workflowSteps: normalizeWorkflowSteps(input.workflowSteps),
    successCriteria: sanitizeLines(input.successCriteria).length
      ? sanitizeLines(input.successCriteria)
      : ['产出满足用户目标'],
    createdByAgentId: input.createdByAgentId?.trim() || 'unknown',
    createdByUserId: input.createdByUserId?.trim() || undefined,
  };
}

function normalizeAgentMdInput(
  input: AgentMdDefinitionInput,
): AgentMdDefinitionInput {
  return {
    name: input.name?.trim() || 'Untitled agent.md',
    summary: input.summary?.trim() || '未提供简介。',
    content:
      input.content?.trim() ||
      '# Untitled agent.md\n\n请在这里定义该角色的职责、工作方式和边界。',
    createdByAgentId: input.createdByAgentId?.trim() || 'unknown',
    createdByUserId: input.createdByUserId?.trim() || undefined,
    createdByTeamId: input.createdByTeamId?.trim() || undefined,
    createdByTeamName: input.createdByTeamName?.trim() || undefined,
  };
}

function requestTimeoutSignal(timeoutMs: number): AbortSignal {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), timeoutMs).unref?.();
  return controller.signal;
}

async function fetchText(url: string, timeoutMs = 15_000): Promise<string> {
  const response = await fetch(url, {
    signal: requestTimeoutSignal(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`failed to fetch ${url}: ${response.status}`);
  }
  return response.text();
}

function isAgencyAgentMarkdownPath(filePath: string): boolean {
  if (!filePath.endsWith('.md')) return false;
  const segments = filePath.split('/');
  const [category, fileName] = segments;
  if (!category || !fileName) return false;
  if (fileName.toLowerCase() === 'readme.md') return false;
  if (AGENCY_AGENTS_CATEGORIES.has(category)) return true;
  return (
    filePath === 'integrations/mcp-memory/backend-architect-with-memory.md'
  );
}

function agencyAgentRawUrl(filePath: string): string {
  return `${AGENCY_AGENTS_RAW_BASE_URL}/${filePath
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/')}`;
}

function titleFromAgentPath(filePath: string): string {
  const fileName = filePath.split('/').pop()?.replace(/\.md$/i, '') || 'agent';
  return fileName
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function parseFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  if (!match) return {};
  const result: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const item = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!item) continue;
    result[item[1]] = item[2].trim().replace(/^['"]|['"]$/g, '');
  }
  return result;
}

function firstContentSentence(content: string): string {
  return (
    content
      .replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, '')
      .split('\n')
      .map((line) => line.replace(/^#+\s*/, '').trim())
      .find(Boolean)
      ?.slice(0, 300) || '来自 agency-agents 商店的 agent.md 定义。'
  );
}

function readFile(): StoredAgentTeamsFile {
  const stored = getMetadataValue(AGENT_TEAMS_METADATA_KEY);
  if (stored) {
    try {
      const parsed = JSON.parse(stored) as StoredAgentTeamsFile;
      if (parsed.version === 1 && Array.isArray(parsed.teams)) return parsed;
    } catch {
      // Fall back to legacy file below.
    }
  }
  if (!fs.existsSync(AGENT_TEAMS_FILE)) {
    return { version: 1, teams: [], updatedAt: nowIso() };
  }
  try {
    const parsed = JSON.parse(
      fs.readFileSync(AGENT_TEAMS_FILE, 'utf-8'),
    ) as StoredAgentTeamsFile;
    if (parsed.version !== 1 || !Array.isArray(parsed.teams)) {
      return { version: 1, teams: [], updatedAt: nowIso() };
    }
    setMetadataValue(AGENT_TEAMS_METADATA_KEY, JSON.stringify(parsed));
    return parsed;
  } catch {
    return { version: 1, teams: [], updatedAt: nowIso() };
  }
}

function readAgentMdFile(): StoredAgentMdDefinitionsFile {
  const stored = getMetadataValue(AGENT_MD_METADATA_KEY);
  if (stored) {
    try {
      const parsed = JSON.parse(stored) as StoredAgentMdDefinitionsFile;
      if (parsed.version === 1 && Array.isArray(parsed.definitions))
        return parsed;
    } catch {
      // Fall back to legacy file below.
    }
  }
  if (!fs.existsSync(AGENT_MD_FILE)) {
    return { version: 1, definitions: [], updatedAt: nowIso() };
  }
  try {
    const parsed = JSON.parse(
      fs.readFileSync(AGENT_MD_FILE, 'utf-8'),
    ) as StoredAgentMdDefinitionsFile;
    if (parsed.version !== 1 || !Array.isArray(parsed.definitions)) {
      return { version: 1, definitions: [], updatedAt: nowIso() };
    }
    setMetadataValue(AGENT_MD_METADATA_KEY, JSON.stringify(parsed));
    return parsed;
  } catch {
    return { version: 1, definitions: [], updatedAt: nowIso() };
  }
}

function writeFile(teams: AgentTeam[]): void {
  ensureDir(AGENT_TEAMS_FILE);
  const payload: StoredAgentTeamsFile = {
    version: 1,
    teams,
    updatedAt: nowIso(),
  };
  setMetadataValue(AGENT_TEAMS_METADATA_KEY, JSON.stringify(payload));
  const tmp = `${AGENT_TEAMS_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', {
    mode: 0o600,
  });
  fs.renameSync(tmp, AGENT_TEAMS_FILE);
}

function writeAgentMdFile(definitions: AgentMdDefinition[]): void {
  ensureDir(AGENT_MD_FILE);
  const payload: StoredAgentMdDefinitionsFile = {
    version: 1,
    definitions,
    updatedAt: nowIso(),
  };
  setMetadataValue(AGENT_MD_METADATA_KEY, JSON.stringify(payload));
  const tmp = `${AGENT_MD_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', {
    mode: 0o600,
  });
  fs.renameSync(tmp, AGENT_MD_FILE);
}

function belongsToUser(
  item: { createdByUserId?: string },
  ownerUserId?: string,
): boolean {
  return !ownerUserId || item.createdByUserId === ownerUserId;
}

export function listAgentTeams(ownerUserId?: string): AgentTeam[] {
  return readFile()
    .teams.filter((team) => belongsToUser(team, ownerUserId))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function getAgentTeam(
  id: string,
  ownerUserId?: string,
): AgentTeam | null {
  return (
    readFile().teams.find(
      (team) => team.id === id && belongsToUser(team, ownerUserId),
    ) ?? null
  );
}

export function createAgentTeam(
  input: AgentTeamInput,
  ownerUserId?: string,
): AgentTeam {
  const data = normalizeTeamInput({
    ...input,
    createdByUserId: ownerUserId ?? input.createdByUserId,
  });
  const now = nowIso();
  const team: AgentTeam = {
    id: makeTeamId(),
    ...data,
    createdAt: now,
    updatedAt: now,
  };
  writeFile([team, ...readFile().teams]);
  return team;
}

export function updateAgentTeam(
  id: string,
  patch: AgentTeamPatch,
  ownerUserId?: string,
): AgentTeam | null {
  const file = readFile();
  const existing = file.teams.find(
    (team) => team.id === id && belongsToUser(team, ownerUserId),
  );
  if (!existing) return null;
  const nextInput = normalizeTeamInput({
    name: patch.name ?? existing.name,
    goal: patch.goal ?? existing.goal,
    shape: patch.shape ?? existing.shape,
    description: patch.description ?? existing.description,
    roles: patch.roles ?? existing.roles,
    workflow: patch.workflow ?? existing.workflow,
    workflowSteps: patch.workflowSteps ?? existing.workflowSteps,
    successCriteria: patch.successCriteria ?? existing.successCriteria,
    createdByAgentId: patch.createdByAgentId ?? existing.createdByAgentId,
    createdByUserId: existing.createdByUserId,
  });
  const updated: AgentTeam = {
    ...existing,
    ...nextInput,
    updatedAt: nowIso(),
  };
  writeFile(file.teams.map((team) => (team.id === id ? updated : team)));
  return updated;
}

export function deleteAgentTeam(id: string, ownerUserId?: string): boolean {
  const file = readFile();
  const next = file.teams.filter(
    (team) => team.id !== id || !belongsToUser(team, ownerUserId),
  );
  if (next.length === file.teams.length) return false;
  writeFile(next);
  return true;
}

export function deleteAgentTeamWithLinkedAgentMd(
  id: string,
  ownerUserId?: string,
  options: { deleteLinkedAgentMd?: boolean } = {},
): { deleted: boolean; linkedAgentMdDefinitions: AgentMdDefinition[] } {
  const teamDeleted = deleteAgentTeam(id, ownerUserId);
  if (!teamDeleted) return { deleted: false, linkedAgentMdDefinitions: [] };
  const linkedAgentMdDefinitions = listAgentMdDefinitions(ownerUserId).filter(
    (definition) => definition.createdByTeamId === id,
  );
  if (options.deleteLinkedAgentMd && linkedAgentMdDefinitions.length > 0) {
    const linkedIds = new Set(linkedAgentMdDefinitions.map((definition) => definition.id));
    const file = readAgentMdFile();
    writeAgentMdFile(
      file.definitions.filter(
        (definition) =>
          !linkedIds.has(definition.id) || !belongsToUser(definition, ownerUserId),
      ),
    );
  }
  return { deleted: true, linkedAgentMdDefinitions };
}

export function listAgentMdDefinitions(
  ownerUserId?: string,
): AgentMdDefinition[] {
  return readAgentMdFile()
    .definitions.filter((definition) => belongsToUser(definition, ownerUserId))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function listAgentMdSummaries(ownerUserId?: string): AgentMdSummary[] {
  return listAgentMdDefinitions(ownerUserId).map(({ id, name, summary }) => ({
    id,
    name,
    summary,
  }));
}

export function getAgentMdDefinition(
  id: string,
  ownerUserId?: string,
): AgentMdDefinition | null {
  return (
    readAgentMdFile().definitions.find(
      (definition) =>
        definition.id === id && belongsToUser(definition, ownerUserId),
    ) ?? null
  );
}

export function findAgentMdTeamReferences(
  id: string,
  ownerUserId?: string,
  options: { excludeTeamId?: string } = {},
): AgentMdReference[] {
  return listAgentTeams(ownerUserId).flatMap((team) => {
    if (team.id === options.excludeTeamId) return [];
    const roleNames = team.roles
      .filter((role) => role.preferredAgentMd?.includes(id))
      .map((role) => role.name);
    if (roleNames.length === 0) return [];
    return [{
      kind: 'team' as const,
      id: team.id,
      name: team.name,
      detail: `角色：${roleNames.join('、')}`,
    }];
  });
}

export function createAgentMdDefinition(
  input: AgentMdDefinitionInput,
  ownerUserId?: string,
): AgentMdDefinition {
  const data = normalizeAgentMdInput({
    ...input,
    createdByUserId: ownerUserId ?? input.createdByUserId,
  });
  const now = nowIso();
  const definition: AgentMdDefinition = {
    id: makeAgentMdId(),
    ...data,
    createdAt: now,
    updatedAt: now,
  };
  writeAgentMdFile([definition, ...readAgentMdFile().definitions]);
  return definition;
}

export function updateAgentMdDefinition(
  id: string,
  patch: AgentMdDefinitionPatch,
  ownerUserId?: string,
): AgentMdDefinition | null {
  const file = readAgentMdFile();
  const existing = file.definitions.find(
    (definition) =>
      definition.id === id && belongsToUser(definition, ownerUserId),
  );
  if (!existing) return null;
  const nextInput = normalizeAgentMdInput({
    name: patch.name ?? existing.name,
    summary: patch.summary ?? existing.summary,
    content: patch.content ?? existing.content,
    createdByAgentId: patch.createdByAgentId ?? existing.createdByAgentId,
    createdByUserId: existing.createdByUserId,
    createdByTeamId: patch.createdByTeamId ?? existing.createdByTeamId,
    createdByTeamName: patch.createdByTeamName ?? existing.createdByTeamName,
  });
  const updated: AgentMdDefinition = {
    ...existing,
    ...nextInput,
    updatedAt: nowIso(),
  };
  writeAgentMdFile(
    file.definitions.map((definition) =>
      definition.id === id ? updated : definition,
    ),
  );
  return updated;
}

export function deleteAgentMdDefinition(
  id: string,
  ownerUserId?: string,
): boolean {
  const file = readAgentMdFile();
  const next = file.definitions.filter(
    (definition) =>
      definition.id !== id || !belongsToUser(definition, ownerUserId),
  );
  if (next.length === file.definitions.length) return false;
  writeAgentMdFile(next);
  return true;
}

export async function createAgentMdDefinitionFromStore(
  filePath: string,
  createdByAgentId: string,
  ownerUserId?: string,
): Promise<AgentMdDefinition> {
  const pathToImport = filePath.trim();
  if (!isAgencyAgentMarkdownPath(pathToImport)) {
    throw new Error('unsupported agency-agents store path');
  }
  const content = await fetchText(agencyAgentRawUrl(pathToImport));
  const frontmatter = parseFrontmatter(content);
  const name = frontmatter.name || titleFromAgentPath(pathToImport);
  const summary = frontmatter.description || firstContentSentence(content);
  return createAgentMdDefinition(
    {
      name,
      summary,
      content: content.trim(),
      createdByAgentId,
    },
    ownerUserId,
  );
}

export function buildAgentTeamDraft(
  input: AgentTeamDraftInput,
): AgentTeamInput {
  const goal = input.goal.trim();
  const shape = input.shape || 'auto';
  const shapeLabel = shape === 'auto' ? 'Let AI decide' : shapeToTitle(shape);
  const roles = rolesForShape(shape);
  return normalizeTeamInput({
    name: inferTeamName(goal, shape),
    goal,
    shape,
    description: `面向“${goal}”的 ${shapeLabel} 抽象 Agent Team 定义。`,
    roles,
    workflow: workflowForShape(shape),
    workflowSteps: workflowStepsForShape(shape, roles),
    successCriteria: [
      '团队产出直接回应用户目标',
      '每个角色都有清晰输入、输出和交接边界',
      'workflowSteps 能通过 dependsOn、inputKeys 和 outputKey 追踪产物流转与恢复点',
      '验证或评审角色必须给出可执行的通过/失败标准',
      '最终交付包含结论、依据和下一步建议',
    ],
    createdByAgentId: input.generatorAgentId,
  });
}

export function buildAgentTeamGenerationPrompt(
  fallback: AgentTeamInput,
  agentMdSummaries: AgentMdSummary[] = [],
): string {
  const summaryBlock = agentMdSummaries.length
    ? agentMdSummaries
        .slice(0, 30)
        .map(
          (definition) =>
            `- ${definition.name} (${definition.id}): ${definition.summary}${
              definition.content
                ? `\n  agent.md:\n${definition.content
                    .slice(0, 4000)
                    .split('\n')
                    .map((line) => `  ${line}`)
                    .join('\n')}`
                : ''
            }`,
        )
        .join('\n')
    : '- 暂无现有 agent.md 定义。';

  return `你是 Agent Team Architect。请根据用户目标生成一个 Agent Team 定义。

这是一个单轮结构化 JSON 输出任务，不是代码执行任务、调试任务或多轮协作任务。
不要调用任何工具或 Skill，不要搜索文件，不要读取仓库，不要询问用户，不要进入 planning / brainstorming / TDD / code review 工作流。
请在一次回复内直接给出 JSON；目标耗时应为 10 秒级，而不是分钟级。

约束：
- 只输出 JSON，不要输出 markdown、解释或代码块。
- Team 只能包含抽象角色定义，不得包含具体 Agent CLI、provider、device、模型、命令或执行路径。
- shape 必须是以下之一：auto、pipeline、parallel、leader-worker、judge-route。
- 如果 Interaction shape 是 auto，team.shape 必须返回模型实际选择的具体形态：pipeline、parallel、leader-worker 或 judge-route；不要在生成结果的 team.shape 中继续返回 auto。
- roles 每项必须包含 id、name、responsibility，可选 inputs、outputs、skills、guardrails。
- 必须生成 workflowSteps；编排、测试、返工、路由、产物传递都由 workflowSteps 显式描述，不要依赖角色数量、角色名称或固定关键词。
- workflowSteps 支持：role（单角色步骤）、parallel（多条并行链）、route（由 judgeRoleId 产出路由决策）、verify（独立质量门禁）、vote（多角色投票聚合）。测试/验证失败后的返工请用 onFailure 指向目标 role，而不是要求 QA 输出固定中文短语。
- 必须把 workflowSteps 设计成合法 DAG：id 唯一；dependsOn 只能引用已存在 step；不存在循环；下游 inputKeys 必须引用上游 outputKey。
- 当任务需要独立质量门禁时，优先使用 verify step，而不是让实现角色自评。
- 当任务需要多候选方案汇总时，使用 vote step 表达投票聚合，vote step 必须声明 subjectKeys 与 outputKey。
- 必须在 description 或 workflow 中写明为什么单 Agent + Tools 不够、为什么选择当前 shape、为什么没有选择更简单或相邻 shape。
- 每个 review / verify / judge role 必须包含 rubric、失败输出格式和停止条件，避免单 Agent 自评。
- route step 的 judge 输出必须支持 JSON：{"action":"run_role|finish|request_approval|abort","target":"roleId","reason":"...","confidence":0.0}；高风险或边界不清时输出 request_approval。
- 每个角色输出应尽量结构化，至少包含 status、summary、evidence、confidence、next_actions；workflow step 的 outputKey 应与角色 outputs 对齐。
- roles 控制在 3-6 个；workflow 控制在 1200 字以内；successCriteria 控制在 3-6 条。
- 优先复用现有 agent.md：如果某个现有 agent.md 的简介能覆盖必要角色，请优先把该角色设计为匹配这个 agent.md 的能力边界。
- 复用现有 agent.md 时，在角色的 skills 或 guardrails 中写明建议使用的 agent.md 名称；不要把 agent.md id 当成具体执行绑定写入 Team role。
- 如果现有 agent.md 不满足需求：只有当现有 agent.md 无法覆盖某个必要角色时，才在 agentMdDefinitionsToCreate 中自行编写新的 agent.md 定义；否则返回空数组。
- 如果没有任何现有 agent.md 定义，必须根据目标自动生成必要的 agent.md，并放入 agentMdDefinitionsToCreate。
- 每个新 agent.md content 控制在 1200 字以内，只写角色职责、工作方式和边界，不要写安装/命令/路径/模型/provider。

用户目标：${fallback.goal}
Interaction shape：${fallback.shape}
生成器 Agent：${fallback.createdByAgentId}

现有 agent.md 简介：
${summaryBlock}

JSON 结构：
{
  "team": {
    "name": "...",
    "goal": "...",
    "shape": "${fallback.shape === 'auto' ? 'pipeline | parallel | leader-worker | judge-route' : fallback.shape}",
    "description": "...",
    "roles": [{"id":"...","name":"...","responsibility":"...","inputs":["..."],"outputs":["..."],"skills":["..."],"guardrails":["..."]}],
    "workflow": "...",
    "workflowSteps": [
      {"id":"plan","type":"role","roleId":"planner","phase":"plan","instructions":"产出计划","outputKey":"plan"},
      {"id":"build","type":"role","roleId":"builder","phase":"work","inputKeys":["plan"],"outputKey":"build"},
      {"id":"verify","type":"role","roleId":"reviewer","phase":"verify","inputKeys":["build"],"outputKey":"verification","onFailure":{"action":"run_role","targetRoleId":"builder","phase":"revise","maxIterations":1,"instructions":"根据验证反馈修正产物"}}
    ],
    "successCriteria": ["..."],
    "createdByAgentId": "${fallback.createdByAgentId}"
  },
  "agentMdDefinitionsToCreate": [
    {"name":"...","summary":"...","content":"# Role Name\\n\\n...完整 agent.md 内容..."}
  ]
}`;
}

export function isAbstractAgentTeamDefinition(team: AgentTeamInput): boolean {
  const text = JSON.stringify({
    name: team.name,
    description: team.description,
    workflow: team.workflow,
    successCriteria: team.successCriteria,
    roles: team.roles.map((role) => ({
      name: role.name,
      responsibility: role.responsibility,
      inputs: role.inputs,
      outputs: role.outputs,
      skills: role.skills,
      guardrails: role.guardrails,
    })),
  }).toLowerCase();

  const concreteBindingTokens = [
    'agentclientid',
    'devicelinkid',
    'claude-code',
    'claude code',
    'codex cli',
    'traecli',
    'provider:',
    'model:',
    'command:',
    'binary:',
    'workdir',
    'device:',
    '/users/',
    '/home/',
  ];

  return !concreteBindingTokens.some((token) => text.includes(token));
}

function inferTeamName(goal: string, shape: AgentTeamShape): string {
  const prefix =
    goal
      .replace(/[\n\r\t]+/g, ' ')
      .trim()
      .slice(0, 24) || 'Agent';
  return `${prefix} Team · ${shapeToTitle(shape)}`;
}

function shapeToTitle(shape: AgentTeamShape): string {
  const map: Record<AgentTeamShape, string> = {
    auto: 'AI-Decided',
    pipeline: 'Pipeline',
    parallel: 'Parallel',
    'leader-worker': 'Leader-worker',
    'judge-route': 'Judge route',
  };
  return map[shape];
}

function rolesForShape(shape: AgentTeamShape): AgentTeamRole[] {
  if (shape === 'parallel') {
    return [
      role(
        'researcher',
        'Research Agent',
        '从事实、资料和约束角度并行收集信息。',
        ['用户目标'],
        ['事实清单', '风险假设'],
      ),
      role(
        'designer',
        'Solution Agent',
        '从方案和架构角度并行提出可选路径。',
        ['用户目标'],
        ['方案选项', '取舍说明'],
      ),
      role(
        'synthesizer',
        'Synthesis Agent',
        '合并并行结果，输出一致结论。',
        ['事实清单', '方案选项'],
        ['最终建议'],
      ),
    ];
  }
  if (shape === 'leader-worker') {
    return [
      role(
        'lead',
        'Lead Agent',
        '拆解目标、分配任务并整合 worker 结果。',
        ['用户目标'],
        ['任务拆解', '最终交付'],
      ),
      role(
        'worker_analysis',
        'Analysis Worker',
        '负责分析背景、约束和风险。',
        ['任务拆解'],
        ['分析结果'],
      ),
      role(
        'worker_delivery',
        'Delivery Worker',
        '负责形成可执行交付物。',
        ['任务拆解', '分析结果'],
        ['交付草案'],
      ),
    ];
  }
  if (shape === 'judge-route') {
    return [
      role(
        'judge',
        'Judge Agent',
        '评估当前状态并决定下一步路由。',
        ['用户目标', '阶段产出'],
        ['路由决策', '质量意见'],
      ),
      role(
        'executor',
        'Executor Agent',
        '根据 judge 路由执行具体任务。',
        ['路由决策'],
        ['阶段产出'],
      ),
      role(
        'reviewer',
        'Review Agent',
        '检查产出质量并给出修正建议。',
        ['阶段产出'],
        ['评审结果'],
      ),
    ];
  }
  return [
    role(
      'planner',
      'Planning Agent',
      '理解目标并拆解阶段。',
      ['用户目标'],
      ['执行计划'],
    ),
    role(
      'builder',
      'Execution Agent',
      '按计划推进主要工作。',
      ['执行计划'],
      ['阶段交付'],
    ),
    role(
      'reviewer',
      'Review Agent',
      '验证结果并整理最终交付。',
      ['阶段交付'],
      ['最终交付'],
    ),
  ];
}

function role(
  id: string,
  name: string,
  responsibility: string,
  inputs: string[],
  outputs: string[],
): AgentTeamRole {
  return {
    id,
    name,
    responsibility,
    inputs,
    outputs,
    skills: ['目标理解', '结构化协作'],
    guardrails: ['只定义抽象角色，不绑定具体 Agent CLI / provider / device'],
  };
}

function workflowForShape(shape: AgentTeamShape): string {
  if (shape === 'parallel')
    return 'Parallel：多个角色同时处理不同视角，最后由 Synthesis Agent 合并结果。';
  if (shape === 'leader-worker')
    return 'Leader-worker：Lead Agent 负责拆解、协调和整合，Worker Agent 分别完成分析与交付。';
  if (shape === 'judge-route')
    return 'Judge route：Judge Agent 在每个阶段评估质量并决定由哪个角色继续处理。';
  if (shape === 'pipeline')
    return 'Pipeline：角色按顺序接力，每一步消费上一步输出并交付给下一步。';
  return 'Let AI decide：由生成器根据目标选择最合适的协作方式，并保持角色边界清晰。';
}

function workflowStepsForShape(
  shape: AgentTeamShape,
  roles: AgentTeamRole[],
): AgentTeamWorkflowStep[] | undefined {
  if (roles.length === 0) return undefined;
  if (shape === 'parallel') {
    const synthesizer = roles.find((candidate) => candidate.id === 'synthesizer') ?? roles[roles.length - 1];
    const workers = roles.filter((candidate) => candidate.id !== synthesizer.id);
    return [
      {
        id: 'parallel_work',
        type: 'parallel',
        outputKey: 'parallel_outputs',
        parallel: workers.map((candidate) => [
          { roleId: candidate.id, phase: 'work', outputKey: candidate.id },
        ]),
      },
      {
        id: 'synthesize',
        type: 'role',
        roleId: synthesizer.id,
        phase: 'finalize',
        dependsOn: ['parallel_work'],
        inputKeys: workers.map((worker) => worker.id),
        outputKey: 'final',
      },
    ];
  }
  if (shape === 'leader-worker') {
    const [lead, ...workers] = roles;
    return [
      {
        id: 'lead_plan',
        type: 'role',
        roleId: lead.id,
        phase: 'plan',
        outputKey: 'plan',
      },
      {
        id: 'worker_parallel',
        type: 'parallel',
        dependsOn: ['lead_plan'],
        inputKeys: ['plan'],
        parallel: workers.map((worker) => [
          { roleId: worker.id, phase: 'work', outputKey: worker.id },
        ]),
      },
      {
        id: 'lead_finalize',
        type: 'role',
        roleId: lead.id,
        phase: 'finalize',
        dependsOn: ['worker_parallel'],
        outputKey: 'final',
      },
    ];
  }
  if (shape === 'judge-route' && roles.length > 1) {
    const [judge, ...candidates] = roles;
    return [
      {
        id: 'judge_route',
        type: 'route',
        route: {
          judgeRoleId: judge.id,
          candidateRoleIds: candidates.map((candidate) => candidate.id),
          fallbackRoleId: candidates[0]?.id,
          finalRoleId: candidates[candidates.length - 1]?.id,
        },
      },
    ];
  }
  return roles.map((candidate, index) => ({
    id: `step_${index + 1}`,
    type: 'role',
    roleId: candidate.id,
    phase:
      index === 0 ? 'plan' : index === roles.length - 1 ? 'finalize' : 'work',
    dependsOn: index > 0 ? [`step_${index}`] : undefined,
    inputKeys: index > 0 ? [roles[index - 1].id] : undefined,
    outputKey: candidate.id,
  }));
}
