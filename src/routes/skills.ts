// Skills management routes

import { Hono } from 'hono';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { Variables } from '../web-context.js';
import type { AuthUser } from '../types.js';
import { authMiddleware } from '../middleware/auth.js';
import { DATA_DIR } from '../config.js';
import {
  deleteCloudSkill,
  deleteCloudSkillsByUser,
  getAgentLinkById,
  getCloudSkill,
  listCloudSkillsByUser,
  setCloudSkillEnabled,
  upsertCloudSkill,
} from '../db.js';
import { getSession } from '../agent-link/registry.js';
import { invokeRemoteTool } from '../agent-link/tool-rpc.js';
import { getCustomBackend } from '../backends/custom-loader.js';
import {
  parseFrontmatter,
  validateSkillId,
  validateSkillPath,
  listFiles,
  scanSkillDirectory,
} from '../skill-utils.js';

const execFileAsync = promisify(execFile);
let skillInstallLock: Promise<void> = Promise.resolve();

const skillsRoutes = new Hono<{ Variables: Variables }>();

// --- Types ---

interface Skill {
  id: string;
  name: string;
  description: string;
  source: 'cloud' | 'user' | 'project' | 'external';
  enabled: boolean;
  packageName?: string;
  packageSource?: string;
  sourceProvider?: 'claude' | 'codex' | string;
  level?: 'package' | 'skill';
  levelKey?: string;
  installedAt?: string;
  userInvocable: boolean;
  allowedTools: string[];
  argumentHint: string | null;
  updatedAt: string;
  files: Array<{ name: string; type: 'file' | 'directory'; size: number }>;
}

interface SkillDetail extends Skill {
  content: string;
}

interface SearchResult {
  package: string;
  url: string;
  description?: string;
  installs?: number;
  skillId?: string;
  source?: string;
}

type SkillInstallTarget =
  | { kind: 'cloud' }
  | { kind: 'device'; deviceLinkId: string }
  | { kind: 'device-agent-workspace'; agentId: string };

type SkillSourceProvider = 'claude' | 'codex';

const PROVIDER_SKILL_TARGETS: Record<
  SkillSourceProvider,
  { configDir: string; adapter: string }
> = {
  claude: { configDir: 'claude', adapter: 'claude-code' },
  codex: { configDir: 'codex', adapter: 'codex' },
};

// --- Utility Functions ---

function getLegacyCloudSkillDir(userId: string): string {
  return path.join(DATA_DIR, 'skills', userId);
}

function getProjectSkillsDir(): string {
  return path.resolve(process.cwd(), 'container', 'skills');
}

function normalizeSourceProvider(value: unknown): SkillSourceProvider {
  if (value === 'codex') return 'codex';
  return 'claude';
}

function toCloudSkill(record: ReturnType<typeof listCloudSkillsByUser>[number]): Skill {
  return {
    id: record.skillId,
    name: record.name,
    description: record.description,
    source: 'cloud',
    enabled: record.enabled,
    packageName: record.packageName,
    packageSource: record.packageSource,
    sourceProvider: record.sourceProvider,
    level: record.packageName ? 'package' : 'skill',
    levelKey: record.packageName ?? record.skillId,
    installedAt: record.installedAt,
    userInvocable: true,
    allowedTools: [],
    argumentHint: null,
    updatedAt: record.updatedAt,
    files: record.files,
  };
}

function toCloudSkillDetail(record: NonNullable<ReturnType<typeof getCloudSkill>>): SkillDetail {
  return { ...toCloudSkill(record), content: record.content };
}

// validateSkillId, validateSkillPath, parseFrontmatter, listFiles, scanSkillDirectory
// are imported from '../skill-utils.js'

function scanDirectory(rootDir: string, source: 'user' | 'project'): Skill[] {
  return scanSkillDirectory(rootDir, source) as Skill[];
}

function discoverSkills(userId: string, userRole?: string): Skill[] {
  const cloudSkills = listCloudSkillsByUser(userId).map(toCloudSkill);
  const projectSkills = scanDirectory(getProjectSkillsDir(), 'project');

  // 按优先级去重（user > project），同 ID 高优先级覆盖低优先级。
  // “本地/系统”分类展示云端/设备侧返回的 skill，不再扫描宿主机本地库。
  const seen = new Set<string>();
  const result: Skill[] = [];
  for (const skill of [...cloudSkills, ...projectSkills]) {
    if (!seen.has(skill.id)) {
      seen.add(skill.id);
      result.push(skill);
    }
  }
  return result;
}

