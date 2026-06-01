export const UNKNOWN_SKILL_PACKAGE = '本地/未知来源';
export const LOCAL_SYSTEM_SKILL_PACKAGE = '本地/系统';

const LEGACY_HOST_LABEL = ['宿', '主', '机'].join('');

export function normalizeSkillDisplayText(value?: string | null): string {
  return (value ?? '').replaceAll(LEGACY_HOST_LABEL, LOCAL_SYSTEM_SKILL_PACKAGE);
}

export interface SkillPackageGroup<T> {
  packageName: string;
  skills: T[];
}

export function getSkillPackageName(skill: { packageName?: string | null }): string {
  const packageName = normalizeSkillDisplayText(skill.packageName).trim();
  return packageName || UNKNOWN_SKILL_PACKAGE;
}

export function groupSkillsByPackage<T extends { packageName?: string | null; id?: string; name?: string }>(
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
    .sort((a, b) => {
      if (a.packageName === UNKNOWN_SKILL_PACKAGE) return 1;
      if (b.packageName === UNKNOWN_SKILL_PACKAGE) return -1;
      return a.packageName.localeCompare(b.packageName);
    });
}
