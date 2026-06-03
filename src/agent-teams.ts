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

export interface AgentTeam {
  id: string;
  name: string;
  goal: string;
  shape: AgentTeamShape;
  description: string;
  roles: AgentTeamRole[];
  workflow: string;
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
  createdAt: string;
  updatedAt: string;
}

export interface AgentMdSummary {
  id: string;
  name: string;
  summary: string;
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
  };
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
    successCriteria: [
      '团队产出直接回应用户目标',
      '每个角色都有清晰输入、输出和交接边界',
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
            `- ${definition.name} (${definition.id}): ${definition.summary}`,
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