function getSkillDetail(
  skillId: string,
  userId: string,
  userRole?: string,
): SkillDetail | null {
  if (!validateSkillId(skillId)) return null;

  const cloudSkill = getCloudSkill(userId, skillId);
  if (cloudSkill) return toCloudSkillDetail(cloudSkill);

  const searchDirs: Array<{
    rootDir: string;
    source: 'user' | 'project' | 'external';
  }> = [
    { rootDir: getProjectSkillsDir(), source: 'project' },
  ];

  for (const { rootDir, source } of searchDirs) {
    const skillDir = path.join(rootDir, skillId);
    if (!fs.existsSync(skillDir)) continue;

    if (!validateSkillPath(rootDir, skillDir)) continue;

    const skillMdPath = path.join(skillDir, 'SKILL.md');
    const skillMdDisabledPath = path.join(skillDir, 'SKILL.md.disabled');

    let enabled = false;
    let skillFilePath: string | null = null;

    if (fs.existsSync(skillMdPath)) {
      enabled = true;
      skillFilePath = skillMdPath;
    } else if (fs.existsSync(skillMdDisabledPath)) {
      enabled = false;
      skillFilePath = skillMdDisabledPath;
    } else {
      continue;
    }

    try {
      const content = fs.readFileSync(skillFilePath, 'utf-8');
      const frontmatter = parseFrontmatter(content);
      const stats = fs.statSync(skillDir);

      const detail: SkillDetail = {
        id: skillId,
        name: frontmatter.name || skillId,
        description: frontmatter.description || '',
        source,
        enabled,
        userInvocable:
          frontmatter['user-invocable'] === undefined
            ? true
            : frontmatter['user-invocable'] !== 'false',
        allowedTools: frontmatter['allowed-tools']
          ? frontmatter['allowed-tools'].split(',').map((t) => t.trim())
          : [],
        argumentHint: frontmatter['argument-hint'] || null,
        updatedAt: stats.mtime.toISOString(),
        files: listFiles(skillDir),
        content,
      };

      return detail;
    } catch {
      // Skip malformed skill
    }
  }

  return null;
}

/**
 * Parse the output of `npx skills find <query>` to extract search results.
 * The output contains ANSI codes and formatted text like:
 *   owner/repo@skill-name
 *   https://skills.sh/owner/repo/skill
 */
function parseSearchOutput(output: string): SearchResult[] {
  // Strip ANSI escape codes
  const clean = output.replace(/\x1b\[[0-9;]*m/g, '');
  const results: SearchResult[] = [];

  const lines = clean
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Match package pattern: owner/repo or owner/repo@skill
    const pkgMatch = line.match(/^([\w\-]+\/[\w\-.]+(?:@[\w\-.]+)?)$/);
    if (pkgMatch) {
      const pkg = pkgMatch[1];
      // Next line might be the URL (possibly prefixed with └ or similar chars)
      let url = '';
      if (i + 1 < lines.length) {
        const nextLine = lines[i + 1].replace(/^[└├│─\s]+/, '');
        if (nextLine.startsWith('http')) {
          url = nextLine;
          i++;
        }
      }
      results.push({ package: pkg, url });
    }
  }

  return results;
}

function readInstalledSkillEntry(entryPath: string): {
  name: string;
  description: string;
  content: string;
  enabled: boolean;
  files: Skill['files'];
} | null {
  const skillMdPath = path.join(entryPath, 'SKILL.md');
  const disabledPath = path.join(entryPath, 'SKILL.md.disabled');
  const skillFilePath = fs.existsSync(skillMdPath)
    ? skillMdPath
    : fs.existsSync(disabledPath)
      ? disabledPath
      : null;
  if (!skillFilePath) return null;
  const content = fs.readFileSync(skillFilePath, 'utf-8');
  const frontmatter = parseFrontmatter(content);
  return {
    name: frontmatter.name || path.basename(entryPath),
    description: frontmatter.description || '',
    content,
    enabled: skillFilePath === skillMdPath,
    files: listFiles(entryPath),
  };
}

// --- Search cache (LRU, 5min TTL, max 100 entries) ---

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const SEARCH_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const SEARCH_CACHE_MAX = 100;
const searchCache = new Map<string, CacheEntry<SearchResult[]>>();

