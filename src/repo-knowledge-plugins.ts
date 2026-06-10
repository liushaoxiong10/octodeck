import fs from 'node:fs';
import path from 'node:path';

export type RepoKnowledgePluginId = 'builtin' | 'graphify' | 'codegraph' | 'agent';

export interface RepoKnowledgePluginStatus {
  id: RepoKnowledgePluginId;
  displayName: string;
  version?: string;
  bundled: boolean;
  available: boolean;
  selected: boolean;
  capabilities: string[];
  reason?: string;
}

export interface RepoKnowledgePluginSelection {
  provider: RepoKnowledgePluginId | 'auto';
  requestedProvider: string;
  fallbackBuiltin: boolean;
  statuses: RepoKnowledgePluginStatus[];
}

const DEFAULT_TOOLS_DIR = path.join(process.cwd(), 'data', 'tools', 'repo-knowledge');

export function getRepoKnowledgePluginBin(tool: 'graphify' | 'codegraph'): string {
  const override = tool === 'graphify'
    ? process.env.REPO_KNOWLEDGE_GRAPHIFY_BIN
    : process.env.REPO_KNOWLEDGE_CODEGRAPH_BIN;
  if (override?.trim()) return override.trim();
  const toolsDir = process.env.REPO_KNOWLEDGE_TOOLS_DIR || DEFAULT_TOOLS_DIR;
  return path.join(toolsDir, tool, 'bin', tool);
}

function isExecutableFile(filePath: string): boolean {
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

export function listRepoKnowledgePlugins(selectedProvider?: string): RepoKnowledgePluginStatus[] {
  const selected = (selectedProvider || process.env.REPO_KNOWLEDGE_GRAPH_PROVIDER || 'builtin').trim().toLowerCase();
  const graphifyBin = getRepoKnowledgePluginBin('graphify');
  const codegraphBin = getRepoKnowledgePluginBin('codegraph');
  const graphifyAvailable = isExecutableFile(graphifyBin);
  const codegraphAvailable = isExecutableFile(codegraphBin);
  return [
    {
      id: 'builtin',
      displayName: 'OctoDeck Built-in Graph Generator',
      version: '2',
      bundled: true,
      available: true,
      selected: selected === 'builtin' || selected === 'auto',
      capabilities: ['symbols', 'imports', 'dependencies', 'docs', 'graph', 'search-index'],
    },
    {
      id: 'agent',
      displayName: 'AI Agent Graph Generator (Skill-driven)',
      version: '1',
      bundled: true,
      available: true,
      selected: selected === 'agent',
      capabilities: ['llm-semantic', 'skills', 'external-graph', 'symbols', 'imports', 'dependencies', 'docs'],
      reason: '通过运行一次 Agent 任务，结合外挂 Skill 生成语义化知识图谱；基础层仍复用 builtin 保证完整性。',
    },
    {
      id: 'graphify',
      displayName: 'Hosted Graphify Adapter',
      bundled: graphifyAvailable,
      available: graphifyAvailable,
      selected: selected === 'graphify',
      capabilities: ['external-graph', 'symbols', 'imports'],
      reason: graphifyAvailable ? undefined : `托管 graphify 二进制未找到：${graphifyBin}`,
    },
    {
      id: 'codegraph',
      displayName: 'Hosted CodeGraph Adapter',
      bundled: codegraphAvailable,
      available: codegraphAvailable,
      selected: selected === 'codegraph',
      capabilities: ['external-graph', 'symbols', 'dependencies'],
      reason: codegraphAvailable ? undefined : `托管 codegraph 二进制未找到：${codegraphBin}`,
    },
  ];
}

export function selectRepoKnowledgePlugin(input?: {
  provider?: string;
  fallbackBuiltin?: boolean;
  allowRemote?: boolean;
}): RepoKnowledgePluginSelection {
  const requestedProvider = (input?.provider || process.env.REPO_KNOWLEDGE_GRAPH_PROVIDER || 'builtin').trim().toLowerCase();
  const fallbackBuiltin = input?.fallbackBuiltin ?? true;
  const statuses = listRepoKnowledgePlugins(requestedProvider);
  if (requestedProvider === 'agent') {
    return { provider: 'agent', requestedProvider, fallbackBuiltin, statuses };
  }
  if (requestedProvider === 'graphify' || requestedProvider === 'codegraph') {
    const status = statuses.find((item) => item.id === requestedProvider);
    return {
      provider: status?.available || input?.allowRemote ? requestedProvider : 'builtin',
      requestedProvider,
      fallbackBuiltin,
      statuses,
    };
  }
  if (requestedProvider === 'auto') {
    const external = statuses.find((item) => item.id !== 'builtin' && item.available);
    return { provider: external?.id ?? 'builtin', requestedProvider, fallbackBuiltin, statuses };
  }
  return { provider: 'builtin', requestedProvider, fallbackBuiltin, statuses };
}
