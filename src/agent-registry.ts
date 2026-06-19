import crypto from 'node:crypto';

export interface RegistryRequiredSkillInput {
  id: string;
  version: string | null;
  raw: string;
}

export interface RegistryAgentInput {
  id: string;
  name: string;
  description: string;
  tools: string[];
  requiredSkills: RegistryRequiredSkillInput[];
  version?: string | null;
  visibility?: 'private' | 'team' | 'public' | string | null;
  defaultModel?: string | null;
  updatedAt: string;
}

export interface RegistrySkillInput {
  skillId: string;
  name: string;
  description: string;
  content: string;
  packageName?: string;
  packageSource?: string;
  sourceProvider?: string;
  installedAt: string;
  updatedAt: string;
  files: Array<{ name: string; type: 'file' | 'directory'; size: number }>;
}

export interface TeamAgentRegistrySnapshotInput {
  agents: RegistryAgentInput[];
  skills: RegistrySkillInput[];
  runtimes?: RegistryRuntimeInput[];
}

export interface RegistryRuntimeInput {
  runtimeId: string;
  kind: 'server' | 'device';
  displayName: string;
  agentClientId: string;
  provider?: string;
  transport?: 'stdio' | 'acp' | 'a2a' | 'http';
  status: 'idle' | 'busy' | 'draining' | 'offline';
  health: 'available' | 'busy' | 'draining' | 'offline' | 'full' | 'degraded';
  capabilities?: string[];
  availableSlots?: number;
  updatedAt?: string;
}

interface RegistryFrontmatter {
  version?: string;
  author?: string;
  providerTargets?: string[];
  capabilities?: string[];
  permissions?: string[];
  riskLevel?: RegistryRiskLevel;
  minimumOctodeckVersion?: string;
}

type RegistryItemKind = 'agent' | 'skill' | 'runtime';
type RegistryRiskLevel = 'low' | 'medium' | 'high' | 'critical';

const RISK_RANK: Record<RegistryRiskLevel, number> = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

const TOOL_PERMISSION_MAP: Record<string, string[]> = {
  bash: ['terminal'],
  terminal: ['terminal'],
  shell: ['terminal'],
  write: ['repo_write'],
  edit: ['repo_write'],
  multiedit: ['repo_write'],
  notebookedit: ['repo_write'],
  read: ['repo_read'],
  grep: ['repo_read'],
  glob: ['repo_read'],
  ls: ['repo_read'],
  webfetch: ['network'],
  websearch: ['network'],
};

const PERMISSION_CAPABILITY_MAP: Record<string, string> = {
  repo_read: 'repo',
  repo_write: 'repo',
  terminal: 'terminal',
  network: 'network',
  browser: 'browser',
  secrets: 'secrets',
};

export interface RegistryCapabilityCatalogItem {
  id: string;
  kind: RegistryItemKind;
  source: 'builtin' | 'local' | 'cloud' | 'device' | 'server' | 'marketplace';
  sourceId: string;
  displayName: string;
  description: string;
  version: string | null;
  capabilities: string[];
  permissionScopes: string[];
  riskLevel: RegistryRiskLevel;
  compatibleRuntimeIds: string[];
  runtimeCompatibility: {
    compatible: number;
    total: number;
    blockedRuntimeIds: string[];
  };
  minimumOctodeckVersion?: string | null;
  updatedAt: string;
}

interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
}

function parseRegistryFrontmatter(content: string): RegistryFrontmatter {
  const lines = content.split('\n');
  if (lines[0]?.trim() !== '---') return {};
  const endIndex = lines.slice(1).findIndex((line) => line.trim() === '---');
  if (endIndex < 0) return {};
  const result: RegistryFrontmatter = {};
  for (const line of lines.slice(1, endIndex + 1)) {
    const match = /^([\w-]+):\s*(.*)$/.exec(line.trim());
    if (!match) continue;
    const [, key, rawValue] = match;
    const value = rawValue.trim();
    if (key === 'version' && value) result.version = value;
    if (key === 'author' && value) result.author = value;
    if ((key === 'provider-targets' || key === 'providerTargets') && value) {
      result.providerTargets = value.split(',').map((item) => item.trim()).filter(Boolean);
    }
    if (key === 'capabilities' && value) result.capabilities = splitRegistryList(value);
    if ((key === 'permissions' || key === 'permission-scopes' || key === 'permissionScopes') && value) {
      result.permissions = splitRegistryList(value);
    }
    if ((key === 'risk-level' || key === 'riskLevel') && isRegistryRiskLevel(value)) {
      result.riskLevel = value;
    }
    if ((key === 'minimum-octodeck-version' || key === 'minimumOctodeckVersion') && value) {
      result.minimumOctodeckVersion = value;
    }
  }
  return result;
}