function getCachedSearch(key: string): SearchResult[] | null {
  const entry = searchCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    searchCache.delete(key);
    return null;
  }
  return entry.value;
}

function setCachedSearch(key: string, value: SearchResult[]): void {
  // Evict oldest if at capacity
  if (searchCache.size >= SEARCH_CACHE_MAX) {
    const oldest = searchCache.keys().next().value;
    if (oldest !== undefined) searchCache.delete(oldest);
  }
  searchCache.set(key, { value, expiresAt: Date.now() + SEARCH_CACHE_TTL });
}

/**
 * Search skills via skills.sh API.
 * Returns structured results with install counts.
 */
async function searchSkillsApi(query: string): Promise<SearchResult[]> {
  const cached = getCachedSearch(query);
  if (cached) return cached;

  try {
    const resp = await fetch(
      `https://skills.sh/api/search?q=${encodeURIComponent(query)}&limit=20`,
      { signal: AbortSignal.timeout(10_000) },
    );
    if (!resp.ok) throw new Error(`skills.sh returned ${resp.status}`);

    const data = (await resp.json()) as {
      skills?: Array<{
        id: string;
        skillId: string;
        name: string;
        installs: number;
        source: string;
      }>;
    };

    const results: SearchResult[] = (data.skills || []).map((s) => ({
      package:
        s.source === s.skillId || !s.skillId
          ? s.source
          : `${s.source}@${s.skillId}`,
      url: `https://skills.sh/s/${s.id}`,
      description: '',
      installs: s.installs,
      skillId: s.skillId,
      source: s.source,
    }));

    setCachedSearch(query, results);
    return results;
  } catch {
    // Fallback to npx skills find
    return searchSkillsFallback(query);
  }
}

/**
 * Fallback search using npx skills find CLI.
 */
async function searchSkillsFallback(query: string): Promise<SearchResult[]> {
  try {
    const { stdout } = await execFileAsync(
      'npx',
      ['-y', 'skills', 'find', query],
      { timeout: 30_000 },
    );
    return parseSearchOutput(stdout);
  } catch (error) {
    if (error && typeof error === 'object' && 'stdout' in error) {
      const results = parseSearchOutput((error as any).stdout || '');
      if (results.length > 0) return results;
    }
    return [];
  }
}

/**
 * Fetch SKILL.md content from GitHub for a given source repo and skill ID.
 * Tries multiple common directory layouts.
 */
async function fetchSkillMdFromGitHub(
  source: string,
  skillId: string,
): Promise<{ content: string; description: string; skillName: string } | null> {
  // Try common paths where SKILL.md might live
  const pathCandidates = [
    `skills/${skillId}/SKILL.md`,
    `${skillId}/SKILL.md`,
    `.claude/skills/${skillId}/SKILL.md`,
    `SKILL.md`,
  ];

  for (const branch of ['main', 'master']) {
    for (const filePath of pathCandidates) {
      try {
        const url = `https://raw.githubusercontent.com/${source}/${branch}/${filePath}`;
        const resp = await fetch(url, { signal: AbortSignal.timeout(8_000) });
        if (!resp.ok) continue;

        const content = await resp.text();
        // Verify it looks like a SKILL.md (has frontmatter)
        if (!content.startsWith('---')) continue;

        const frontmatter = parseFrontmatter(content);
        return {
          content,
          description: frontmatter.description || '',
          skillName: frontmatter.name || skillId,
        };
      } catch {
        continue;
      }
    }
  }

  return null;
}

async function withSkillInstallLock<T>(fn: () => Promise<T>): Promise<T> {
  const previous = skillInstallLock.catch(() => undefined);
  let release: () => void = () => undefined;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  skillInstallLock = previous.then(() => current);
  await previous;
  try {
    return await fn();
  } finally {
    release();
  }
}

// --- Routes ---

skillsRoutes.get('/', authMiddleware, (c) => {
  const authUser = c.get('user') as AuthUser;
  const skills = discoverSkills(authUser.id, authUser.role);
  return c.json({ skills });
});

skillsRoutes.get('/search', authMiddleware, async (c) => {
  const query = c.req.query('q')?.trim();
  if (!query) {
    return c.json({ results: [] });
  }

  const results = await searchSkillsApi(query);
  return c.json({ results });
});

