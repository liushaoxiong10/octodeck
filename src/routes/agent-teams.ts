import { Hono } from 'hono';
import { z } from 'zod';
import type { ChildProcess } from 'child_process';

import type { Variables } from '../web-context.js';
import { authMiddleware, systemConfigMiddleware } from '../middleware/auth.js';
import { getBackend } from '../backends/registry.js';
import { getSystemSettings } from '../runtime-config.js';
import type { AuthUser } from '../types.js';
import {
  buildAgentTeamGenerationPrompt,
  buildAgentTeamDraft,
  createAgentMdDefinition,
  createAgentTeam,
  deleteAgentMdDefinition,
  deleteAgentTeam,
  getAgentMdDefinition,
  getAgentTeam,
  isAbstractAgentTeamDefinition,
  listAgentMdDefinitions,
  listAgentMdSummaries,
  listAgentTeams,
  updateAgentMdDefinition,
  updateAgentTeam,
  type AgentTeamGenerationResult,
  type AgentTeamShape,
} from '../agent-teams.js';
import type { AgentMdDefinitionInput, AgentTeamInput } from '../agent-teams.js';
import { executeAgentTeam } from '../agent-team-engine.js';
import type { AgentTeamRoleResult, AgentTeamExecutionPhase } from '../agent-team-engine.js';
import type { RegisteredGroup } from '../types.js';

const router = new Hono<{ Variables: Variables }>();
const AGENT_TEAM_GENERATION_TIMEOUT_MS = 600_000;

const ShapeSchema = z.enum(['auto', 'pipeline', 'parallel', 'leader-worker', 'judge-route']);

const RoleSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(120),
  responsibility: z.string().min(1).max(2000),
  parallelGroup: z.string().min(1).max(64).optional(),
  inputs: z.array(z.string().max(500)).max(12).optional(),
  outputs: z.array(z.string().max(500)).max(12).optional(),
  skills: z.array(z.string().max(500)).max(12).optional(),
  guardrails: z.array(z.string().max(500)).max(12).optional(),
});

const TeamInputSchema = z.object({
  name: z.string().min(1).max(160),
  goal: z.string().min(1).max(6000),
  shape: ShapeSchema,
  description: z.string().min(1).max(4000),
  roles: z.array(RoleSchema).min(1).max(12),
  workflow: z.string().min(1).max(6000),
  successCriteria: z.array(z.string().min(1).max(1000)).min(1).max(12),
  createdByAgentId: z.string().min(1).max(128),
});

const TeamPatchSchema = TeamInputSchema.partial();

const AgentMdInputSchema = z.object({
  name: z.string().min(1).max(160),
  summary: z.string().min(1).max(1000),
  content: z.string().min(1).max(30000),
  createdByAgentId: z.string().min(1).max(128),
});

const AgentMdPatchSchema = AgentMdInputSchema.partial();
const GeneratedAgentMdInputSchema = AgentMdInputSchema.omit({ createdByAgentId: true });
const GeneratedTeamSchema = z.union([
  TeamInputSchema,
  z.object({
    team: TeamInputSchema,
    agentMdDefinitionsToCreate: z.array(GeneratedAgentMdInputSchema).max(12).optional(),
  }),
]);

const GenerateSchema = z.object({
  generatorAgentId: z.string().min(1).max(128),
  goal: z.string().min(1).max(6000),
  shape: ShapeSchema.default('auto'),
});

const ExecuteSchema = z.object({
  prompt: z.string().min(1).max(10000),
  runnerAgentId: z.string().min(1).max(128).optional(),
});

router.get('/', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  return c.json({ teams: listAgentTeams(user.id) });
});

router.post('/', authMiddleware, systemConfigMiddleware, async (c) => {
  const user = c.get('user') as AuthUser;
  const body = await c.req.json().catch(() => ({}));
  const parsed = TeamInputSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues[0]?.message || 'invalid team' }, 400);
  }
  if (!isAbstractAgentTeamDefinition(parsed.data)) {
    return c.json({ error: 'team must not bind concrete agent cli, provider, device, model, command or path' }, 400);
  }
  return c.json(createAgentTeam(parsed.data, user.id), 201);
});