function splitRegistryList(value: string): string[] {
  return normalizeRegistryList(value.split(',').map((item) => item.trim()));
}

function normalizeRegistryList(values: Array<string | null | undefined>): string[] {
  return Array.from(new Set(values.flatMap((value) => {
    const normalized = value?.trim().toLowerCase().replace(/[\s-]+/g, '_');
    return normalized ? [normalized] : [];
  }))).sort();
}

function isRegistryRiskLevel(value: string): value is RegistryRiskLevel {
  return value === 'low' || value === 'medium' || value === 'high' || value === 'critical';
}

function riskForPermissions(permissions: string[]): RegistryRiskLevel {
  if (permissions.includes('secrets')) return 'critical';
  if (permissions.includes('repo_write') || permissions.includes('terminal')) return 'high';
  if (permissions.includes('network') || permissions.includes('browser') || permissions.includes('repo_read')) return 'medium';
  return 'low';
}

function maxRisk(left: RegistryRiskLevel, right: RegistryRiskLevel): RegistryRiskLevel {
  return RISK_RANK[left] >= RISK_RANK[right] ? left : right;
}

function permissionsForTools(tools: string[]): string[] {
  return normalizeRegistryList(
    tools.flatMap((tool) => TOOL_PERMISSION_MAP[tool.trim().toLowerCase()] ?? []),
  );
}

function capabilitiesForPermissions(permissions: string[]): string[] {
  return normalizeRegistryList(permissions.map((permission) => PERMISSION_CAPABILITY_MAP[permission] ?? permission));
}

function runtimeCapabilities(runtime: RegistryRuntimeInput): string[] {
  return normalizeRegistryList([
    ...(runtime.capabilities ?? []),
    runtime.provider,
    runtime.transport,
    runtime.agentClientId,
    runtime.kind,
  ]);
}

function compatibleRuntimeIds(
  requiredCapabilities: string[],
  runtimes: RegistryRuntimeInput[],
): string[] {
  if (!requiredCapabilities.length) return [];
  return runtimes
    .filter((runtime) => {
      if (runtime.health !== 'available' && runtime.health !== 'busy') return false;
      const caps = new Set(runtimeCapabilities(runtime));
      return requiredCapabilities.every((capability) => caps.has(capability));
    })
    .map((runtime) => runtime.runtimeId)
    .sort();
}

function checksumForSkill(skill: RegistrySkillInput): string {
  return `sha256:${crypto.createHash('sha256').update(skill.content).digest('hex')}`;
}