skillsRoutes.get('/search/detail', authMiddleware, async (c) => {
  const source = c.req.query('source')?.trim();
  const skillId = c.req.query('skillId')?.trim();

  // Support legacy url-based lookup for backwards compat
  const url = c.req.query('url')?.trim();

  if (source && skillId) {
    // New path: fetch SKILL.md from GitHub using source/skillId
    const result = await fetchSkillMdFromGitHub(source, skillId);
    if (!result) {
      return c.json({ detail: null });
    }

    return c.json({
      detail: {
        description: result.description,
        skillName: result.skillName,
        readme: result.content,
        installs: '',
        age: '',
        features: [],
      },
    });
  }

  // Legacy: extract source/skillId from skills.sh URL
  if (url) {
    try {
      const parsed = new URL(url);
      if (parsed.hostname === 'skills.sh') {
        // URL pattern: https://skills.sh/s/{owner}/{repo}/{skillId}
        const segments = parsed.pathname
          .replace(/^\/s\//, '')
          .split('/')
          .filter(Boolean);
        if (segments.length >= 3) {
          const srcFromUrl = `${segments[0]}/${segments[1]}`;
          const skillIdFromUrl = segments[2];
          const result = await fetchSkillMdFromGitHub(
            srcFromUrl,
            skillIdFromUrl,
          );
          if (result) {
            return c.json({
              detail: {
                description: result.description,
                skillName: result.skillName,
                readme: result.content,
                installs: '',
                age: '',
                features: [],
              },
            });
          }
        }
      }
    } catch {
      // fall through
    }
  }

  return c.json({ detail: null });
});

skillsRoutes.get('/:id', authMiddleware, (c) => {
  const id = c.req.param('id');
  const authUser = c.get('user') as AuthUser;
  const skill = getSkillDetail(id, authUser.id, authUser.role);

  if (!skill) {
    return c.json({ error: 'Skill not found' }, 404);
  }

  return c.json({ skill });
});

skillsRoutes.get('/:id/content', authMiddleware, (c) => {
  const id = c.req.param('id');
  const authUser = c.get('user') as AuthUser;
  const skill = getSkillDetail(id, authUser.id, authUser.role);
  if (!skill) return c.json({ error: 'Skill not found' }, 404);
  return c.json({
    id: skill.id,
    name: skill.name,
    source: skill.source,
    packageName: skill.packageName,
    sourceProvider: skill.sourceProvider,
    content: skill.content,
  });
});

// Toggle enable/disable for user-level skills via SKILL.md ↔ SKILL.md.disabled rename.
// Project-level skills are read-only.
skillsRoutes.patch('/:id', authMiddleware, async (c) => {
  const id = c.req.param('id');
  const authUser = c.get('user') as AuthUser;
  const { enabled } = await c.req.json<{ enabled: boolean }>();

  if (!validateSkillId(id)) return c.json({ error: 'Invalid skill ID' }, 400);

  if (getCloudSkill(authUser.id, id)) {
    setCloudSkillEnabled(authUser.id, id, Boolean(enabled));
    return c.json({ success: true });
  }
  return c.json({ error: 'Skill not found or is not a cloud skill' }, 404);
});

/**
 * Delete a user-level skill by ID.
 * Reusable by both the HTTP route and IPC handler.
 */
function deleteSkillForUser(
  userId: string,
  skillId: string,
): { success: boolean; error?: string } {
  if (!validateSkillId(skillId)) {
    return { success: false, error: 'Invalid skill ID' };
  }

  if (deleteCloudSkill(userId, skillId)) {
    return { success: true };
  }
  return { success: false, error: 'Skill not found or is a project-level skill' };
}

// 批量删除所有用户级技能（清理旧的同步副本）
skillsRoutes.delete('/user-all', authMiddleware, (c) => {
  const authUser = c.get('user') as AuthUser;
  const userDir = getLegacyCloudSkillDir(authUser.id);
  let deleted = deleteCloudSkillsByUser(authUser.id);
  try {
    // Best-effort cleanup for legacy file-state cloud skills from older builds.
    if (fs.existsSync(userDir)) {
      for (const entry of fs.readdirSync(userDir, { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue;
        const p = path.join(userDir, entry.name);
        try {
          fs.rmSync(p, { recursive: true, force: true });
          deleted++;
        } catch {
          /* ignore */
        }
      }
    }
  } catch {
    return c.json({ error: 'Failed to delete user skills' }, 500);
  }
  return c.json({ success: true, deleted });
});

skillsRoutes.delete('/:id', authMiddleware, async (c) => {
  const id = c.req.param('id');
  const authUser = c.get('user') as AuthUser;
  const result = deleteSkillForUser(authUser.id, id);

  if (!result.success) {
    const status =
      result.error === 'Invalid skill ID' ||
      result.error === 'Invalid skill path'
        ? 400
        : result.error?.includes('not found')
          ? 404
          : 500;
    return c.json({ error: result.error }, status);
  }

  return c.json({ success: true });
});

/**
 * Install a skill package for a specific user.
 * Uses a temporary HOME directory to isolate `npx skills add --global` from
 * the real ~/.claude/skills, eliminating race conditions across concurrent installs.
 * Reusable by both the HTTP route and IPC handler.
 */
async function installSkillForUser(
  userId: string,
  pkg: string,
  options: { sourceProvider?: SkillSourceProvider; selectedSkillIds?: string[] } = {},
): Promise<{ success: boolean; installed?: string[]; error?: string }> {
  if (
    !/^[\w\-]+\/[\w\-.]+(?:[@#][\w\-.\/]+)?$/.test(pkg) &&
    !/^https?:\/\//.test(pkg)
  ) {
    return { success: false, error: 'Invalid package name format' };
  }

  // Create an isolated temp directory to act as HOME so `--global` installs
  // into tempHome/.claude/skills/ instead of the real ~/.claude/skills/.
  // This avoids any race condition when multiple installs run concurrently.
  const sourceProvider = normalizeSourceProvider(options.sourceProvider);
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-install-'));
  const providerTarget = PROVIDER_SKILL_TARGETS[sourceProvider];
  const tempSkillsDir = path.join(tempHome, `.${providerTarget.configDir}`, 'skills');
  fs.mkdirSync(tempSkillsDir, { recursive: true });

  try {
    await execFileAsync(
      'npx',
      ['-y', 'skills', 'add', pkg, '--global', '--yes', '-a', providerTarget.adapter],
      {
        timeout: 60_000,
        env: { ...process.env, HOME: tempHome },
      },
    );

    // Discover all skill directories installed into the temp location
    const installedEntries: string[] = [];
    if (fs.existsSync(tempSkillsDir)) {
      for (const entry of fs.readdirSync(tempSkillsDir, {
        withFileTypes: true,
      })) {
        if (entry.isDirectory() || entry.isSymbolicLink()) {
          installedEntries.push(entry.name);
        }
      }
    }

    if (installedEntries.length === 0) {
      return {
        success: false,
        error: 'No skills were installed — package may be invalid',
      };
    }

    const selected = new Set(options.selectedSkillIds ?? []);
    const entriesToInstall = selected.size > 0
      ? installedEntries.filter((entry) => selected.has(entry))
      : installedEntries;

    if (entriesToInstall.length === 0) {
      return {
        success: false,
        error: 'No selected skills were found in the installed package',
      };
    }

    for (const name of entriesToInstall) {
      const src = path.join(tempSkillsDir, name);
      const entry = readInstalledSkillEntry(src);
      if (entry) {
        upsertCloudSkill({
          userId,
          skillId: name,
          name: entry.name,
          description: entry.description,
          content: entry.content,
          enabled: entry.enabled,
          packageName: pkg,
          packageSource: 'skills.sh',
          sourceProvider,
          files: entry.files,
        });
      }
    }

    return { success: true, installed: entriesToInstall };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  } finally {
    // Always clean up the temp directory
    try {
      fs.rmSync(tempHome, { recursive: true, force: true });
    } catch {
      /* ignore cleanup errors */
    }
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function installSkillOnDevice(
  userId: string,
  deviceLinkId: string,
  pkg: string,
  sourceProviderInput: SkillSourceProvider = 'claude',
): Promise<{ success: boolean; installed?: string[]; error?: string }> {
  if (
    !/^[\w\-]+\/[\w\-.]+(?:[@#][\w\-.\/]+)?$/.test(pkg) &&
    !/^https?:\/\//.test(pkg)
  ) {
    return { success: false, error: 'Invalid package name format' };
  }
  const link = getAgentLinkById(deviceLinkId);
  if (!link || link.userId !== userId || link.revokedAt) {
    return { success: false, error: 'device not found' };
  }
  const session = getSession(deviceLinkId);
  if (!session || session.state !== 'open') {
    return { success: false, error: 'device offline' };
  }
  const sourceProvider = normalizeSourceProvider(sourceProviderInput);
  const providerTarget = PROVIDER_SKILL_TARGETS[sourceProvider];
  const providerSkillsDir = `.${providerTarget.configDir}/skills`;
  try {
    // Use a temp HOME so `--global` install is isolated from concurrent
    // installs; then atomically move discovered skill directories into the
    // real provider-native skills dir so the device's CLI discovery picks them up.
    const command = [
      'set -eu',
      'tmp_home="$(mktemp -d)"',
      'cleanup() { rm -rf "$tmp_home"; }',
      'trap cleanup EXIT',
      `mkdir -p "$tmp_home/${providerSkillsDir}" ~/${providerSkillsDir}`,
      `HOME="$tmp_home" npx -y skills add ${shellQuote(pkg)} --global --yes -a ${providerTarget.adapter}`,
      'installed=""',
      'count=0',
      `for entry in "$tmp_home/${providerSkillsDir}"/*; do`,
      '  [ -e "$entry" ] || continue',
      '  name="$(basename "$entry")"',
      `  target="$HOME/${providerSkillsDir}/$name"`,
      '  rm -rf "$target"',
      '  cp -RL "$entry" "$target"',
      '  installed="$installed $name"',
      '  count=$((count + 1))',
      'done',
      'if [ "$count" -eq 0 ]; then echo "No skills were installed — package may be invalid" >&2; exit 1; fi',
      'printf "%s\\n" "$installed"',
    ].join('\n');
    const result = await invokeRemoteTool(session, {
      linkId: deviceLinkId,
      toolName: 'Bash',
      input: { command },
      cwd: 'octodeck-tmp://skills-install',
      timeoutMs: 120_000,
      maxOutputBytes: 1_048_576,
    });
    if (!result.ok) {
      return { success: false, error: result.error || 'device install failed' };
    }
    const stdout =
      result.result &&
      typeof result.result === 'object' &&
      'stdout' in result.result &&
      typeof (result.result as { stdout?: unknown }).stdout === 'string'
        ? (result.result as { stdout: string }).stdout
        : '';
    const installed = stdout.trim().split(/\s+/).filter(Boolean);
    return { success: true, installed };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

async function installSkillOnAgentWorkspace(
  userId: string,
  agentId: string,
  pkg: string,
  sourceProviderInput: SkillSourceProvider = 'claude',
): Promise<{ success: boolean; installed?: string[]; error?: string }> {
  if (
    !/^[\w\-]+\/[\w\-.]+(?:[@#][\w\-.\/]+)?$/.test(pkg) &&
    !/^https?:\/\//.test(pkg)
  ) {
    return { success: false, error: 'Invalid package name format' };
  }

  const backend = getCustomBackend(agentId);
  if (!backend) {
    return { success: false, error: 'agent not found' };
  }
  if (!backend.deviceLinkId) {
    return { success: false, error: 'agent has no bound device' };
  }

  const link = getAgentLinkById(backend.deviceLinkId);
  if (!link || link.userId !== userId || link.revokedAt) {
    return { success: false, error: 'device not found' };
  }
  const session = getSession(backend.deviceLinkId);
  if (!session || session.state !== 'open') {
    return { success: false, error: 'device offline' };
  }

  const cwd =
    backend.workdirMode === 'custom' && backend.workdir
      ? backend.workdir
      : `octodeck-workspace://${backend.id}`;
  const sourceProvider = normalizeSourceProvider(sourceProviderInput);
  const providerTarget = PROVIDER_SKILL_TARGETS[sourceProvider];
  const providerSkillsDir = `.${providerTarget.configDir}/skills`;
  const workspaceSkillsDir = sourceProvider === 'claude' ? './skills' : `./${providerSkillsDir}`;
  const command = [
    'set -eu',
    'tmp_home="$(mktemp -d)"',
    'cleanup() { rm -rf "$tmp_home"; }',
    'trap cleanup EXIT',
    `mkdir -p "$tmp_home/${providerSkillsDir}" ${workspaceSkillsDir}`,
    `HOME="$tmp_home" npx -y skills add ${shellQuote(pkg)} --global --yes -a ${providerTarget.adapter}`,
    'installed=""',
    'count=0',
    `for entry in "$tmp_home/${providerSkillsDir}"/*; do`,
    '  [ -e "$entry" ] || continue',
    '  name="$(basename "$entry")"',
    `  rm -rf "${workspaceSkillsDir}/$name"`,
    `  cp -RL "$entry" "${workspaceSkillsDir}/$name"`,
    '  installed="$installed $name"',
    '  count=$((count + 1))',
    'done',
    'if [ "$count" -eq 0 ]; then echo "No skills were installed — package may be invalid" >&2; exit 1; fi',
    'printf "%s\\n" "$installed"',
  ].join('\n');

  try {
    const result = await invokeRemoteTool(session, {
      linkId: backend.deviceLinkId,
      toolName: 'Bash',
      input: { command },
      cwd,
      timeoutMs: 120_000,
      maxOutputBytes: 1_048_576,
    });
    if (!result.ok) {
      return {
        success: false,
        error: result.error || 'device workspace install failed',
      };
    }
    const stdout =
      result.result &&
      typeof result.result === 'object' &&
      'stdout' in result.result &&
      typeof (result.result as { stdout?: unknown }).stdout === 'string'
        ? (result.result as { stdout: string }).stdout
        : '';
    const installed = stdout.trim().split(/\s+/).filter(Boolean);
    return { success: true, installed };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Sync host-level skills (~/.claude/skills/) to a user's directory.
 * Standalone function usable from both the API route and the auto-sync timer.
 */
skillsRoutes.post('/install', authMiddleware, async (c) => {
  const authUser = c.get('user') as AuthUser;
  const body = await c.req.json().catch(() => ({}));

  if (typeof body.package !== 'string') {
    return c.json({ error: 'package field must be string' }, 400);
  }

  const pkg = body.package.trim();
  const sourceProvider = normalizeSourceProvider(body.sourceProvider);
  const selectedSkillIds = Array.isArray(body.selectedSkillIds)
    ? body.selectedSkillIds
        .filter((id: unknown): id is string => typeof id === 'string')
        .map((id: string) => id.trim())
        .filter(validateSkillId)
    : undefined;
  const target: SkillInstallTarget =
    body.target === 'device-agent-workspace' && typeof body.agentId === 'string'
      ? { kind: 'device-agent-workspace', agentId: body.agentId.trim() }
      : body.target === 'device' && typeof body.deviceLinkId === 'string'
      ? { kind: 'device', deviceLinkId: body.deviceLinkId.trim() }
      : { kind: 'cloud' };
  const result =
    target.kind === 'device'
      ? await installSkillOnDevice(authUser.id, target.deviceLinkId, pkg, sourceProvider)
      : target.kind === 'device-agent-workspace'
        ? await installSkillOnAgentWorkspace(authUser.id, target.agentId, pkg, sourceProvider)
      : await installSkillForUser(authUser.id, pkg, {
          sourceProvider,
          selectedSkillIds,
        });

  if (!result.success) {
    const err = result.error;
    let status: 400 | 404 | 409 | 500 = 500;
    if (err === 'Invalid package name format') {
      status = 400;
    } else if (
      err === 'device not found' ||
      err === 'agent not found' ||
      err === 'No skills were installed — package may be invalid'
    ) {
      status = 404;
    } else if (err === 'device offline' || err === 'agent has no bound device') {
      status = 409;
    }
    return c.json(
      { error: 'Failed to install skill', details: result.error },
      status,
    );
  }

  return c.json({ success: true, installed: result.installed });
});

// Reinstall a cloud skill by its ID — requires packageName in DB.
skillsRoutes.post('/:id/reinstall', authMiddleware, async (c) => {
  const id = c.req.param('id');
  const authUser = c.get('user') as AuthUser;

  if (!validateSkillId(id)) {
    return c.json({ error: 'Invalid skill ID' }, 400);
  }

  const cloudSkill = getCloudSkill(authUser.id, id);
  if (!cloudSkill?.packageName) {
    return c.json(
      { error: 'Skill has no package info — cannot reinstall' },
      400,
    );
  }

  // Delete then reinstall
  const deleteResult = deleteSkillForUser(authUser.id, id);
  if (!deleteResult.success) {
    return c.json(
      { error: 'Failed to delete old skill', details: deleteResult.error },
      500,
    );
  }

  const installResult = await installSkillForUser(
    authUser.id,
    cloudSkill.packageName,
  );
  if (!installResult.success) {
    return c.json(
      { error: 'Failed to reinstall skill', details: installResult.error },
      500,
    );
  }

  return c.json({ success: true, installed: installResult.installed });
});

export { installSkillForUser, deleteSkillForUser };
export default skillsRoutes;