router.post('/generate', authMiddleware, systemConfigMiddleware, async (c) => {
  const user = c.get('user') as AuthUser;
  const body = await c.req.json().catch(() => ({}));
  const parsed = GenerateSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues[0]?.message || 'invalid generation request' }, 400);
  }
  const settings = getSystemSettings();
  if (!settings.allowedBackends.includes(parsed.data.generatorAgentId)) {
    return c.json({ error: 'generator agent is not in allowedBackends' }, 403);
  }
  const requestedBackend = getBackend(parsed.data.generatorAgentId);
  if (requestedBackend && !requestedBackend.supportsExecutionMode('host')) {
    return c.json({ error: 'generator agent does not support host execution mode' }, 400);
  }
  const fallback = buildAgentTeamDraft({
    generatorAgentId: parsed.data.generatorAgentId,
    goal: parsed.data.goal,
    shape: parsed.data.shape as AgentTeamShape,
  });
  const generated = await generateDraftWithAgent(parsed.data.generatorAgentId, fallback, user.id).catch(() => null);
  if (!generated) {
    return c.json({ error: 'agent team generator did not return a valid team definition' }, 502);
  }
  const createdAgentMdDefinitions = generated.agentMdDefinitionsToCreate.map((definition) => createAgentMdDefinition({
    ...definition,
    createdByAgentId: parsed.data.generatorAgentId,
  }, user.id));
  const team = createAgentTeam(generated.draft, user.id);
  return c.json({ team, agentMdDefinitions: createdAgentMdDefinitions }, 201);
});

router.get('/agent-md', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  return c.json({ definitions: listAgentMdDefinitions(user.id) });
});

router.post('/agent-md', authMiddleware, systemConfigMiddleware, async (c) => {
  const user = c.get('user') as AuthUser;
  const body = await c.req.json().catch(() => ({}));
  const parsed = AgentMdInputSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues[0]?.message || 'invalid agent.md definition' }, 400);
  }
  return c.json({ definition: createAgentMdDefinition(parsed.data, user.id) }, 201);
});

router.get('/agent-md-summaries', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  return c.json({ summaries: listAgentMdSummaries(user.id) });
});

router.get('/agent-md/:id', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  const definition = getAgentMdDefinition(c.req.param('id'), user.id);
  if (!definition) return c.json({ error: 'agent.md definition not found' }, 404);
  return c.json({ definition });
});

router.patch('/agent-md/:id', authMiddleware, systemConfigMiddleware, async (c) => {
  const user = c.get('user') as AuthUser;
  const body = await c.req.json().catch(() => ({}));
  const parsed = AgentMdPatchSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues[0]?.message || 'invalid agent.md patch' }, 400);
  }
  const definition = updateAgentMdDefinition(c.req.param('id'), parsed.data, user.id);
  if (!definition) return c.json({ error: 'agent.md definition not found' }, 404);
  return c.json({ definition });
});

router.delete('/agent-md/:id', authMiddleware, systemConfigMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  const deleted = deleteAgentMdDefinition(c.req.param('id'), user.id);
  if (!deleted) return c.json({ error: 'agent.md definition not found' }, 404);
  return c.json({ ok: true });
});

router.get('/:id', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  const team = getAgentTeam(c.req.param('id'), user.id);
  if (!team) return c.json({ error: 'team not found' }, 404);
  return c.json({ team });
});

