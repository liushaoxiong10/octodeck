import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { baseNavItems } from '../web/src/components/layout/nav-items.js';
import {
  dedupeSkillsByIdentity,
  getSkillIdentityKey,
  getSkillPackageName,
  normalizeSkillDisplayText,
} from '../web/src/utils/skillsGrouping.js';

const repoRoot = process.cwd();
const compact = (value: string) => value.replace(/\s+/g, ' ');

describe('frontend agents module', () => {
  test('shows Agent as a top-level entry next to Devices', () => {
    const paths = baseNavItems.map((item) => item.path);
    const agents = baseNavItems.find((item) => item.path === '/agents');

    expect(agents?.label).toBe('Agent');
    expect(paths.indexOf('/agents')).toBeGreaterThan(paths.indexOf('/devices'));
    expect(paths.indexOf('/agents')).toBeLessThan(paths.indexOf('/settings'));
  });

  test('moves backend configuration out of System Settings into AgentsPage', () => {
    const systemSettings = readFileSync(
      join(repoRoot, 'web/src/components/settings/SystemSettingsSection.tsx'),
      'utf8',
    );
    const agentsPage = readFileSync(
      join(repoRoot, 'web/src/pages/AgentsPage.tsx'),
      'utf8',
    );
    const app = readFileSync(join(repoRoot, 'web/src/App.tsx'), 'utf8');

    expect(systemSettings).not.toContain('Agent 后端');
    expect(systemSettings).not.toContain('CustomBackendList');
    expect(agentsPage).toContain('Agent 后端列表');
    expect(agentsPage).toContain('const MODULES = [');
    expect(agentsPage).toContain("'Instructions'");
    expect(agentsPage).toContain("'Settings'");
    expect(agentsPage).toContain(
      'lg:grid-cols-[minmax(280px,1fr)_minmax(0,2fr)]',
    );
    expect(agentsPage).toContain('role="tablist"');
    expect(agentsPage).toContain('role="tabpanel"');
    expect(agentsPage).toContain('activeModule');
    expect(agentsPage).toContain('handleSetDefaultAgent');
    expect(agentsPage).toContain('parseAgentsAnchor');
    expect(agentsPage).toContain('updateAgentsAnchor');
    expect(agentsPage).toContain("window.addEventListener('hashchange'");
    expect(agentsPage).toContain('id="agent"');
    expect(agentsPage).toContain('id="agent-md"');
    expect(agentsPage).toContain('id="agent-team"');
    expect(agentsPage).toContain('hashAnchor.agentId ?? defaultBackend');
    expect(compact(agentsPage)).toContain(
      '!hashAnchor.agentId && selectedAgentId !== defaultBackend',
    );
    expect(agentsPage).toContain('agentMdId');
    expect(agentsPage).toContain('teamId');
    expect(agentsPage).toContain("params.set('agentMd'");
    expect(agentsPage).toContain("params.set('team'");
    expect(agentsPage).toContain('initialSelectedId={hashAnchor.agentMdId}');
    expect(compact(agentsPage)).toContain(
      'initialSelectedTeamId={queryTeamId ?? hashAnchor.teamId}',
    );
    expect(agentsPage).toContain('onSelectedAgentMdIdChange');
    expect(agentsPage).toContain('onSelectedTeamIdChange');
    expect(agentsPage).toContain(
      "api.put<SystemSettings>('/api/config/system'",
    );
    expect(app).toContain('path="/agents"');
  });

  test('custom backend form supports creating an agent on a selected device', () => {
    const form = readFileSync(
      join(repoRoot, 'web/src/components/settings/CustomBackendFormDialog.tsx'),
      'utf8',
    );

    expect(form).toContain('deviceLinkId');
    expect(form).toContain('useAgentLinksStore');
    expect(form).toContain('选择设备');
  });

  test('custom backend form exposes server-side runtime without requiring a device', () => {
    const form = readFileSync(
      join(repoRoot, 'web/src/components/settings/CustomBackendFormDialog.tsx'),
      'utf8',
    );

    expect(form).toContain('Server Side');
    expect(form).toContain("runtime === 'server-side'");
    const deviceValidation = form.indexOf('if (!form.deviceLinkId)');
    const localRuntimeValidation = form.indexOf(
      "if (form.runtime === 'local-device')",
    );
    expect(deviceValidation).toBeGreaterThan(localRuntimeValidation);
    expect(form).toContain(
      'deviceLinkId: form.deviceLinkId.trim() || undefined',
    );
    expect(form).toContain(
      "agentClientId: form.runtime === 'local-device' ? form.agentClientId : undefined",
    );
    expect(form).toContain("form.runtime === 'local-device' ? (");
    expect(form).toContain('Server Side Provider');
  });

  test('custom backend form is a single form instead of a step-by-step wizard', () => {
    const form = readFileSync(
      join(repoRoot, 'web/src/components/settings/CustomBackendFormDialog.tsx'),
      'utf8',
    );

    expect(form).toContain('Agent 配置');
    expect(form).toContain('运行位置');
    expect(form).not.toContain('LOCAL_DEVICE_STEPS');
    expect(form).not.toContain('SERVER_SIDE_STEPS');
    expect(form).not.toContain('下一步');
    expect(form).not.toContain('上一步');
  });

  test('custom backend form defaults to run-time workspace resolution', () => {
    const form = readFileSync(
      join(repoRoot, 'web/src/components/settings/CustomBackendFormDialog.tsx'),
      'utf8',
    );
    const list = readFileSync(
      join(repoRoot, 'web/src/components/settings/CustomBackendList.tsx'),
      'utf8',
    );

    expect(form).toContain('默认运行位置');
    expect(form).toContain('Agent 创建时默认不绑定 Workdir');
    expect(form).toContain("form.workdirMode === 'custom'");
    expect(list).toContain('自动继承任务/Workspace');
  });

  test('promotes model endpoints to a top-level page beside Agent', () => {
    const paths = baseNavItems.map((item) => item.path);
    const modelEndpoints = baseNavItems.find(
      (item) => item.path === '/model-endpoints',
    );
    const app = readFileSync(join(repoRoot, 'web/src/App.tsx'), 'utf8');
    const settings = readFileSync(
      join(repoRoot, 'web/src/pages/SettingsPage.tsx'),
      'utf8',
    );

    expect(modelEndpoints?.label).toBe('模型端点');
    expect(paths.indexOf('/model-endpoints')).toBeGreaterThan(
      paths.indexOf('/agents'),
    );
    expect(paths.indexOf('/model-endpoints')).toBeLessThan(
      paths.indexOf('/settings'),
    );
    expect(app).toContain('path="/model-endpoints"');
    expect(settings).not.toContain('Claude 提供商');
  });

  test('provider editor supports fetching models while creating a provider', () => {
    const editor = readFileSync(
      join(repoRoot, 'web/src/components/settings/ProviderEditor.tsx'),
      'utf8',
    );

    expect(editor).toContain("'/api/config/claude/providers/models/fetch'");
    expect(editor).toContain('请填写 Base URL 和 Token 后再拉取模型列表');
    expect(editor).toContain('setModel(data.models?.[0]?.id || model)');
    expect(editor).not.toContain('if (isCreate || !provider) {');
  });

  test('agents page fetches backend CLI skills and renders workspace and CLI groups', () => {
    const agentsPage = readFileSync(
      join(repoRoot, 'web/src/pages/AgentsPage.tsx'),
      'utf8',
    );

    expect(agentsPage).toContain('/skills?cwd=');
    expect(agentsPage).toContain('Workspace Skills');
    expect(agentsPage).toContain('CLI Skills');
    expect(agentsPage).toContain('loadAgentSkills');
    expect(agentsPage).toContain('AgentSkillInfo');
  });

  test('skills UI groups skills by package and exposes device workspace filters', () => {
    const grouping = readFileSync(
      join(repoRoot, 'web/src/utils/skillsGrouping.ts'),
      'utf8',
    );
    const agentsPage = readFileSync(
      join(repoRoot, 'web/src/pages/AgentsPage.tsx'),
      'utf8',
    );
    const skillsPage = readFileSync(
      join(repoRoot, 'web/src/pages/SkillsPage.tsx'),
      'utf8',
    );
    const skillsStore = readFileSync(
      join(repoRoot, 'web/src/stores/skills.ts'),
      'utf8',
    );

    expect(grouping).toContain("CLOUD_SKILL_PACKAGE = 'Cloud'");
    expect(grouping).toContain("DEVICE_SKILL_PACKAGE = 'Device'");
    expect(grouping).toContain("WORKSPACE_SKILL_PACKAGE = 'Workspace'");
    expect(grouping).toContain('groupSkillsByPackage');
    expect(compact(agentsPage)).toContain('groupSkillsByPackage(skills)');
    expect(compact(agentsPage)).toContain(
      'MarkdownRenderer content={skill.content}',
    );
    expect(compact(skillsPage)).toContain('groupSkillsByPackage(filtered)');
    expect(skillsPage).toContain('全部 Device');
    expect(skillsPage).toContain('全部 Workspace');
    expect(skillsStore).toContain(
      "source: 'cloud' | 'user' | 'project' | 'external' | 'cli' | 'workspace'",
    );
    expect(skillsStore).toContain('deviceId?: string');
    expect(skillsStore).toContain('workspacePath?: string');
  });

  test('skills UI uses Cloud / Device / Workspace fallback package labels', () => {
    expect(normalizeSkillDisplayText('宿主机')).toBe('Device');
    expect(getSkillPackageName({ packageName: '宿主机' })).toBe('Device');
    expect(getSkillPackageName({ source: 'cloud' })).toBe('Cloud');
    expect(getSkillPackageName({ source: 'cli' })).toBe('Device');
    expect(getSkillPackageName({ source: 'workspace' })).toBe('Workspace');
  });

  test('install skill dialog uses Claude SDK format for cloud installs without client picker', () => {
    const dialog = readFileSync(
      join(repoRoot, 'web/src/components/skills/InstallSkillDialog.tsx'),
      'utf8',
    );

    expect(dialog).toContain('Claude SDK / Claude Code 可用的格式');
    expect(dialog).toContain(
      "if (target === 'cloud') return { target: 'cloud' }",
    );
    expect(dialog).not.toContain('Skill 格式');
    expect(dialog).not.toContain('Skill 来源 Agent');
    expect(dialog).not.toContain('setSourceProvider');
  });

  test('skills UI deduplicates identical device skills and keys selection by full identity', () => {
    const codexSkill = {
      id: 'planner',
      source: 'cli',
      deviceId: 'cl_1234567890abcdef',
      sourceProvider: 'codex',
      packageName: 'agent-tools',
    };
    const duplicateCodexSkill = { ...codexSkill };
    const workspaceSkill = {
      ...codexSkill,
      source: 'workspace',
      workspacePath: 'Agent A Workspace',
    };

    expect(
      dedupeSkillsByIdentity([codexSkill, duplicateCodexSkill, workspaceSkill]),
    ).toHaveLength(2);
    expect(getSkillIdentityKey(codexSkill)).not.toBe(
      getSkillIdentityKey(workspaceSkill),
    );
  });

  test('agents page exposes agent team generation and management tab', () => {
    const agentsPage = readFileSync(
      join(repoRoot, 'web/src/pages/AgentsPage.tsx'),
      'utf8',
    );
    const teamStore = readFileSync(
      join(repoRoot, 'web/src/stores/agentTeams.ts'),
      'utf8',
    );
    const teamRoutes = readFileSync(
      join(repoRoot, 'src/routes/agent-teams.ts'),
      'utf8',
    );

    expect(agentsPage).toContain(
      "const AGENT_SECTIONS = ['Agent 管理', 'Agent.md', 'Agent Team']",
    );
    expect(agentsPage).toContain('activeSection');
    expect(agentsPage).toContain('AgentManagementSection');
    expect(agentsPage).toContain('AgentTeamWorkspace');
    expect(agentsPage).toContain('AgentTeamCreateDialog');
    expect(agentsPage).toContain(
      'lg:grid-cols-[minmax(260px,1fr)_minmax(0,2fr)]',
    );
    expect(agentsPage).toContain(
      'lg:grid-cols-[minmax(0,1fr)_minmax(320px,1fr)]',
    );
    expect(agentsPage).toContain('左侧填写生成参数并提交后台任务。');
    expect(agentsPage).toContain('Team 预览');
    expect(agentsPage).toContain('submittedJob');
    expect(agentsPage).toContain('pendingGenerationJobs');
    expect(agentsPage).toContain('selectedGenerationJob');
    expect(compact(agentsPage)).toContain(
      '提交后会立即返回，Team 列表中会出现“生成中”状态。',
    );
    expect(agentsPage).toContain('Agent Team 正在后台生成');
    expect(agentsPage).toContain('生成任务已提交');
    expect(agentsPage).toContain('提交成功后可关闭弹窗');
    expect(agentsPage).not.toContain('createPreviewRoles');
    expect(agentsPage).not.toContain('预计角色轮廓');
    expect(agentsPage).not.toContain(
      '生成器响应超时，已使用本地草稿创建 Agent Team',
    );
    expect(agentsPage).toContain('创建 Team');
    expect(agentsPage).toContain('Team 详情');
    expect(agentsPage).not.toContain('Team 节点');
    expect(agentsPage).not.toContain('Workflow / pipeline');
    expect(agentsPage).toContain('节点详情');
    expect(agentsPage).toContain('AgentTeamPropertyCard');
    expect(agentsPage).toContain('AgentTeamNodeDetail');
    expect(agentsPage).toContain('AgentTeamFlowGraph');
    expect(agentsPage).toContain('buildTeamDag');
    expect(agentsPage).toContain('DAG 流程图');
    expect(agentsPage).toContain('shapeFlowHint');
    expect(agentsPage).toContain('parallelGroup');
    expect(agentsPage).toContain('并行链路');
    expect(agentsPage).toContain('fan-out / fan-in');
    expect(agentsPage).toContain('Lead 分派');
    expect(agentsPage).toContain('Judge 选择路径');
    expect(agentsPage).toContain('测试不通过 → 返工');
    expect(agentsPage).toContain('aria-label="Agent Team DAG 流程"');
    expect(agentsPage).toContain('setTeamEditOpen(true)');
    expect(agentsPage).toContain('低代码拖拽配置');
    expect(agentsPage).toContain('JSON 编辑模式');
    expect(agentsPage).toContain('draggable');
    expect(agentsPage).toContain('selectedRoleId');
    expect(agentsPage).toContain('openCreateDialog');
    expect(agentsPage).not.toContain(
      "const MODULES = ['Instructions', 'Skills', 'Tasks', 'Args', 'ENV', 'Settings', 'Agent.md'",
    );
    expect(agentsPage).not.toContain(
      "const MODULES = ['Instructions', 'Skills', 'Tasks', 'Args', 'ENV', 'Settings', 'Agent Team'",
    );
    expect(agentsPage).toContain("'Agent.md'");
    expect(agentsPage).toContain("'Agent Team'");
    expect(agentsPage).toContain('AgentTeamPanel');
    expect(agentsPage).not.toContain("case 'Agent.md'");
    expect(agentsPage).toContain('Interaction shape');
    expect(agentsPage).toContain('Let AI decide');
    expect(agentsPage).toContain('Leader-worker');
    expect(agentsPage).toContain('Judge route');
    expect(agentsPage).toContain('agent.md 定义');
    expect(agentsPage).toContain('AgentMdPanel');
    expect(agentsPage).toContain('从商店添加');
    expect(agentsPage).toContain('agency-agents');
    expect(teamStore).toContain('AgentMdStoreEntry');
    expect(teamStore).toContain('AGENCY_AGENTS_INDEX_URL');
    expect(teamStore).toContain('data.jsdelivr.com');
    expect(teamStore).toContain('cdn.jsdelivr.net');
    expect(teamStore).toContain('AGENT_MD_STORE_CACHE_TTL_MS');
    expect(teamStore).toContain("cache: 'no-store'");
    expect(teamStore).not.toContain('api.github.com/repos');
    expect(teamStore).not.toContain('/api/agent-teams/agent-md-store/import');
    expect(teamStore).toContain('/api/agent-teams/agent-md');
    expect(agentsPage).toContain(
      '现有 agent.md 简介会在生成 Team 时提供给模型',
    );
    expect(teamStore).toContain('/api/agent-teams/generate');
    expect(teamStore).toContain('AgentTeamGenerationJob');
    expect(teamStore).toContain('loadGenerationJobs');
    expect(teamStore).toContain('/api/agent-teams/generation-jobs');
    expect(teamStore).toContain(
      '/api/agent-teams/${encodeURIComponent(id)}/execute',
    );
    expect(teamStore).toContain('runnerAgentId?: string');
    expect(teamStore).toContain(
      'roleAssignments?: Record<string, AgentTeamRoleAssignment>',
    );
    expect(teamStore).toContain('traceEvents');
    expect(teamStore).toContain('createRun');
    expect(teamStore).toContain('loadRunTasks');
    expect(teamStore).toContain('loadRunEvents');
    expect(teamStore).toContain('loadRunBlackboard');
    expect(teamStore).toContain('listRuns');
    expect(teamStore).toContain('URLSearchParams');
    expect(teamStore).toContain('AgentTeamApproval');
    expect(teamStore).toContain('AgentTeamCheckpoint');
    expect(teamStore).toContain('loadRunApprovals');
    expect(teamStore).toContain('loadRunCheckpoints');
    expect(teamStore).toContain('decideRunApproval');
    expect(teamStore).toContain('cancelRun');
    expect(teamStore).toContain('/approvals/${encodeURIComponent(approvalId)}');
    expect(teamStore).toContain('/cancel');
    expect(teamRoutes).toContain('runnerAgentId');
    expect(teamRoutes).toContain('roleAssignments');
    expect(teamRoutes).toContain("router.post('/:id/runs'");
    expect(teamRoutes).toContain("router.get('/runs'");
    expect(teamRoutes).toContain('listAgentTeamRuns');
    expect(teamRoutes).toContain("router.get('/runs/:runId/events'");
    expect(teamRoutes).toContain("router.get('/runs/:runId/blackboard'");
    expect(teamRoutes).toContain("router.get('/runs/:runId/approvals'");
    expect(teamRoutes).toContain("router.get('/runs/:runId/checkpoints'");
    expect(teamRoutes).toContain("'/runs/:runId/approvals/:approvalId'");
    expect(teamRoutes).toContain("router.post('/runs/:runId/cancel'");
    expect(teamRoutes).toContain('recordAgentTeamRun');
    expect(teamRoutes).toContain('recordAgentTeamTraceEvent');
    expect(agentsPage).toContain('选择后端 / Device');
    expect(agentsPage).toContain('执行 Team');
    expect(agentsPage).toContain('Role Runner 分配');
    expect(agentsPage).toContain('roleAssignments');
    expect(agentsPage).toContain('setRoleAssignments');
    expect(agentsPage).toContain('updateRoleAssignment');
    expect(agentsPage).toContain('clearRoleAssignments');
    expect(compact(agentsPage)).toContain(
      'createRun( selectedTeam.id, prompt, selectedExecutionAgentId, roleAssignments, )',
    );
    expect(agentsPage).toContain('policy.permissionLevel');
    expect(agentsPage).toContain('workspacePolicy');
    expect(agentsPage).toContain('requiresApproval');
    expect(agentsPage).toContain('budget.maxDurationMs');
    expect(agentsPage).toContain('executionResult');
    expect(agentsPage).toContain('执行轨迹');
    expect(agentsPage).toContain('traceEvents');
    expect(agentsPage).toContain('当前 Run');
    expect(agentsPage).toContain('角色任务');
    expect(agentsPage).toContain('黑板产物');
    expect(agentsPage).toContain('refreshRunObservability');
    expect(agentsPage).toContain('runObservabilityUpdatedAt');
    expect(agentsPage).toContain('approvalCard');
    expect(agentsPage).toContain('runHistory');
    expect(agentsPage).toContain('Run 历史');
    expect(agentsPage).toContain('listRuns({ teamId: selectedTeam.id })');
    expect(agentsPage).toContain('handleSelectRunHistory');
    expect(agentsPage).toContain('等待审批');
    expect(agentsPage).toContain('批准并继续');
    expect(agentsPage).toContain('拒绝审批');
    expect(agentsPage).toContain('取消 Run');
    expect(agentsPage).toContain('检查点');
    expect(compact(agentsPage)).toContain('createRun( selectedTeam.id');
    expect(compact(agentsPage)).toContain(
      'decideRunApproval( approvalCard.runId',
    );
    expect(compact(agentsPage)).toContain('loadRunTasks(runId)');
    expect(compact(agentsPage)).toContain('loadRunBlackboard(runId)');
    expect(compact(agentsPage)).toContain('loadRunCheckpoints(run.id)');
    expect(teamStore).toContain(
      'AGENT_TEAM_GENERATION_SUBMIT_TIMEOUT_MS = 30_000',
    );
    expect(teamStore).not.toContain('fallbackUsed');
    expect(teamRoutes).toContain(
      'AGENT_TEAM_GENERATION_TIMEOUT_MS = 1_800_000',
    );
    expect(teamRoutes).toContain("router.get('/generation-jobs'");
    expect(teamRoutes).toContain("router.get('/generation-jobs/:jobId'");
    expect(teamRoutes).toContain('runAgentTeamGenerationJob');
    expect(teamRoutes).toContain(
      'containerConfig: { timeout: AGENT_TEAM_GENERATION_TIMEOUT_MS }',
    );
    expect(teamRoutes).toContain('earlyGenerated');
    expect(teamRoutes).toContain('agentTeamGeneratorProc');
    expect(teamRoutes).toContain('agentTeamGeneratorProc.kill');
    expect(teamStore).toContain('/api/agent-teams/agent-md');
    expect(teamStore).toContain('/api/agent-teams');
  });

  test('Agent definition form treats agent id as server-generated and read-only', () => {
    const definitionsPage = readFileSync(
      join(repoRoot, 'web/src/pages/AgentDefinitionsPage.tsx'),
      'utf8',
    );

    expect(definitionsPage).not.toContain('const slug = createName.trim()');
    expect(definitionsPage).not.toContain('name: ${slug}');
    expect(definitionsPage).toContain('Agent ID:');
    expect(definitionsPage).toContain('系统自动生成，作为唯一标识，不可修改');
  });

  test('Agents page persists agent selection into hash state before auto-default reconciliation', () => {
    const agentsPage = readFileSync(
      join(repoRoot, 'web/src/pages/AgentsPage.tsx'),
      'utf8',
    );

    expect(agentsPage).toContain(
      'const handleSelectAgent = (agentId: string) => {',
    );
    expect(agentsPage).toContain(
      'setHashAnchor((prev) => ({ ...prev, agentId }))',
    );
    expect(agentsPage).toContain('onClick={() => handleSelectAgent(agent.id)}');
    expect(agentsPage).not.toContain(
      'onClick={() => setSelectedAgentId(agent.id)}',
    );
  });
});
