export type OrchestrationSource = 'issue' | 'task';
export type OrchestrationRiskLevel = 'low' | 'medium' | 'high' | 'critical';
export type OrchestrationMode = 'auto' | 'approval_required' | 'manual' | 'blocked';

export interface OrchestrationDecision {
  eligible: boolean;
  mode: 'auto' | 'approval_required' | 'manual' | 'blocked';
  enforcementAction: 'execute' | 'request_approval' | 'manual_review' | 'block';
  targetAgentId?: string;
  targetRuntimeId?: string;
  requiredSkillIds: string[];
  permissionScopes: string[];
  riskLevel: OrchestrationRiskLevel;
  reasons: string[];
  blockers: string[];
  approvalRequired: boolean;
}

interface CapabilityCatalogItem {
  id: string;
  kind: 'agent' | 'skill' | 'runtime';
  sourceId: string;
  displayName: string;
  description: string;
  capabilities: string[];
  permissionScopes: string[];
  riskLevel: OrchestrationRiskLevel;
  compatibleRuntimeIds: string[];
  runtimeCompatibility: {
    compatible: number;
    total: number;
    blockedRuntimeIds: string[];
  };
}

export interface OrchestrationPolicyInput {
  source: OrchestrationSource;
  item: {
    id: string;
    title: string;
    description?: string | null;
    priority?: string | null;
    selectedSkillIds?: string[] | null;
    agentClientId?: string | null;
    executionNode?: string | null;
  };
  registry: {
    summary?: { dependencyConflicts?: number };
    capabilityCatalog: CapabilityCatalogItem[];
  };
}

const RISK_RANK: Record<OrchestrationRiskLevel, number> = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

function maxRisk(left: OrchestrationRiskLevel, right: OrchestrationRiskLevel): OrchestrationRiskLevel {
  return RISK_RANK[left] >= RISK_RANK[right] ? left : right;
}

function uniqueSorted(values: Array<string | null | undefined>): string[] {
  return Array.from(new Set(values.flatMap((value) => {
    const normalized = value?.trim();
    return normalized ? [normalized] : [];
  }))).sort();
}

function inferRequestedCapabilities(input: OrchestrationPolicyInput): string[] {
  const text = `${input.item.title} ${input.item.description ?? ''}`.toLowerCase();
  const caps = new Set<string>();
  if (/repo|repository|code|file|read|summari[sz]e|总结|读取/.test(text)) caps.add('repo');
  if (/deploy|release|terminal|shell|command|run|执行|发布|部署/.test(text)) caps.add('terminal');
  if (/http|api|network|fetch|download|请求|网络/.test(text)) caps.add('network');
  if (input.item.selectedSkillIds?.length) caps.add('repo');
  return Array.from(caps).sort();
}

function chooseAgent(input: OrchestrationPolicyInput, requestedCapabilities: string[]): CapabilityCatalogItem | undefined {
  const agents = input.registry.capabilityCatalog.filter((item) => item.kind === 'agent');
  if (!agents.length) return undefined;
  return [...agents].sort((a, b) => {
    const aMatches = requestedCapabilities.filter((capability) => a.capabilities.includes(capability)).length;
    const bMatches = requestedCapabilities.filter((capability) => b.capabilities.includes(capability)).length;
    if (aMatches !== bMatches) return bMatches - aMatches;
    if (a.compatibleRuntimeIds.length !== b.compatibleRuntimeIds.length) return b.compatibleRuntimeIds.length - a.compatibleRuntimeIds.length;
    return RISK_RANK[a.riskLevel] - RISK_RANK[b.riskLevel];
  })[0];
}

export function evaluateOrchestrationPolicy(input: OrchestrationPolicyInput): OrchestrationDecision {
  const reasons: string[] = [];
  const blockers: string[] = [];
  const requestedCapabilities = inferRequestedCapabilities(input);
  const selectedAgent = chooseAgent(input, requestedCapabilities);

  if ((input.registry.summary?.dependencyConflicts ?? 0) > 0) {
    blockers.push('Registry dependency conflicts must be resolved before auto-dispatch');
  }
  if (!selectedAgent) {
    blockers.push('No registry agent is available for orchestration');
  }

  const targetRuntimeId = selectedAgent?.compatibleRuntimeIds[0];
  if (selectedAgent && !targetRuntimeId) {
    blockers.push('No compatible runtime is currently available for the selected agent');
  }

  if (requestedCapabilities.length) {
    reasons.push(`Matched agent capability: ${requestedCapabilities.join(' + ')}`);
  } else {
    reasons.push('Matched default agent capability');
  }
  if (targetRuntimeId) reasons.push('Runtime has compatible available capacity');

  const requiredSkillIds = uniqueSorted(input.item.selectedSkillIds ?? []);
  const permissionScopes = uniqueSorted(selectedAgent?.permissionScopes ?? []);
  let riskLevel: OrchestrationRiskLevel = selectedAgent?.riskLevel ?? 'low';
  if (input.item.priority === 'urgent') riskLevel = maxRisk(riskLevel, 'high');
  const approvalRequired = riskLevel === 'high' || riskLevel === 'critical' || permissionScopes.includes('repo_write') || permissionScopes.includes('terminal') || permissionScopes.includes('secrets');
  if (approvalRequired && !blockers.length) reasons.push('High-risk permission requires approval');

  if (blockers.length) {
    return {
      eligible: false,
      mode: 'blocked',
      enforcementAction: 'block',
      targetAgentId: selectedAgent?.sourceId,
      targetRuntimeId,
      requiredSkillIds,
      permissionScopes,
      riskLevel,
      reasons,
      blockers,
      approvalRequired: false,
    };
  }

  return {
    eligible: true,
    mode: approvalRequired ? 'approval_required' : 'auto',
    enforcementAction: approvalRequired ? 'request_approval' : 'execute',
    targetAgentId: selectedAgent?.sourceId,
    targetRuntimeId,
    requiredSkillIds,
    permissionScopes,
    riskLevel,
    reasons,
    blockers,
    approvalRequired,
  };
}
