export const CLOUD_SKILL_PACKAGE = 'Cloud';
export const DEVICE_SKILL_PACKAGE = 'Device';
export const WORKSPACE_SKILL_PACKAGE = 'Workspace';

const LEGACY_HOST_LABEL = ['宿', '主', '机'].join('');

export function normalizeSkillDisplayText(value?: string | null): string {
  return (value ?? '').replaceAll(LEGACY_HOST_LABEL, DEVICE_SKILL_PACKAGE);
}

export interface SkillPackageGroup<T> {
  packageName: string;
  skills: T[];
}

export interface SkillIdentityFields {
  id: string;
  source?: string | null;
  deviceId?: string | null;
  workspacePath?: string | null;
  sourceProvider?: string | null;
  packageName?: string | null;
  levelKey?: string | null;
}

export function getSkillPackageName(skill: { packageName?: string | null; source?: string | null }): string {
  const packageName = normalizeSkillDisplayText(skill.packageName).trim();
  if (packageName) return packageName;
  if (skill.source === 'cli') return DEVICE_SKILL_PACKAGE;
  if (skill.source === 'workspace' || skill.source === 'project') return WORKSPACE_SKILL_PACKAGE;
  return CLOUD_SKILL_PACKAGE;
}

export function groupSkillsByPackage<T extends { packageName?: string | null; source?: string | null; id?: string; name?: string }>(
  skills: T[],
): SkillPackageGroup<T>[] {
  const groups = new Map<string, T[]>();
  for (const skill of skills) {
    const packageName = getSkillPackageName(skill);
    groups.set(packageName, [...(groups.get(packageName) ?? []), skill]);
  }

  return [...groups.entries()]
    .map(([packageName, items]) => ({
      packageName,
      skills: [...items].sort((a, b) => (a.name || a.id || '').localeCompare(b.name || b.id || '')),
    }))
    .sort((a, b) => a.packageName.localeCompare(b.packageName));
}

export function getSkillIdentityKey(skill: SkillIdentityFields): string {
  return JSON.stringify([
    skill.source ?? '',
    skill.deviceId ?? 'local',
    skill.sourceProvider ?? '',
    skill.workspacePath ?? '',
    normalizeSkillDisplayText(skill.packageName),
    skill.levelKey ?? '',
    skill.id,
  ]);
}

export function dedupeSkillsByIdentity<T extends SkillIdentityFields>(skills: T[]): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const skill of skills) {
    const key = getSkillIdentityKey(skill);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(skill);
  }
  return result;
}