router.post('/:id/execute', authMiddleware, systemConfigMiddleware, async (c) => {
  const user = c.get('user') as AuthUser;
  const team = getAgentTeam(c.req.param('id'), user.id);
  if (!team) return c.json({ error: 'team not found' }, 404);
  const body = await c.req.json().catch(() => ({}));
  const parsed = ExecuteSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues[0]?.message || 'invalid execution request' }, 400);
  }
  const settings = getSystemSettings();
  const runnerAgentId = parsed.data.runnerAgentId ?? team.createdByAgentId;
  if (!settings.allowedBackends.includes(runnerAgentId)) {
    return c.json({ error: 'team runner agent is not in allowedBackends' }, 403);
  }
  const backend = getBackend(runnerAgentId);
  if (!backend) return c.json({ error: 'team runner backend not found' }, 404);
  if (!backend.supportsExecutionMode('host')) {
    return c.json({ error: 'team runner agent does not support host execution mode' }, 400);
  }
  const execution = await executeAgentTeam(team, { prompt: parsed.data.prompt }, async ({ role, prompt, phase, previousResults, feedback }) => {
    const rolePrompt = buildAgentTeamRolePrompt(team, role, prompt, phase, previousResults, feedback);
    const output = await backend.run({
      group: {
        name: `Agent Team ${team.name}`,
        folder: `agent-team-${team.id}-${role.id}`,
        added_at: new Date().toISOString(),
        containerConfig: { timeout: AGENT_TEAM_GENERATION_TIMEOUT_MS },
        executionMode: 'host',
        backend: runnerAgentId,
        created_by: user.id,
      },
      executionMode: 'host',
      input: {
        prompt: rolePrompt,
        groupFolder: `agent-team-${team.id}-${role.id}`,
        chatJid: `system:agent-team:${team.id}`,
        isMain: false,
        isHome: false,
        isAdminHome: false,
        executionProfile: 'single-turn-json',
      },
      onProcess: () => undefined,
    });
    return output;
  });
  return c.json({ execution }, execution.status === 'success' ? 200 : 502);
});

router.patch('/:id', authMiddleware, systemConfigMiddleware, async (c) => {
  const user = c.get('user') as AuthUser;
  const body = await c.req.json().catch(() => ({}));
  const parsed = TeamPatchSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues[0]?.message || 'invalid patch' }, 400);
  }
  const existing = getAgentTeam(c.req.param('id'), user.id);
  if (!existing) return c.json({ error: 'team not found' }, 404);
  const merged = { ...existing, ...parsed.data };
  if (!isAbstractAgentTeamDefinition(merged)) {
    return c.json({ error: 'team must not bind concrete agent cli, provider, device, model, command or path' }, 400);
  }
  const team = updateAgentTeam(c.req.param('id'), parsed.data, user.id);
  if (!team) return c.json({ error: 'team not found' }, 404);
  return c.json({ team });
});

router.delete('/:id', authMiddleware, systemConfigMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  const deleted = deleteAgentTeam(c.req.param('id'), user.id);
  if (!deleted) return c.json({ error: 'team not found' }, 404);
  return c.json({ ok: true });
});

export default router;

async function generateDraftWithAgent(
  generatorAgentId: string,
  fallback: AgentTeamInput,
  ownerUserId: string,
): Promise<AgentTeamGenerationResult> {
  const backend = getBackend(generatorAgentId);
  if (!backend) throw new Error('agent team generator backend not found');

  const prompt = buildAgentTeamGenerationPrompt(fallback, listAgentMdSummaries(ownerUserId));
  let agentTeamGeneratorProc: ChildProcess | null = null;
  let streamText = '';
  let earlyGenerated: AgentTeamGenerationResult | null = null;
  const group: RegisteredGroup = {
    name: 'Agent Team Generator',
    folder: 'agent-team-generator',
    added_at: new Date().toISOString(),
    containerConfig: { timeout: AGENT_TEAM_GENERATION_TIMEOUT_MS },
    executionMode: 'host',
    backend: generatorAgentId,
    created_by: ownerUserId,
  };
  const output = await backend.run({
    group,
    executionMode: 'host',
    input: {
      prompt,
      groupFolder: group.folder,
      chatJid: 'system:agent-team-generator',
      isMain: false,
      isHome: false,
      isAdminHome: false,
      executionProfile: 'single-turn-json',
    },
    onProcess: (proc) => {
      agentTeamGeneratorProc = proc;
    },
    onOutput: async (output) => {
      const text = output.streamEvent?.text;
      if (!text || earlyGenerated) return;
      streamText += text;
      earlyGenerated = parseGeneratedTeam(streamText, fallback);
      if (earlyGenerated && agentTeamGeneratorProc && !agentTeamGeneratorProc.killed) {
        agentTeamGeneratorProc.kill('SIGTERM');
      }
    },
  });

  if (earlyGenerated) return earlyGenerated;
  if (output.status !== 'success' || !output.result) throw new Error(output.error || 'agent team generator failed');
  const generated = parseGeneratedTeam(output.result, fallback);
  if (!generated) throw new Error('agent team generator returned invalid JSON');
  return generated;
}

