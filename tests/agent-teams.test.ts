import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

let tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'octodeck-agent-teams-'));

vi.mock('../src/config.js', () => ({
  get DATA_DIR() {
    return tmpDataDir;
  },
}));

const agentTeams = await import('../src/agent-teams.js');

beforeEach(() => {
  fs.rmSync(tmpDataDir, { recursive: true, force: true });
  fs.mkdirSync(tmpDataDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDataDir, { recursive: true, force: true });
});

describe('agent team definitions', () => {
  test('creates and persists reusable agent.md definitions', () => {
    const created = agentTeams.createAgentMdDefinition({
      name: 'Frontend Implementer',
      summary: '负责 React 页面实现、状态管理和交互细节。',
      content: '# Frontend Implementer\n\n你负责把产品需求实现为可靠的前端页面。',
      createdByAgentId: 'claude-sdk',
    });

    expect(created.id).toMatch(/^agent_md_[0-9a-f]{12}$/);
    expect(created.summary).toContain('React 页面实现');
    expect(agentTeams.listAgentMdDefinitions()).toEqual([created]);

    const updated = agentTeams.updateAgentMdDefinition(created.id, {
      summary: '负责 React、测试和上线验证。',
    });
    expect(updated?.summary).toBe('负责 React、测试和上线验证。');

    expect(agentTeams.deleteAgentMdDefinition(created.id)).toBe(true);
    expect(agentTeams.listAgentMdDefinitions()).toEqual([]);
  });

  test('isolates agent.md definitions and teams by owner user', () => {
    const userOneDefinition = agentTeams.createAgentMdDefinition({
      name: 'User One Writer',
      summary: '只属于用户一的 agent.md。',
      content: '# User One Writer',
      createdByAgentId: 'claude-sdk',
    }, 'user_one');
    const userTwoDefinition = agentTeams.createAgentMdDefinition({
      name: 'User Two Writer',
      summary: '只属于用户二的 agent.md。',
      content: '# User Two Writer',
      createdByAgentId: 'claude-sdk',
    }, 'user_two');

    expect(agentTeams.listAgentMdDefinitions('user_one')).toEqual([userOneDefinition]);
    expect(agentTeams.listAgentMdDefinitions('user_two')).toEqual([userTwoDefinition]);
    expect(agentTeams.getAgentMdDefinition(userTwoDefinition.id, 'user_one')).toBeNull();
    expect(agentTeams.updateAgentMdDefinition(userTwoDefinition.id, { summary: 'leak' }, 'user_one')).toBeNull();
    expect(agentTeams.deleteAgentMdDefinition(userTwoDefinition.id, 'user_one')).toBe(false);

    const userOneTeam = agentTeams.createAgentTeam({
      name: 'User One Team',
      goal: '用户一目标',
      shape: 'pipeline',
      description: '用户一团队',
      roles: [{ id: 'lead', name: 'Lead', responsibility: '负责用户一目标。' }],
      workflow: 'Pipeline workflow',
      successCriteria: ['只对用户一可见'],
      createdByAgentId: 'claude-sdk',
    }, 'user_one');
    const userTwoTeam = agentTeams.createAgentTeam({
      ...agentTeams.buildAgentTeamDraft({
        generatorAgentId: 'claude-sdk',
        goal: '用户二目标',
        shape: 'leader-worker',
      }),
      name: 'User Two Team',
    }, 'user_two');

    expect(userOneDefinition.createdByUserId).toBe('user_one');
    expect(userOneTeam.createdByUserId).toBe('user_one');
    expect(agentTeams.listAgentTeams('user_one')).toEqual([userOneTeam]);
    expect(agentTeams.listAgentTeams('user_two')).toEqual([userTwoTeam]);
    expect(agentTeams.getAgentTeam(userTwoTeam.id, 'user_one')).toBeNull();
    expect(agentTeams.updateAgentTeam(userTwoTeam.id, { name: 'leak' }, 'user_one')).toBeNull();
    expect(agentTeams.deleteAgentTeam(userTwoTeam.id, 'user_one')).toBe(false);
  });

  test('builds generation prompt with existing agent.md summaries and allows new agent.md authoring', () => {
    const draft = agentTeams.buildAgentTeamDraft({
      generatorAgentId: 'planner-agent',
      goal: '实现一个复杂前端功能',
      shape: 'leader-worker',
    });
    const prompt = agentTeams.buildAgentTeamGenerationPrompt(draft, [
      {
        id: 'agent_md_frontend',
        name: 'Frontend Implementer',
        summary: '擅长 React 页面实现和交互状态管理。',
      },
    ]);

    expect(prompt).toContain('现有 agent.md 简介');
    expect(prompt).toContain('Frontend Implementer');
    expect(prompt).toContain('擅长 React 页面实现');
    expect(prompt).toContain('优先复用现有 agent.md');
    expect(prompt).toContain('只有当现有 agent.md 无法覆盖某个必要角色时');
    expect(prompt).toContain('在角色的 skills 或 guardrails 中写明建议使用的 agent.md 名称');
    expect(prompt).toContain('agentMdDefinitionsToCreate');
    expect(prompt).toContain('如果现有 agent.md 不满足需求');
    expect(prompt).toContain('单轮结构化 JSON 输出任务');
    expect(prompt).toContain('不要调用任何工具或 Skill');
    expect(prompt).toContain('每个新 agent.md content 控制在 1200 字以内');
    expect(prompt).toContain('如果 Interaction shape 是 auto，team.shape 必须返回模型实际选择的具体形态');
    expect(prompt).toContain('不要在生成结果的 team.shape 中继续返回 auto');
  });

  test('rejects generated team content that semantically binds concrete cli or device', () => {
    const draft = agentTeams.buildAgentTeamDraft({
      generatorAgentId: 'planner-agent',
      goal: '实现一个复杂前端功能',
      shape: 'parallel',
    });

    expect(agentTeams.isAbstractAgentTeamDefinition(draft)).toBe(true);
    expect(agentTeams.isAbstractAgentTeamDefinition({
      ...draft,
      workflow: '让 builder 在 /Users/alice/project 中调用 claude-code provider 执行。',
    })).toBe(false);
  });

  test('creates and persists a team definition without binding concrete agent cli', () => {
    const created = agentTeams.createAgentTeam({
      name: 'Research Delivery Team',
      goal: '研究竞品并输出产品建议',
      shape: 'leader-worker',
      description: '负责从调研到交付建议的抽象团队。',
      roles: [
        {
          id: 'lead',
          name: 'Lead Researcher',
          responsibility: '拆解目标并协调其他角色。',
          inputs: ['用户目标'],
          outputs: ['研究计划'],
          skills: ['问题拆解'],
          guardrails: ['不绑定具体 CLI'],
        },
      ],
      workflow: 'Lead Researcher 先拆解目标，再汇总交付。',
      successCriteria: ['输出可执行建议'],
      createdByAgentId: 'claude-sdk',
    });

    expect(created.id).toMatch(/^team_[0-9a-f]{12}$/);
    expect(created.createdByAgentId).toBe('claude-sdk');
    expect(created.roles[0]).not.toHaveProperty('agentId');
    expect(created.roles[0]).not.toHaveProperty('agentClientId');
    expect(created.roles[0]).not.toHaveProperty('deviceLinkId');
    expect(agentTeams.listAgentTeams()).toEqual([created]);
  });

  test('builds an editable team draft from user goal and selected shape', () => {
    const draft = agentTeams.buildAgentTeamDraft({
      generatorAgentId: 'planner-agent',
      goal: '帮我完成一个从需求分析到上线验证的前端功能开发',
      shape: 'pipeline',
    });

    expect(draft.createdByAgentId).toBe('planner-agent');
    expect(draft.shape).toBe('pipeline');
    expect(draft.roles.length).toBeGreaterThanOrEqual(3);
    expect(draft.workflow).toContain('Pipeline');
    expect(JSON.stringify(draft)).not.toContain('agentClientId');
    expect(JSON.stringify(draft)).not.toContain('deviceLinkId');
  });

  test('does not expose local timeout fallback for agent team generation', () => {
    expect(agentTeams).not.toHaveProperty('resolveAgentTeamGenerationWithTimeout');
  });

  test('updates and deletes an existing team definition', () => {
    const created = agentTeams.createAgentTeam(
      agentTeams.buildAgentTeamDraft({
        generatorAgentId: 'claude-sdk',
        goal: '整理周会纪要并跟进待办',
        shape: 'auto',
      }),
    );

    const updated = agentTeams.updateAgentTeam(created.id, {
      name: 'Meeting Follow-up Team',
      successCriteria: ['纪要准确', '待办有人负责'],
    });

    expect(updated?.name).toBe('Meeting Follow-up Team');
    expect(updated?.successCriteria).toEqual(['纪要准确', '待办有人负责']);
    expect(agentTeams.deleteAgentTeam(created.id)).toBe(true);
    expect(agentTeams.listAgentTeams()).toEqual([]);
  });
});
