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
    expect(form).toContain('agentClientId:');
    expect(form).toContain("form.runtime === 'local-device'");
    expect(form).toContain('form.agentClientId');
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

    expect(form).toContain('Workdir');
    expect(form).toContain('Agent 创建时默认不绑定');
    expect(form).toContain('实际运行目录会在每次任务/会话启动时');
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

  test('skills page skips stale device backends whose provider is no longer reported', () => {
    const skillsPage = readFileSync(
      join(repoRoot, 'web/src/pages/SkillsPage.tsx'),
      'utf8',
    );

    expect(skillsPage).toContain('function getDeviceSkillsBackends');
    expect(skillsPage).toContain('device?.agentClients ?? []');
    expect(skillsPage).toContain('client.id === backend.agentClientId');
    expect(skillsPage).toContain(
      'const deviceBackends = getDeviceSkillsBackends(backends, devices);',
    );
  });

  test('skills UI uses Cloud / Device / Workspace fallback package labels', () => {
    expect(normalizeSkillDisplayText('宿主机')).toBe('Device');
    expect(getSkillPackageName({ packageName: '宿主机' })).toBe('Device');
    expect(getSkillPackageName({ source: 'cloud' })).toBe('Cloud');
    expect(getSkillPackageName({ source: 'cli' })).toBe('Device');
    expect(getSkillPackageName({ source: 'workspace' })).toBe('Workspace');
  });

  test('install skill dialog lets every target choose a provider-native skill format', () => {
    const dialog = readFileSync(
      join(repoRoot, 'web/src/components/skills/InstallSkillDialog.tsx'),
      'utf8',
    );

    expect(dialog).toContain('sourceProvider');
    expect(dialog).toContain('setSourceProvider');
    expect(dialog).toContain('Provider / Skill 格式');
    expect(dialog).toContain("useState<SourceProvider>('claude')");
    expect(dialog).toContain("value: 'codex'");
    expect(dialog).toContain("value: 'traecli'");
    expect(dialog).toContain("value: 'opencode'");
    expect(dialog).toContain(
      "return { target: 'cloud', sourceProvider }",
    );
    expect(dialog).toContain("return { target: 'device-agent-workspace', agentId, sourceProvider }");
    expect(dialog).toContain("return { target: 'device', deviceLinkId, sourceProvider }");
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

  test('agent registry UI exposes skill dependency version conflicts', () => {
    const agentsPage = readFileSync(
      join(repoRoot, 'web/src/pages/AgentDefinitionsPage.tsx'),
      'utf8',
    );
    const agentStore = readFileSync(
      join(repoRoot, 'web/src/stores/agent-definitions.ts'),
      'utf8',
    );

    expect(agentStore).toContain('dependencyConflicts: number');
    expect(agentStore).toContain('versionSatisfied: boolean | null');
    expect(agentStore).toContain('dependencyConflicts: Array');
    expect(agentsPage).toContain('dependencyConflicts');
    expect(agentsPage).toContain('Skill 依赖冲突');
    expect(agentsPage).toContain('版本不匹配');
  });

  test('agent registry UI exposes skill package file collection metadata', () => {
    const agentsPage = readFileSync(
      join(repoRoot, 'web/src/pages/AgentDefinitionsPage.tsx'),
      'utf8',
    );
    const agentStore = readFileSync(
      join(repoRoot, 'web/src/stores/agent-definitions.ts'),
      'utf8',
    );

    expect(agentStore).toContain('fileCount: number');
    expect(agentStore).toContain('totalBytes: number');
    expect(agentStore).toContain('fileManifest: Array');
    expect(agentsPage).toContain('文件集合');
    expect(agentsPage).toContain('formatRegistryBytes');
    expect(agentsPage).toContain('pkg.fileCount');
    expect(agentsPage).toContain('pkg.totalBytes');
  });

  test('autopilot UI exposes failed run retry controls and lineage metadata', () => {
    const autopilotsPage = readFileSync(
      join(repoRoot, 'web/src/pages/AutopilotsPage.tsx'),
      'utf8',
    );
    const autopilotsStore = readFileSync(
      join(repoRoot, 'web/src/stores/autopilots.ts'),
      'utf8',
    );

    expect(autopilotsStore).toContain('retry_of?: string | null');
    expect(autopilotsStore).toContain('attempt: number');
    expect(autopilotsStore).toContain('retryRun: (autopilotId: string, runId: string) => Promise<AutopilotRun>');
    expect(autopilotsStore).toContain('/retry`');
    expect(autopilotsPage).toContain('retryRun');
    expect(autopilotsPage).toContain('第 {run.attempt} 次');
    expect(autopilotsPage).toContain('Retry of: {run.retry_of}');
    expect(autopilotsPage).toContain('重试');
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
    expect(teamStore).toContain('AGENT_MD_STORE_SOURCES');
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
    expect(teamStore).toContain('AgentTeamArtifact');
    expect(teamStore).toContain('loadRunApprovals');
    expect(teamStore).toContain('loadRunCheckpoints');
    expect(teamStore).toContain('loadRunArtifacts');
    expect(teamStore).toContain('AgentTeamMetricsSummary');
    expect(teamStore).toContain('loadMetrics');
    expect(teamStore).toContain('/api/agent-teams/metrics');
    expect(teamStore).toContain('decideRunApproval');
    expect(teamStore).toContain('cancelRun');
    expect(teamStore).toContain('/artifacts');
    expect(teamStore).toContain('/approvals/${encodeURIComponent(approvalId)}');
    expect(teamStore).toContain('/cancel');
    expect(teamRoutes).toContain('runnerAgentId');
    expect(teamRoutes).toContain('roleAssignments');
    expect(teamRoutes).toContain("router.post('/:id/runs'");
    expect(teamRoutes).toContain("router.get('/runs'");
    expect(teamRoutes).toContain("router.get('/metrics'");
    expect(teamRoutes).toContain('listAgentTeamRunsForMetrics');
    expect(teamRoutes).toContain('summarizeAgentTeamMetrics');
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
    expect(agentsPage).toContain('Artifacts / 版本化产物');
    expect(agentsPage).toContain('runArtifacts');
    expect(agentsPage).toContain('refreshRunObservability');
    expect(agentsPage).toContain('runObservabilityUpdatedAt');
    expect(agentsPage).toContain('approvalCard');
    expect(agentsPage).toContain('runHistory');
    expect(agentsPage).toContain('Run 历史');
    expect(agentsPage).toContain('Agent Team 指标');
    expect(agentsPage).toContain('agentTeamMetrics');
    expect(agentsPage).toContain('loadMetrics({ teamId })');
    expect(agentsPage).toContain('approvalLatency');
    expect(agentsPage).toContain('listRuns({ teamId })');
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
    expect(compact(agentsPage)).toContain('loadRunArtifacts(runId)');
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

  test('Agent team generation jobs refresh through standard AgentTask event bridge', () => {
    const agentsPage = readFileSync(
      join(repoRoot, 'web/src/pages/AgentsPage.tsx'),
      'utf8',
    );
    const appLayout = readFileSync(
      join(repoRoot, 'web/src/components/layout/AppLayout.tsx'),
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

    expect(teamRoutes).toContain('broadcastAgentTeamGenerationEvent');
    expect(teamRoutes).toContain('agent_task.agent_team_generation.${job.status}');
    expect(appLayout).toContain('useAgentTeamsStore');
    expect(appLayout).toContain("event.type?.startsWith('agent_task.agent_team_generation.')");
    expect(appLayout).toContain('upsertGenerationJob(event.payload.job)');
    expect(teamStore).toContain('upsertGenerationJob');
    expect(agentsPage).toContain('completedGenerationJobs');
    expect(agentsPage).not.toContain('pollGenerationJobsRef');
    expect(agentsPage).not.toContain('const runningJobs = generationJobs.filter');
    expect(agentsPage).not.toContain('loadGenerationJob(job.id)');
  });

  test('Agent team active runs refresh through standard AgentTask event bridge', () => {
    const agentsPage = readFileSync(
      join(repoRoot, 'web/src/pages/AgentsPage.tsx'),
      'utf8',
    );
    const teamRoutes = readFileSync(
      join(repoRoot, 'src/routes/agent-teams.ts'),
      'utf8',
    );

    expect(teamRoutes).toContain('broadcastAgentTeamRunEvent');
    expect(teamRoutes).toContain('agent_task.agent_team_run.${run.status}');
    expect(teamRoutes).toContain('broadcastAgentTeamTaskEvent');
    expect(teamRoutes).toContain('agent_task.agent_team_task.${task.status}');
    expect(agentsPage).toContain("wsManager.on('octodeck_event:agent_task'");
    expect(agentsPage).toContain("event.type?.startsWith('agent_task.agent_team_')");
    expect(agentsPage).toContain('refreshRunObservability(event.runId');
    expect(agentsPage).not.toContain('const intervalMs = activeRun.status ===');
    expect(agentsPage).not.toContain('window.setInterval(() =>');
    expect(agentsPage).not.toContain('window.clearInterval(timer)');
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

  test('Agent Registry view exposes versioned agents and skill install records', () => {
    const definitionsStore = readFileSync(
      join(repoRoot, 'web/src/stores/agent-definitions.ts'),
      'utf8',
    );
    const definitionsPage = readFileSync(
      join(repoRoot, 'web/src/pages/AgentDefinitionsPage.tsx'),
      'utf8',
    );
    const definitionsRoutes = readFileSync(
      join(repoRoot, 'src/routes/agent-definitions.ts'),
      'utf8',
    );

    expect(definitionsRoutes).toContain("agentDefinitionsRoutes.get('/registry'");
    expect(definitionsStore).toContain('AgentRegistrySnapshot');
    expect(definitionsStore).toContain('loadRegistry');
    expect(definitionsStore).toContain('/api/agent-definitions/registry');
    expect(definitionsPage).toContain('Agent Registry');
    expect(definitionsPage).toContain('Skill Packages');
    expect(definitionsPage).toContain('unresolvedSkillDependencies');
    expect(definitionsPage).toContain('requiredSkills');
  });

  test('Agent Registry governance UI exposes approval audit history and rollback actions', () => {
    const definitionsStore = readFileSync(
      join(repoRoot, 'web/src/stores/agent-definitions.ts'),
      'utf8',
    );
    const definitionsPage = readFileSync(
      join(repoRoot, 'web/src/pages/AgentDefinitionsPage.tsx'),
      'utf8',
    );
    const definitionsRoutes = readFileSync(
      join(repoRoot, 'src/routes/agent-definitions.ts'),
      'utf8',
    );

    expect(definitionsRoutes).toContain("agentDefinitionsRoutes.get('/:id/governance'");
    expect(definitionsRoutes).toContain("agentDefinitionsRoutes.post(\n  '/:id/rollback'");
    expect(definitionsStore).toContain('AgentDefinitionGovernance');
    expect(definitionsStore).toContain('loadAgentGovernance');
    expect(definitionsStore).toContain('rollbackAgentDefinition');
    expect(definitionsStore).toContain('/governance');
    expect(definitionsStore).toContain('/rollback');
    expect(definitionsPage).toContain('审批审计');
    expect(definitionsPage).toContain('版本回滚');
    expect(definitionsPage).toContain('rollbackAgentDefinition');
    expect(definitionsPage).toContain('loadAgentGovernance');
    expect(definitionsPage).toContain('回滚到此版本');
  });

  test('issue worktree diff viewer exposes per-file patches', () => {
    const issueStore = readFileSync(
      join(repoRoot, 'web/src/stores/issues.ts'),
      'utf8',
    );
    const issueDetail = readFileSync(
      join(repoRoot, 'web/src/pages/IssueDetailPage.tsx'),
      'utf8',
    );
    const issueRoutes = readFileSync(join(repoRoot, 'src/routes/issues.ts'), 'utf8');

    expect(issueStore).toContain('patch?: string');
    expect(issueDetail).toContain('file.patch');
    expect(issueDetail).toContain('Per-file patch');
    expect(issueRoutes).toContain('includePatch: true');
  });

  test('issue run delivery exposes PR and review drafts', () => {
    const issueStore = readFileSync(
      join(repoRoot, 'web/src/stores/issues.ts'),
      'utf8',
    );
    const issueDetail = readFileSync(
      join(repoRoot, 'web/src/pages/IssueDetailPage.tsx'),
      'utf8',
    );
    const issueRoutes = readFileSync(join(repoRoot, 'src/routes/issues.ts'), 'utf8');

    expect(issueRoutes).toContain("/:id/runs/:runId/delivery");
    expect(issueRoutes).toContain('buildIssueRunPullRequestDraft');
    expect(issueRoutes).toContain('buildIssueRunReviewDraft');
    expect(issueStore).toContain('IssueRunDeliveryDraft');
    expect(issueStore).toContain('deliveryState');
    expect(issueStore).toContain('loadIssueRunDelivery');
    expect(issueStore).toContain('data.delivery');
    expect(issueStore).toContain('/delivery');
    expect(issueStore).toContain("severity: 'low' | 'medium' | 'high' | 'critical'");
    expect(issueStore).toContain("category: 'correctness' | 'security' | 'performance' | 'maintainability' | 'review_required'");
    expect(issueDetail).toContain('deliveryDraft');
    expect(issueDetail).toContain('PR draft');
    expect(issueDetail).toContain('Review prompt');
    expect(issueDetail).toContain('Structured review comments');
    expect(issueDetail).toContain('Delivery state');
    expect(issueDetail).toContain('deliveryDraft.deliveryState.checklist');
    expect(issueDetail).toContain('comment.severity');
    expect(issueRoutes).toContain('preCommitDiff');
    expect(issueRoutes).toContain('buildIssueRunDeliveryState');
  });

  test('issue run delivery exposes a provider create PR entrypoint', () => {
    const delivery = readFileSync(join(repoRoot, 'src/issue-delivery.ts'), 'utf8');
    const issueStore = readFileSync(
      join(repoRoot, 'web/src/stores/issues.ts'),
      'utf8',
    );
    const issueDetail = readFileSync(
      join(repoRoot, 'web/src/pages/IssueDetailPage.tsx'),
      'utf8',
    );

    expect(delivery).toContain('buildPullRequestCreateUrl');
    expect(delivery).toContain("provider: 'github'");
    expect(delivery).toContain("quick_pull: '1'");
    expect(issueStore).toContain("provider?: 'github' | 'gitlab' | 'codebase' | 'unknown'");
    expect(issueStore).toContain('repositoryUrl?: string');
    expect(issueStore).toContain('createUrl?: string');
    expect(issueDetail).toContain('Create PR');
    expect(issueDetail).toContain('Create MR');
    expect(issueDetail).toContain('Open repository');
    expect(issueDetail).toContain('pullRequestDraft.createUrl');
    expect(issueDetail).toContain('window.open');
  });

  test('issue detail explains injected repo knowledge chunks', () => {
    const issueStore = readFileSync(
      join(repoRoot, 'web/src/stores/issues.ts'),
      'utf8',
    );
    const issueDetail = readFileSync(
      join(repoRoot, 'web/src/pages/IssueDetailPage.tsx'),
      'utf8',
    );
    const issueRoutes = readFileSync(join(repoRoot, 'src/routes/issues.ts'), 'utf8');

    expect(issueRoutes).toContain('/:id/runs/:runId/repo-knowledge');
    expect(issueRoutes).toContain('getAgentTaskById');
    expect(issueStore).toContain('IssueRunRepoKnowledgeExplanation');
    expect(issueStore).toContain('loadIssueRunRepoKnowledge');
    expect(issueStore).toContain('/repo-knowledge');
    expect(issueDetail).toContain('Repo Knowledge context');
    expect(issueDetail).toContain('Why injected');
    expect(issueDetail).toContain('matchedTerms');
    expect(issueDetail).toContain('rationale');
  });

  test('Autopilot page exposes built-in templates and run history', () => {
    const navItems = baseNavItems.map((item) => item.path);
    const app = readFileSync(join(repoRoot, 'web/src/App.tsx'), 'utf8');
    const autopilotStore = readFileSync(
      join(repoRoot, 'web/src/stores/autopilots.ts'),
      'utf8',
    );
    const autopilotsPage = readFileSync(
      join(repoRoot, 'web/src/pages/AutopilotsPage.tsx'),
      'utf8',
    );

    expect(navItems).toContain('/autopilots');
    expect(app).toContain('path="/autopilots"');
    expect(autopilotStore).toContain('/api/autopilots/templates');
    expect(autopilotStore).toContain('installTemplate');
    expect(autopilotStore).toContain("'running' | 'success' | 'error' | 'skipped'");
    expect(autopilotStore).toContain('skip_reason?: string | null');
    expect(autopilotsPage).toContain('Autopilot');
    expect(autopilotsPage).toContain('每日 repo health check');
    expect(autopilotsPage).toContain('每周 dependency/TODO scan');
    expect(autopilotsPage).toContain('webhook code review');
    expect(autopilotsPage).toContain('运行历史');
    expect(autopilotsPage).toContain('skip_reason');
    expect(autopilotsPage).toContain('Skip reason');
    expect(autopilotsPage).toContain('API Endpoint');
    expect(autopilotsPage).toContain('/api/autopilots/${autopilot.id}/api');
    expect(autopilotsPage).toContain('Authorization: Bearer');
  });

  test('frontend consumes standard Autopilot events to refresh autopilot stores', () => {
    const appLayout = readFileSync(
      join(repoRoot, 'web/src/components/layout/AppLayout.tsx'),
      'utf8',
    );

    expect(appLayout).toContain('useAutopilotsStore');
    expect(appLayout).toContain("wsManager.on('octodeck_event:autopilot'");
    expect(appLayout).toContain('loadAutopilots()');
    expect(appLayout).toContain('loadRuns(autopilotId)');
  });

  test('frontend consumes standard chat message events in the global event bridge', () => {
    const appLayout = readFileSync(
      join(repoRoot, 'web/src/components/layout/AppLayout.tsx'),
      'utf8',
    );
    const chatView = readFileSync(
      join(repoRoot, 'web/src/components/chat/ChatView.tsx'),
      'utf8',
    );

    expect(appLayout).toContain("wsManager.on('octodeck_event:chat'");
    expect(appLayout).toContain('event.type === \'chat.message.created\'');
    expect(compact(appLayout)).toContain(
      'handleWsNewMessage( event.chatJid, event.payload.message, event.payload.agentId, event.payload.source, )',
    );
    expect(chatView).toContain("wsManager.on('connected'");
    expect(chatView).toContain('refreshMessages(groupJid, urlSessionId)');
    expect(chatView).not.toContain("wsManager.on('new_message'");
    expect(chatView).not.toContain('Poll for new messages');
    expect(chatView).not.toContain('pollRef');
    expect(chatView).not.toContain('setTimeout(poll');
  });

  test('Chat view refreshes IM status through the standard Device event bridge instead of polling', () => {
    const chatView = readFileSync(
      join(repoRoot, 'web/src/components/chat/ChatView.tsx'),
      'utf8',
    );

    expect(chatView).toContain("wsManager.on('octodeck_event:device'");
    expect(chatView).toContain("event.domain === 'device'");
    expect(chatView).toContain('fetchStatus()');
    expect(chatView).not.toContain('setInterval(fetchStatus, 30_000)');
    expect(chatView).not.toContain('clearInterval(timer)');
  });

  test('Usage bars refresh OAuth usage through the standard Billing event bridge instead of polling', () => {
    const usageBars = readFileSync(
      join(repoRoot, 'web/src/components/settings/UsageBars.tsx'),
      'utf8',
    );

    expect(usageBars).toContain("wsManager.on('octodeck_event:billing'");
    expect(usageBars).toContain("event.type === 'billing.usage.updated'");
    expect(usageBars).toContain('fetchUsage();');
    expect(usageBars).toContain("wsManager.on('connected'");
    expect(usageBars).not.toContain('POLL_INTERVAL_MS');
    expect(usageBars).not.toContain('useRef');
    expect(usageBars).not.toContain('setInterval');
    expect(usageBars).not.toContain('clearInterval');
  });

  test('Claude provider health refreshes through the standard System event bridge instead of polling', () => {
    const providerSection = readFileSync(
      join(repoRoot, 'web/src/components/settings/ClaudeProviderSection.tsx'),
      'utf8',
    );

    expect(providerSection).toContain("wsManager.on('octodeck_event:system'");
    expect(providerSection).toContain("event.type === 'system.provider_pool.health.updated'");
    expect(providerSection).toContain('refreshProviderHealth();');
    expect(providerSection).toContain("wsManager.on('connected'");
    expect(providerSection).not.toContain('healthTimerRef');
    expect(providerSection).not.toContain('setInterval');
    expect(providerSection).not.toContain('clearInterval');
  });

  test('provider pool health changes are bridged as standard System events', () => {
    const providerPool = readFileSync(join(repoRoot, 'src/provider-pool.ts'), 'utf8');
    const webServer = readFileSync(join(repoRoot, 'src/web.ts'), 'utf8');

    expect(providerPool).toContain('setOnHealthChange');
    expect(providerPool).toContain('emitHealthChange');
    expect(webServer).toContain('broadcastProviderPoolHealthEvent');
    expect(webServer).toContain("type: 'system.provider_pool.health.updated'");
    expect(webServer).toContain("domain: 'system'");
    expect(webServer).toContain('providerPool.setOnHealthChange(broadcastProviderPoolHealthEvent)');
  });

  test('server broadcasts billing updates as standard OctoDeck billing events', () => {
    const webServer = readFileSync(join(repoRoot, 'src/web.ts'), 'utf8');

    expect(webServer).toContain('export function broadcastBillingUpdate');
    expect(webServer).toContain('broadcastOctoDeckEvent(');
    expect(webServer).toContain("type: 'billing.usage.updated'");
    expect(webServer).toContain("domain: 'billing'");
    expect(webServer).toContain("action: 'updated'");
    expect(webServer).toContain('new Set([userId])');
  });

  test('frontend consumes billing and group-created updates through standard event bridge', () => {
    const appLayout = readFileSync(
      join(repoRoot, 'web/src/components/layout/AppLayout.tsx'),
      'utf8',
    );

    expect(appLayout).toContain("wsManager.on('octodeck_event:billing'");
    expect(appLayout).toContain('handleBillingUpdate(event.payload)');
    expect(appLayout).toContain("event.type === 'chat.group.created'");
    expect(appLayout).toContain('loadGroups()');
    expect(appLayout).toContain('loadTasks()');
    expect(appLayout).not.toContain("wsManager.on('billing_update'");
    expect(appLayout).not.toContain("wsManager.on('group_created'");
  });

  test('Issue detail consumes issue timeline and approval requests through standard event bridge', () => {
    const issueDetail = readFileSync(
      join(repoRoot, 'web/src/pages/IssueDetailPage.tsx'),
      'utf8',
    );

    expect(issueDetail).toContain("wsManager.on('octodeck_event:issue'");
    expect(issueDetail).toContain("wsManager.on('octodeck_event:approval'");
    expect(issueDetail).toContain('event.type?.startsWith(\'issue.timeline.\')');
    expect(issueDetail).toContain('event.payload as IssueEvent');
    expect(issueDetail).toContain('event.payload as IssueAgentRequest');
    expect(issueDetail).not.toContain('Active run polling');
    expect(issueDetail).not.toContain('window.setInterval(() =>');
    expect(issueDetail).not.toContain('window.clearInterval(timer)');
    expect(issueDetail).not.toContain("wsManager.on('issue_event'");
    expect(issueDetail).not.toContain("wsManager.on('issue_request_created'");
    expect(issueDetail).not.toContain("wsManager.on('issue_request_answered'");
    expect(issueDetail).not.toContain("wsManager.on('issue_request_expired'");
  });

  test('Issue delivery panel creates PR/MR and launches Review Agent from delivery drafts', () => {
    const issueRoutes = readFileSync(join(repoRoot, 'src/routes/issues.ts'), 'utf8');
    const issueStore = readFileSync(join(repoRoot, 'web/src/stores/issues.ts'), 'utf8');
    const issueDetail = readFileSync(join(repoRoot, 'web/src/pages/IssueDetailPage.tsx'), 'utf8');

    expect(issueRoutes).toContain("/:id/runs/:runId/pull-request");
    expect(issueRoutes).toContain('createIssueRunPullRequest(');
    expect(issueRoutes).toContain("'pull_request_created'");
    expect(issueRoutes).toContain("/:id/runs/:runId/review");
    expect(issueRoutes).toContain("'review_agent_run_created'");
    expect(issueRoutes).toContain('enqueueIssueRun(issue.id, reviewRun.id)');

    expect(issueStore).toContain('createIssueRunPullRequest:');
    expect(issueStore).toContain('runIssueReviewAgent:');
    expect(issueStore).toContain('pullRequestResultsByRun');
    expect(issueStore).toContain('/pull-request');
    expect(issueStore).toContain('/review');

    expect(issueDetail).toContain('onCreatePullRequest');
    expect(issueDetail).toContain('onRunReviewAgent');
    expect(issueDetail).toContain('pullRequestResult');
    expect(issueDetail).toContain('Created PR/MR');
    expect(issueDetail).toContain('provider_not_configured');
    expect(issueDetail).toContain('Creating PR…');
    expect(issueDetail).toContain('Run Review Agent');
  });

  test('Issue detail exposes release governance state and refresh action', () => {
    const issueRoutes = readFileSync(join(repoRoot, 'src/routes/issues.ts'), 'utf8');
    const issueStore = readFileSync(join(repoRoot, 'web/src/stores/issues.ts'), 'utf8');
    const issueDetail = readFileSync(join(repoRoot, 'web/src/pages/IssueDetailPage.tsx'), 'utf8');

    expect(issueRoutes).toContain('/:id/runs/:runId/release');
    expect(issueRoutes).toContain('/:id/runs/:runId/release/refresh');
    expect(issueStore).toContain('IssueRunReleaseDraft');
    expect(issueStore).toContain('loadIssueRunRelease');
    expect(issueStore).toContain('refreshIssueRunRelease');
    expect(issueStore).toContain('runReleaseDraftsByRun');
    expect(issueDetail).toContain('Release Governance');
    expect(issueDetail).toContain('RunReleaseGovernancePanel');
    expect(issueDetail).toContain('onRefreshRelease');
  });

  test('Issue detail exposes production health watcher state and signal actions', () => {
    const issueRoutes = readFileSync(join(repoRoot, 'src/routes/issues.ts'), 'utf8');
    const issueStore = readFileSync(join(repoRoot, 'web/src/stores/issues.ts'), 'utf8');
    const issueDetail = readFileSync(join(repoRoot, 'web/src/pages/IssueDetailPage.tsx'), 'utf8');

    expect(issueRoutes).toContain('/:id/runs/:runId/production-health');
    expect(issueRoutes).toContain('/:id/runs/:runId/production-health/signals');
    expect(issueRoutes).toContain('/:id/runs/:runId/production-health/refresh');
    expect(issueStore).toContain('IssueRunProductionHealthDraft');
    expect(issueStore).toContain('runProductionHealthByRun');
    expect(issueStore).toContain('loadIssueRunProductionHealth');
    expect(issueStore).toContain('refreshIssueRunProductionHealth');
    expect(issueStore).toContain('recordIssueRunProductionHealthSignal');
    expect(issueDetail).toContain('Production Health');
    expect(issueDetail).toContain('RunProductionHealthPanel');
    expect(issueDetail).toContain('onRefreshProductionHealth');
    expect(issueDetail).toContain('onRecordProductionHealthSignal');
  });

  test('Issue detail exposes remediation orchestrator state and actions', () => {
    const issueStore = readFileSync(join(repoRoot, 'web/src/stores/issues.ts'), 'utf8');
    const issueDetail = readFileSync(join(repoRoot, 'web/src/pages/IssueDetailPage.tsx'), 'utf8');
    const orchestrationPage = readFileSync(join(repoRoot, 'web/src/pages/OrchestrationPage.tsx'), 'utf8');

    expect(issueStore).toContain('IssueRunRemediationDraft');
    expect(issueStore).toContain('runRemediationByRun');
    expect(issueStore).toContain('loadIssueRunRemediation');
    expect(issueStore).toContain('refreshIssueRunRemediation');
    expect(issueStore).toContain('recordIssueRunRemediationAction');
    expect(issueDetail).toContain('Remediation Orchestrator');
    expect(issueDetail).toContain('RunRemediationPanel');
    expect(orchestrationPage).toContain('remediation_proposed');
    expect(orchestrationPage).toContain('remediation_waiting_approval');
    expect(compact(orchestrationPage)).toContain("event.type === 'remediation_waiting_approval'");
    expect(compact(orchestrationPage)).toContain("event.type === 'remediation_failed'");
    expect(compact(orchestrationPage)).toContain("event.type === 'release_rollback_required'");
    expect(compact(orchestrationPage)).toContain("event.type === 'production_incident'");
    expect(compact(orchestrationPage)).toContain('await loadControl({ source:');
    expect(compact(orchestrationPage)).toContain('onClick={() => void loadControl(orchestrationControlQuery(searchParams))}');
  });

  test('Issue detail exposes incident knowledge base state and archive action', () => {
    const issueStore = readFileSync(join(repoRoot, 'web/src/stores/issues.ts'), 'utf8');
    const issueDetail = readFileSync(join(repoRoot, 'web/src/pages/IssueDetailPage.tsx'), 'utf8');
    const orchestrationStore = readFileSync(join(repoRoot, 'web/src/stores/orchestration.ts'), 'utf8');
    const orchestrationPage = readFileSync(join(repoRoot, 'web/src/pages/OrchestrationPage.tsx'), 'utf8');

    expect(issueStore).toContain('IssueRunIncidentKnowledgeDraft');
    expect(issueStore).toContain('runIncidentKnowledgeByRun');
    expect(issueStore).toContain('loadIssueRunIncidentKnowledge');
    expect(issueStore).toContain('archiveIssueRunIncidentKnowledge');
    expect(issueStore).toContain('IssueRunIncidentKnowledgeRemediationAction');
    expect(issueStore).toContain('IssueRunIncidentKnowledgeVerificationSignal');
    expect(issueDetail).toContain('Incident Knowledge Base');
    expect(issueDetail).toContain('RunIncidentKnowledgePanel');
    expect(issueDetail).toContain('entry.remediationActions?.map((action) =>');
    expect(issueDetail).toContain('entry.verificationSignals?.map((signal) =>');
    expect(orchestrationStore).toContain("'incident_archived'");
    expect(orchestrationStore).toContain("'incident_resolved'");
    expect(orchestrationPage).toContain('incident_archived');
    expect(orchestrationPage).toContain('incident_resolved');
  });

  test('Issue detail exposes runbook reuse engine state and orchestration mappings', () => {
    const issueStore = readFileSync(join(repoRoot, 'web/src/stores/issues.ts'), 'utf8');
    const issueDetail = readFileSync(join(repoRoot, 'web/src/pages/IssueDetailPage.tsx'), 'utf8');
    const orchestrationStore = readFileSync(join(repoRoot, 'web/src/stores/orchestration.ts'), 'utf8');
    const orchestrationPage = readFileSync(join(repoRoot, 'web/src/pages/OrchestrationPage.tsx'), 'utf8');

    expect(issueStore).toContain('IssueRunRunbookReuseDraft');
    expect(issueStore).toContain('runbookReuseByRun');
    expect(issueStore).toContain('loadIssueRunRunbookReuse');
    expect(issueStore).toContain('applyIssueRunRunbookReuse');
    expect(issueDetail).toContain('Runbook Reuse Engine');
    expect(issueDetail).toContain('RunbookReusePanel');
    expect(issueDetail).toContain("recommendation.status === 'reuse_recommended'");
    expect(issueDetail).toContain('!recommendation.approvalRequired');
    expect(orchestrationStore).toContain("'runbook_reuse_applied'");
    expect(orchestrationStore).toContain("'runbook_reuse_recommended'");
    expect(orchestrationStore).toContain("'runbook_reuse_blocked'");
    expect(orchestrationPage).toContain('runbook_reuse_applied');
    expect(orchestrationPage).toContain('runbook_reuse_recommended');
    expect(orchestrationPage).toContain('runbook_reuse_blocked');
  });

  test('Issue detail exposes fix run spawner state and orchestration mappings', () => {
    const issueStore = readFileSync(join(repoRoot, 'web/src/stores/issues.ts'), 'utf8');
    const issueDetail = readFileSync(join(repoRoot, 'web/src/pages/IssueDetailPage.tsx'), 'utf8');
    const orchestrationStore = readFileSync(join(repoRoot, 'web/src/stores/orchestration.ts'), 'utf8');
    const orchestrationPage = readFileSync(join(repoRoot, 'web/src/pages/OrchestrationPage.tsx'), 'utf8');

    expect(issueStore).toContain('IssueRunFixRunDraft');
    expect(issueStore).toContain('fixRunDraftsByRun');
    expect(issueStore).toContain('loadIssueRunFixRunDraft');
    expect(issueStore).toContain('spawnIssueRunFixRun');
    expect(issueDetail).toContain('Fix Run Spawner');
    expect(issueDetail).toContain('FixRunSpawnerPanel');
    expect(issueDetail).toContain("draft.status === 'draft_ready'");
    expect(orchestrationStore).toContain("'fix_run_spawned'");
    expect(orchestrationStore).toContain("'fix_run_blocked'");
    expect(orchestrationPage).toContain('fix_run_proposed');
    expect(orchestrationPage).toContain('fix_run_spawned');
    expect(orchestrationPage).toContain('fix_run_blocked');
  });

  test('Issue detail exposes fix run outcome verifier state and orchestration mappings', () => {
    const issueStore = readFileSync(join(repoRoot, 'web/src/stores/issues.ts'), 'utf8');
    const issueDetail = readFileSync(join(repoRoot, 'web/src/pages/IssueDetailPage.tsx'), 'utf8');
    const orchestrationStore = readFileSync(join(repoRoot, 'web/src/stores/orchestration.ts'), 'utf8');
    const orchestrationPage = readFileSync(join(repoRoot, 'web/src/pages/OrchestrationPage.tsx'), 'utf8');

    expect(issueStore).toContain('IssueRunFixRunOutcome');
    expect(issueStore).toContain('fixRunOutcomesByRun');
    expect(issueStore).toContain('loadIssueRunFixRunOutcome');
    expect(issueStore).toContain('verifyIssueRunFixRunOutcome');
    expect(issueDetail).toContain('Fix Run Outcome');
    expect(issueDetail).toContain('FixRunOutcomePanel');
    expect(issueDetail).toContain('Verify Outcome');
    expect(orchestrationStore).toContain("'fix_run_resolved'");
    expect(orchestrationStore).toContain("'fix_run_failed'");
    expect(orchestrationStore).toContain("'fix_run_needs_review'");
    expect(orchestrationPage).toContain('fix_run_verifying');
    expect(orchestrationPage).toContain('fix_run_resolved');
    expect(orchestrationPage).toContain('fix_run_failed');
    expect(orchestrationPage).toContain('fix_run_needs_review');
  });

  test('Issue detail exposes resolution gate state, action, and orchestration mappings', () => {
    const issueStore = readFileSync(join(repoRoot, 'web/src/stores/issues.ts'), 'utf8');
    const issueDetail = readFileSync(join(repoRoot, 'web/src/pages/IssueDetailPage.tsx'), 'utf8');
    const orchestrationStore = readFileSync(join(repoRoot, 'web/src/stores/orchestration.ts'), 'utf8');

    expect(issueStore).toContain('IssueRunResolutionGate');
    expect(issueStore).toContain('resolutionGatesByRun');
    expect(issueStore).toContain('loadIssueRunResolutionGate');
    expect(issueStore).toContain('applyIssueRunResolutionGate');
    expect(issueDetail).toContain('Resolution Gate');
    expect(issueDetail).toContain('ResolutionGatePanel');
    expect(issueDetail).toContain("gate.status === 'ready'");
    expect(issueDetail).toContain('!gate.approvalRequired');
    expect(orchestrationStore).toContain("'resolution_ready'");
    expect(orchestrationStore).toContain("'resolution_applied'");
    expect(orchestrationStore).toContain("'resolution_blocked'");
    expect(orchestrationStore).toContain("'resolution_needs_review'");
  });

  test('Chat view consumes stream events through standard AgentTask event bridge', () => {
    const chatView = readFileSync(
      join(repoRoot, 'web/src/components/chat/ChatView.tsx'),
      'utf8',
    );

    expect(chatView).toContain("wsManager.on('octodeck_event:agent_task'");
    expect(chatView).toContain("event.type?.startsWith('agent_task.stream.')");
    expect(compact(chatView)).toContain(
      'handleStreamEvent(groupJid, event.payload.event, event.payload.agentId)',
    );
    expect(chatView).not.toContain("wsManager.on('stream_event'");
  });

  test('Chat view consumes stream snapshots and websocket errors through standard event bridges', () => {
    const webEvents = readFileSync(join(repoRoot, 'web/src/realtime-events.ts'), 'utf8');
    const chatView = readFileSync(
      join(repoRoot, 'web/src/components/chat/ChatView.tsx'),
      'utf8',
    );

    expect(webEvents).toContain("data.type === 'stream_snapshot'");
    expect(webEvents).toContain('agent_task.stream.snapshot');
    expect(webEvents).toContain("data.type === 'ws_error'");
    expect(webEvents).toContain('system.ws.error');
    expect(chatView).toContain("wsManager.on('octodeck_event:agent_task'");
    expect(chatView).toContain("event.type === 'agent_task.stream.snapshot'");
    expect(chatView).toContain('event.payload.snapshot');
    expect(chatView).toContain("wsManager.on('octodeck_event:system'");
    expect(chatView).toContain("event.type === 'system.ws.error'");
    expect(chatView).toContain('event.payload.error');
    expect(chatView).not.toContain("wsManager.on('stream_snapshot'");
    expect(chatView).not.toContain("wsManager.on('ws_error'");
  });

  test('AppLayout consumes runner and sub-agent status through standard event bridge', () => {
    const webEvents = readFileSync(join(repoRoot, 'web/src/realtime-events.ts'), 'utf8');
    const appLayout = readFileSync(
      join(repoRoot, 'web/src/components/layout/AppLayout.tsx'),
      'utf8',
    );

    expect(webEvents).toContain("data.type === 'agent_status'");
    expect(webEvents).toContain("agent_task.agent_status.${data.status}");
    expect(appLayout).toContain("event?.type?.startsWith('runtime.runner.')");
    expect(appLayout).toContain("event?.type?.startsWith('agent_task.agent_status.')");
    expect(appLayout).toContain('handleAgentStatus(');
    expect(appLayout).toContain('event.payload.agentId');
    expect(appLayout).not.toContain("wsManager.on('runner_state'");
    expect(appLayout).not.toContain("wsManager.on('agent_status'");
  });

  test('Terminal panel consumes terminal lifecycle through standard runtime event bridge', () => {
    const webEvents = readFileSync(join(repoRoot, 'web/src/realtime-events.ts'), 'utf8');
    const terminalPanel = readFileSync(
      join(repoRoot, 'web/src/components/chat/TerminalPanel.tsx'),
      'utf8',
    );

    expect(webEvents).toContain("data.type === 'terminal_output'");
    expect(webEvents).toContain('runtime.terminal.output');
    expect(webEvents).toContain('runtime.terminal.started');
    expect(webEvents).toContain('runtime.terminal.stopped');
    expect(webEvents).toContain('runtime.terminal.error');
    expect(terminalPanel).toContain("wsManager.on('octodeck_event:runtime'");
    expect(terminalPanel).toContain("event.type === 'runtime.terminal.output'");
    expect(terminalPanel).toContain('terminal.write(event.payload.data)');
    expect(terminalPanel).toContain("event.type === 'runtime.terminal.error'");
    expect(terminalPanel).not.toContain("wsManager.on('terminal_output'");
    expect(terminalPanel).not.toContain("wsManager.on('terminal_started'");
    expect(terminalPanel).not.toContain("wsManager.on('terminal_stopped'");
    expect(terminalPanel).not.toContain("wsManager.on('terminal_error'");
  });

  test('Monitor page consumes docker build progress through standard system event bridge', () => {
    const webEvents = readFileSync(join(repoRoot, 'web/src/realtime-events.ts'), 'utf8');
    const monitorStore = readFileSync(join(repoRoot, 'web/src/stores/monitor.ts'), 'utf8');
    const monitorPage = readFileSync(
      join(repoRoot, 'web/src/pages/MonitorPage.tsx'),
      'utf8',
    );

    expect(webEvents).toContain("data.type === 'docker_build_log'");
    expect(webEvents).toContain('system.docker_build.log');
    expect(webEvents).toContain('system.docker_build.complete');
    expect(monitorPage).toContain("wsManager.on('octodeck_event:system'");
    expect(monitorPage).toContain("event.type === 'system.docker_build.log'");
    expect(monitorStore).toContain('applyDockerBuildEvent');
    expect(monitorStore).toContain('line: string');
    expect(monitorPage).toContain('applyDockerBuildEvent(event)');
    expect(monitorPage).toContain("event.type === 'system.docker_build.complete'");
    expect(monitorPage).toContain('subtitle="实时监控系统状态（事件驱动，手动刷新兜底）"');
    expect(monitorPage).not.toContain('setInterval(() =>');
    expect(monitorPage).not.toContain('clearInterval(interval)');
    expect(monitorPage).not.toContain("wsManager.on('docker_build_log'");
    expect(monitorPage).not.toContain("wsManager.on('docker_build_complete'");
  });

  test('WhatsApp channel card consumes live status through standard device event bridge', () => {
    const webEvents = readFileSync(join(repoRoot, 'web/src/realtime-events.ts'), 'utf8');
    const whatsappCard = readFileSync(
      join(repoRoot, 'web/src/components/settings/WhatsAppChannelCard.tsx'),
      'utf8',
    );

    expect(webEvents).toContain("data.type === 'whatsapp_status'");
    expect(webEvents).toContain('device.whatsapp.${data.status}');
    expect(whatsappCard).toContain("wsManager.on('octodeck_event:device'");
    expect(whatsappCard).toContain("event.type?.startsWith('device.whatsapp.')");
    expect(whatsappCard).toContain('const status = event.payload as WhatsAppStatusEvent');
    expect(whatsappCard).toContain('status.qrDataUrl');
    expect(whatsappCard).not.toContain("wsManager.on('whatsapp_status'");
  });

  test('frontend consumes standard OctoDeck events through notification inbox and store bridges', () => {
    const wsSource = readFileSync(join(repoRoot, 'web/src/api/ws.ts'), 'utf8');
    const appLayout = readFileSync(
      join(repoRoot, 'web/src/components/layout/AppLayout.tsx'),
      'utf8',
    );
    const notificationsStore = readFileSync(
      join(repoRoot, 'web/src/stores/notifications.ts'),
      'utf8',
    );
    const notificationCenter = readFileSync(
      join(repoRoot, 'web/src/components/layout/NotificationInbox.tsx'),
      'utf8',
    );

    expect(wsSource).toContain('octodeckEventsFromWsMessage');
    expect(wsSource).toContain("this.emit('octodeck_event:any'");
    expect(wsSource).toContain('octodeck_event:${event.domain}');
    expect(appLayout).toContain("wsManager.on('octodeck_event:approval'");
    expect(appLayout).toContain("wsManager.on('octodeck_event:runtime'");
    expect(appLayout).toContain("wsManager.on('octodeck_event:device'");
    expect(appLayout).toContain('NotificationInbox');
    expect(notificationsStore).toContain('groupOctoDeckEventsForNotificationInbox');
    expect(notificationsStore).toContain('recordEvent');
    expect(notificationsStore).toContain('unreadCount');
    expect(notificationCenter).toContain('Approval Inbox');
    expect(notificationCenter).toContain('markAllRead');
    expect(notificationCenter).toContain('Notification Inbox');
    expect(notificationsStore).toContain("event.domain === 'autopilot'");
    expect(notificationsStore).toContain('item.status === \'unread\'');
  });

  test('WebSocket manager exposes only control and standard OctoDeck event subscriptions', () => {
    const wsSource = readFileSync(join(repoRoot, 'web/src/api/ws.ts'), 'utf8');

    expect(wsSource).toContain('type WsEventName');
    expect(wsSource).toContain('octodeck_event:${OctoDeckEventDomain | \'any\'}');
    expect(wsSource).toContain('on(type: WsEventName, handler: WsHandler)');
    expect(wsSource).not.toContain('on(type: string, handler: WsHandler)');
    expect(wsSource).not.toContain('this.emit(data.type, data)');
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

  test('realtime standard events cover repo knowledge and memory domain bridges', () => {
    const webEvents = readFileSync(join(repoRoot, 'web/src/realtime-events.ts'), 'utf8');
    const appLayout = readFileSync(
      join(repoRoot, 'web/src/components/layout/AppLayout.tsx'),
      'utf8',
    );
    const reposPage = readFileSync(
      join(repoRoot, 'web/src/pages/ReposPage.tsx'),
      'utf8',
    );
    const repoRoutes = readFileSync(join(repoRoot, 'src/routes/repos.ts'), 'utf8');
    const memoryRoutes = readFileSync(join(repoRoot, 'src/routes/memory.ts'), 'utf8');

    expect(webEvents).toContain('repo_knowledge_run_state');
    expect(webEvents).toContain('memory_update');
    expect(webEvents).toContain('memory_recall');
    expect(appLayout).toContain('useReposStore');
    expect(appLayout).toContain("wsManager.on('octodeck_event:repo_knowledge'");
    expect(appLayout).toContain("wsManager.on('octodeck_event:memory'");
    expect(appLayout).toContain('loadKnowledgeRun');
    expect(repoRoutes).toContain('broadcastOctoDeckEvent');
    expect(repoRoutes).toContain("domain: 'repo_knowledge'");
    expect(repoRoutes).toContain('repo_knowledge.run.queued');
    expect(repoRoutes).toContain('repo_knowledge.run.ready');
    expect(reposPage).not.toContain("repo.knowledge?.status === 'indexing'");
    expect(reposPage).not.toContain('window.setInterval(() =>');
    expect(reposPage).not.toContain('window.clearInterval(timer)');
    expect(memoryRoutes).toContain('broadcastOctoDeckEvent');
    expect(memoryRoutes).toContain("domain: 'memory'");
    expect(memoryRoutes).toContain('memory.global.updated');
    expect(memoryRoutes).toContain('memory.agent.synced');
  });

  test('Issue detail consumes AgentTask ledger through the read-only task API', () => {
    const taskRoutes = readFileSync(join(repoRoot, 'src/routes/tasks.ts'), 'utf8');
    const issueStore = readFileSync(
      join(repoRoot, 'web/src/stores/issues.ts'),
      'utf8',
    );
    const issueDetail = readFileSync(
      join(repoRoot, 'web/src/pages/IssueDetailPage.tsx'),
      'utf8',
    );

    expect(taskRoutes).toContain("tasksRoutes.get('/agent-runs'");
    expect(taskRoutes).toContain('getIssueById');
    expect(taskRoutes).toContain('canAccessGroup');
    expect(taskRoutes).toContain('canAccessIssueAgentRuns');
    expect(taskRoutes).toContain('source_type');
    expect(taskRoutes).toContain('source_ref');
    expect(issueStore).toContain('AgentTaskLedgerRow');
    expect(issueStore).toContain('agentTasksByIssue');
    expect(issueStore).toContain('loadAgentTasksForIssue');
    expect(issueStore).toContain('/api/tasks/agent-runs?source_type=issue_run');
    expect(issueDetail).toContain('loadAgentTasksForIssue(issueId)');
    expect(issueDetail).toContain('AgentTask Ledger');
    expect(issueDetail).toContain('source_type');
    expect(issueDetail).toContain('run_ref');
  });

  test('Task detail consumes scheduled task runs from the AgentTask ledger', () => {
    const taskRoutes = readFileSync(join(repoRoot, 'src/routes/tasks.ts'), 'utf8');
    const taskStore = readFileSync(
      join(repoRoot, 'web/src/stores/tasks.ts'),
      'utf8',
    );
    const taskDetail = readFileSync(
      join(repoRoot, 'web/src/components/tasks/TaskDetail.tsx'),
      'utf8',
    );

    expect(taskRoutes).toContain('canAccessScheduledTaskAgentRuns');
    expect(taskRoutes).toContain('getTaskById');
    expect(taskStore).toContain('AgentTaskLedgerRow');
    expect(taskStore).toContain('agentRunsByTask');
    expect(taskStore).toContain('loadAgentRunsForTask');
    expect(taskStore).toContain('/api/tasks/agent-runs?source_type=scheduled_task');
    expect(taskDetail).toContain('loadAgentRunsForTask(task.id)');
    expect(taskDetail).toContain('AgentTask Ledger');
    expect(taskDetail).toContain('run_ref');
    expect(taskDetail).toContain('runtime_profile');
  });

  test('Tasks page relies on scheduled task AgentTask events instead of parsing-state polling', () => {
    const taskRoutes = readFileSync(join(repoRoot, 'src/routes/tasks.ts'), 'utf8');
    const tasksPage = readFileSync(
      join(repoRoot, 'web/src/pages/TasksPage.tsx'),
      'utf8',
    );
    const appLayout = readFileSync(
      join(repoRoot, 'web/src/components/layout/AppLayout.tsx'),
      'utf8',
    );

    expect(taskRoutes).toContain('broadcastScheduledTaskEvent');
    expect(taskRoutes).toContain('createOctoDeckEvent');
    expect(taskRoutes).toContain('agent_task.scheduled_task.${task.status}');
    expect(taskRoutes).toContain("domain: 'agent_task'");
    expect(taskRoutes).toContain("source_type: 'scheduled_task'");
    expect(appLayout).toContain("wsManager.on('octodeck_event:agent_task'");
    expect(appLayout).toContain('useTasksStore.getState().loadTasks()');
    expect(tasksPage).not.toContain("status === 'parsing'");
    expect(tasksPage).not.toContain('setInterval(loadTasks, 3000)');
    expect(tasksPage).not.toContain('clearInterval(interval)');
  });

  test('Issue run creation uses runtime pool admission before enqueueing work', () => {
    const issueRoutes = readFileSync(join(repoRoot, 'src/routes/issues.ts'), 'utf8');
    const runtimePool = readFileSync(join(repoRoot, 'src/runtime-pool.ts'), 'utf8');

    expect(runtimePool).toContain('resolveRuntimeSchedulingTarget');
    expect(issueRoutes).toContain('assertIssueRunRuntimeAdmissible');
    expect(issueRoutes).toContain('buildRuntimePoolSnapshot');
    expect(issueRoutes).toContain('resolveRuntimeSchedulingTarget');
    expect(issueRoutes).toContain('Selected runtime is not schedulable');
    expect(issueRoutes).toContain('resolvedExecutionNode');
    expect(issueRoutes).toContain('execution_node: runtimeAdmission.resolvedExecutionNode');
  });

  test('permission approval routes enforce task-scoped token evaluation and audit trail', () => {
    const issueRoutes = readFileSync(join(repoRoot, 'src/routes/issues.ts'), 'utf8');

    expect(issueRoutes).toContain('evaluateAgentTaskScopedApprovalRequest');
    expect(issueRoutes).toContain('getAgentTaskScopedTokenById');
    expect(issueRoutes).toContain('agent_task_token_used');
    expect(issueRoutes).toContain('agent_task_token_rejected');
    expect(issueRoutes).toContain('permission_decision');
  });
});
