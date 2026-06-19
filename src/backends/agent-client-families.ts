import type { CustomBackendDef } from './dynamic.js';

export type AgentClientFamily = 'claude' | 'codex' | 'traex';

export type AgentClientTemplate = Pick<
  CustomBackendDef,
  | 'argvTemplate'
  | 'outputProtocol'
  | 'supportsNativeSessions'
  | 'sessionArgvTemplate'
  | 'resumeArgvTemplate'
>;

export function inferAgentClientFamily(
  id: string | undefined | null,
  hint?: string | null,
): AgentClientFamily | undefined {
  const candidates = [hint, id]
    .map((value) => (value || '').toLowerCase().trim())
    .filter(Boolean);
  for (const value of candidates) {
    if (value === 'claude' || value === 'claude-code' || value.includes('claude')) return 'claude';
    if (value === 'codex' || value.includes('codex')) return 'codex';
    if (value === 'traex' || value.includes('traex')) return 'traex';
  }
  return undefined;
}

const CLAUDE_TEMPLATE: AgentClientTemplate = {
  argvTemplate: [
    '-p',
    '{prompt}',
    '--model',
    '{model}',
    '--output-format',
    'stream-json',
    '--verbose',
    '--mcp-config',
    '__OCTODECK_AGENT_TEAM_MCP_CONFIG__',
  ],
  outputProtocol: 'jsonline-stream-json',
  supportsNativeSessions: true,
  sessionArgvTemplate: ['--resume={sessionId}'],
};

const CODEX_TEMPLATE: AgentClientTemplate = {
  argvTemplate: [
    'exec',
    '--json',
    '--skip-git-repo-check',
    '-m',
    '{model}',
    '{prompt}',
  ],
  outputProtocol: 'jsonline-stream-json',
  supportsNativeSessions: true,
  resumeArgvTemplate: [
    'exec',
    'resume',
    '--json',
    '--skip-git-repo-check',
    '-m',
    '{model}',
    '{sessionId}',
    '{prompt}',
  ],
};

const TRAEX_TEMPLATE: AgentClientTemplate = {
  argvTemplate: [
    'exec',
    '--json',
    '--skip-git-repo-check',
    '-m',
    '{model}',
    '{prompt}',
  ],
  outputProtocol: 'jsonline-stream-json',
  supportsNativeSessions: true,
  resumeArgvTemplate: [
    'exec',
    'resume',
    '--json',
    '--skip-git-repo-check',
    '-m',
    '{model}',
    '{sessionId}',
    '{prompt}',
  ],
};

export function templateForAgentClientFamily(
  family: AgentClientFamily,
): AgentClientTemplate {
  switch (family) {
    case 'claude':
      return CLAUDE_TEMPLATE;
    case 'codex':
      return CODEX_TEMPLATE;
    case 'traex':
      return TRAEX_TEMPLATE;
  }
}

export function templateForAgentClient(
  id: string,
  familyHint?: string | null,
): AgentClientTemplate {
  const family = inferAgentClientFamily(id, familyHint);
  if (!family) throw new Error(`不支持的 Agent client: ${id}`);
  return templateForAgentClientFamily(family);
}

export function transportForAgentClient(
  id: string | undefined | null,
  familyHint?: string | null,
): 'stdio' | 'acp' | undefined {
  const normalizedId = (id || '').toLowerCase().trim();
  const normalizedHint = (familyHint || '').toLowerCase().trim();
  if (normalizedId.includes('acp') || normalizedHint.includes('acp')) return 'acp';
  const family = inferAgentClientFamily(id, familyHint);
  if (family === 'traex') return 'acp';
  if (family === 'claude' || family === 'codex') return 'stdio';
  return undefined;
}