function parseGeneratedTeam(
  text: string,
  fallback: AgentTeamInput,
): AgentTeamGenerationResult | null {
  const jsonText = extractJsonObject(text);
  if (!jsonText) return null;
  try {
    const parsed = GeneratedTeamSchema.safeParse(JSON.parse(jsonText));
    if (!parsed.success) return null;
    if ('team' in parsed.data) {
      if (!isAbstractAgentTeamDefinition(parsed.data.team)) {
        return null;
      }
      return {
        draft: {
          ...parsed.data.team,
          createdByAgentId: fallback.createdByAgentId,
        },
        agentMdDefinitionsToCreate: parsed.data.agentMdDefinitionsToCreate ?? [],
      };
    }
    if (!isAbstractAgentTeamDefinition(parsed.data)) {
      return null;
    }
    return {
      draft: {
        ...parsed.data,
        createdByAgentId: fallback.createdByAgentId,
      },
      agentMdDefinitionsToCreate: [],
    };
  } catch {
    return null;
  }
}

function extractJsonObject(text: string): string | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fenced?.[1] ?? text;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  return raw.slice(start, end + 1);
}

function buildAgentTeamRolePrompt(
  team: AgentTeamInput,
  role: AgentTeamInput['roles'][number],
  userPrompt: string,
  phase: AgentTeamExecutionPhase,
  previousResults: AgentTeamRoleResult[],
  feedback?: string,
): string {
  return [
    '你正在作为 Agent Team 中的一个抽象角色执行任务。',
    '请只完成当前角色职责范围内的工作，并输出清晰、可交接的结果。',
    '',
    `Team: ${team.name}`,
    `Goal: ${team.goal}`,
    `Shape: ${team.shape}`,
    `Workflow: ${team.workflow}`,
    '',
    `Current role: ${role.name} (${role.id})`,
    `Responsibility: ${role.responsibility}`,
    role.inputs?.length ? `Inputs: ${role.inputs.join('; ')}` : '',
    role.outputs?.length ? `Expected outputs: ${role.outputs.join('; ')}` : '',
    role.skills?.length ? `Suggested skills/agent.md: ${role.skills.join('; ')}` : '',
    role.guardrails?.length ? `Guardrails: ${role.guardrails.join('; ')}` : '',
    '',
    `Execution phase: ${phase}`,
    feedback ? `Feedback or upstream signal: ${feedback}` : '',
    previousResults.length ? 'Previous role results:' : '',
    ...previousResults.map((result) => `- ${result.roleName} (${result.phase}, ${result.status}): ${result.result}`),
    '',
    `User request: ${userPrompt}`,
    '',
    '输出要求：',
    '- 用中文输出。',
    '- 如果当前角色是测试/QA，请明确写出“测试通过”或“测试不通过”，并说明原因。',
    '- 如果当前角色是 Judge，请用 “route: <role_id>” 指明下一步选择的角色。',
    '- 不要调用工具，不要声明自己无法执行；按角色给出可交付结果。',
  ].filter(Boolean).join('\n');
}