function parseVersion(value: string | null | undefined): ParsedVersion | null {
  if (!value) return null;
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(value.trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function compareVersions(left: ParsedVersion, right: ParsedVersion): number {
  if (left.major !== right.major) return left.major - right.major;
  if (left.minor !== right.minor) return left.minor - right.minor;
  return left.patch - right.patch;
}

function versionSatisfies(installedVersion: string | null, requestedVersion: string | null): boolean | null {
  if (!requestedVersion) return null;
  const requested = requestedVersion.trim();
  const installed = parseVersion(installedVersion);
  const baseline = parseVersion(requested.replace(/^[\^~]/, ''));
  if (!installed || !baseline) return null;

  if (requested.startsWith('^')) {
    const upperBound = baseline.major > 0
      ? { major: baseline.major + 1, minor: 0, patch: 0 }
      : baseline.minor > 0
        ? { major: 0, minor: baseline.minor + 1, patch: 0 }
        : { major: 0, minor: 0, patch: baseline.patch + 1 };
    return compareVersions(installed, baseline) >= 0 && compareVersions(installed, upperBound) < 0;
  }

  if (requested.startsWith('~')) {
    const upperBound = { major: baseline.major, minor: baseline.minor + 1, patch: 0 };
    return compareVersions(installed, baseline) >= 0 && compareVersions(installed, upperBound) < 0;
  }

  return compareVersions(installed, baseline) === 0;
}

export function buildTeamAgentRegistrySnapshot(input: TeamAgentRegistrySnapshotInput) {
  const skillsById = new Map(input.skills.map((skill) => [skill.skillId, skill]));
  const runtimes = input.runtimes ?? [];
  const dependencyConflicts: Array<{
    agentId: string;
    skillId: string;
    requestedVersion: string | null;
    installedVersion: string | null;
    packageId: string | null;
  }> = [];
  const packages = new Map<string, {
    id: string;
    name: string;
    source: string | null;
    skillIds: string[];
    version: string | null;
    author: string | null;
    checksum: string;
    fileCount: number;
    totalBytes: number;
    fileManifest: Array<{
      skillId: string;
      name: string;
      type: 'file' | 'directory';
      size: number;
    }>;
    providerTargets: string[];
    installRecords: Array<{
      skillId: string;
      target: 'cloud';
      provider: string | null;
      installedAt: string;
    }>;
    updatedAt: string;
  }>();

  for (const skill of input.skills) {
    const packageId = skill.packageName || skill.skillId;
    const meta = parseRegistryFrontmatter(skill.content);
    const provider = skill.sourceProvider || null;
    const fileManifest = skill.files.map((file) => ({
      skillId: skill.skillId,
      name: file.name,
      type: file.type,
      size: file.size,
    }));
    const existing = packages.get(packageId);
    if (existing) {
      existing.skillIds.push(skill.skillId);
      existing.fileManifest.push(...fileManifest);
      existing.fileCount = existing.fileManifest.length;
      existing.totalBytes += skill.files.reduce((total, file) => total + file.size, 0);
      if (provider && !existing.providerTargets.includes(provider)) existing.providerTargets.push(provider);
      existing.installRecords.push({
        skillId: skill.skillId,
        target: 'cloud',
        provider,
        installedAt: skill.installedAt,
      });
      if (skill.updatedAt > existing.updatedAt) existing.updatedAt = skill.updatedAt;
      continue;
    }
    packages.set(packageId, {
      id: packageId,
      name: skill.name,
      source: skill.packageSource ?? null,
      skillIds: [skill.skillId],
      version: meta.version ?? null,
      author: meta.author ?? null,
      checksum: checksumForSkill(skill),
      fileCount: fileManifest.length,
      totalBytes: skill.files.reduce((total, file) => total + file.size, 0),
      fileManifest,
      providerTargets: meta.providerTargets?.length ? meta.providerTargets : provider ? [provider] : [],
      installRecords: [
        {
          skillId: skill.skillId,
          target: 'cloud',
          provider,
          installedAt: skill.installedAt,
        },
      ],
      updatedAt: skill.updatedAt,
    });
  }

  const agents = input.agents.map((agent) => {
    const requiredSkills = agent.requiredSkills.map((skillRef) => {
      const installed = skillsById.get(skillRef.id);
      const packageId = installed?.packageName ?? installed?.skillId ?? null;
      const installedMeta = installed ? parseRegistryFrontmatter(installed.content) : {};
      const installedVersion = installedMeta.version ?? null;
      const versionSatisfied = installed
        ? versionSatisfies(installedVersion, skillRef.version)
        : null;
      if (installed && versionSatisfied === false) {
        dependencyConflicts.push({
          agentId: agent.id,
          skillId: skillRef.id,
          requestedVersion: skillRef.version,
          installedVersion,
          packageId,
        });
      }
      return {
        id: skillRef.id,
        requestedVersion: skillRef.version,
        raw: skillRef.raw,
        installed: !!installed,
        installedVersion,
        versionSatisfied,
        packageId,
      };
    });
    return {
      id: agent.id,
      name: agent.name,
      description: agent.description,
      tools: agent.tools,
      version: agent.version ?? '0.1.0',
      visibility: agent.visibility ?? 'private',
      defaultModel: agent.defaultModel ?? null,
      updatedAt: agent.updatedAt,
      requiredSkills,
    };
  });

  const unresolvedSkillDependencies = agents.reduce(
    (count, agent) => count + agent.requiredSkills.filter((skill) => !skill.installed).length,
    0,
  );

  const runtimeItems: RegistryCapabilityCatalogItem[] = runtimes.map((runtime) => {
    const capabilities = normalizeRegistryList(runtime.capabilities ?? []);
    return {
      id: `runtime:${runtime.runtimeId}`,
      kind: 'runtime',
      source: runtime.kind,
      sourceId: runtime.runtimeId,
      displayName: runtime.displayName,
      description: `${runtime.kind} runtime for ${runtime.agentClientId}`,
      version: null,
      capabilities,
      permissionScopes: [],
      riskLevel: 'low',
      compatibleRuntimeIds: [],
      runtimeCompatibility: {
        compatible: runtime.health === 'available' || runtime.health === 'busy' ? 1 : 0,
        total: 1,
        blockedRuntimeIds: runtime.health === 'available' || runtime.health === 'busy' ? [] : [runtime.runtimeId],
      },
      updatedAt: runtime.updatedAt ?? new Date(0).toISOString(),
    };
  });

  const skillItems: RegistryCapabilityCatalogItem[] = input.skills.map((skill) => {
    const meta = parseRegistryFrontmatter(skill.content);
    const permissionScopes = normalizeRegistryList(meta.permissions ?? []);
    const capabilities = normalizeRegistryList([
      ...(meta.capabilities ?? []),
      ...capabilitiesForPermissions(permissionScopes),
      skill.sourceProvider,
    ]);
    const requiredCapabilities = capabilitiesForPermissions(permissionScopes).filter((capability) => capability !== skill.sourceProvider);
    const compatible = compatibleRuntimeIds(requiredCapabilities, runtimes);
    const riskLevel = meta.riskLevel ?? riskForPermissions(permissionScopes);
    return {
      id: `skill:${skill.skillId}`,
      kind: 'skill',
      source: 'cloud',
      sourceId: skill.skillId,
      displayName: skill.name,
      description: skill.description,
      version: meta.version ?? null,
      capabilities,
      permissionScopes,
      riskLevel,
      compatibleRuntimeIds: compatible,
      runtimeCompatibility: {
        compatible: compatible.length,
        total: runtimes.length,
        blockedRuntimeIds: runtimes.map((runtime) => runtime.runtimeId).filter((id) => !compatible.includes(id)).sort(),
      },
      minimumOctodeckVersion: meta.minimumOctodeckVersion ?? null,
      updatedAt: skill.updatedAt,
    };
  });

  const skillItemById = new Map(skillItems.map((item) => [item.sourceId, item]));
  const agentItems: RegistryCapabilityCatalogItem[] = agents.map((agent) => {
    const ownPermissions = permissionsForTools(agent.tools);
    const requiredSkillItems = agent.requiredSkills.flatMap((skill) => {
      const installed = skillItemById.get(skill.id);
      return installed ? [installed] : [];
    });
    const permissionScopes = normalizeRegistryList([
      ...ownPermissions,
      ...requiredSkillItems.flatMap((skill) => skill.permissionScopes),
    ]);
    const capabilities = normalizeRegistryList([
      ...capabilitiesForPermissions(permissionScopes),
      ...agent.tools,
      ...agent.requiredSkills.map((skill) => skill.id),
    ]);
    const compatible = compatibleRuntimeIds(capabilitiesForPermissions(permissionScopes), runtimes);
    const riskLevel = requiredSkillItems.reduce(
      (risk, skill) => maxRisk(risk, skill.riskLevel),
      riskForPermissions(ownPermissions),
    );
    return {
      id: `agent:${agent.id}`,
      kind: 'agent',
      source: 'local',
      sourceId: agent.id,
      displayName: agent.name,
      description: agent.description,
      version: agent.version,
      capabilities,
      permissionScopes,
      riskLevel,
      compatibleRuntimeIds: compatible,
      runtimeCompatibility: {
        compatible: compatible.length,
        total: runtimes.length,
        blockedRuntimeIds: runtimes.map((runtime) => runtime.runtimeId).filter((id) => !compatible.includes(id)).sort(),
      },
      minimumOctodeckVersion: null,
      updatedAt: agent.updatedAt,
    };
  });

  const capabilityCatalog = [...agentItems, ...skillItems, ...runtimeItems].sort((a, b) => a.id.localeCompare(b.id));

  return {
    summary: {
      totalAgents: agents.length,
      totalSkillPackages: packages.size,
      unresolvedSkillDependencies,
      dependencyConflicts: dependencyConflicts.length,
      totalRegistryItems: capabilityCatalog.length,
      highRiskItems: capabilityCatalog.filter((item) => item.riskLevel === 'high' || item.riskLevel === 'critical').length,
      compatibleRuntimeLinks: capabilityCatalog.reduce((total, item) => total + item.compatibleRuntimeIds.length, 0),
    },
    agents,
    dependencyConflicts,
    skillPackages: Array.from(packages.values()).map((item) => ({
      ...item,
      skillIds: [...item.skillIds].sort(),
      fileManifest: [...item.fileManifest].sort((a, b) => `${a.skillId}/${a.name}`.localeCompare(`${b.skillId}/${b.name}`)),
      providerTargets: [...item.providerTargets].sort(),
      installRecords: [...item.installRecords].sort((a, b) => a.skillId.localeCompare(b.skillId)),
    })),
    capabilityCatalog,
  };
}
