// Agent definitions management routes
// Manages ~/.claude/agents/*.md files (global agent definition files)

import { Hono } from 'hono';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import type { Variables } from '../web-context.js';
import { authMiddleware, systemConfigMiddleware } from '../middleware/auth.js';
import { logger } from '../logger.js';
import { AGENCY_AGENTS_ZH_INDEX } from '../agent-marketplace-index.js';

const agentDefinitionsRoutes = new Hono<{ Variables: Variables }>();

// --- Types ---

interface AgentDefinition {
  id: string;
  name: string;
  description: string;
  tools: string[];
  updatedAt: string;
}

interface AgentDefinitionDetail extends AgentDefinition {
  content: string;
}

// --- Utility Functions ---

function getAgentsDir(): string {
  return path.join(os.homedir(), '.claude', 'agents');
}

function validateAgentId(id: string): boolean {
  return /^[\w\-]+$/.test(id);
}

function generateAgentId(): string {
  return `agent-${crypto.randomBytes(4).toString('hex')}`;
}

function createUniqueAgentFile(content: string): string {
  const agentsDir = getAgentsDir();
  fs.mkdirSync(agentsDir, { recursive: true });

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const id = generateAgentId();
    const filePath = path.join(agentsDir, `${id}.md`);
    try {
      fs.writeFileSync(filePath, content, { encoding: 'utf-8', flag: 'wx' });
      return id;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw err;
      }
    }
  }

  throw new Error('Failed to generate unique agent ID');
}

function extractTools(
  frontmatter: Record<string, string | string[]>,
): string[] {
  return Array.isArray(frontmatter.tools)
    ? frontmatter.tools
    : typeof frontmatter.tools === 'string'
      ? frontmatter.tools
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean)
      : [];
}

function parseFrontmatter(content: string): Record<string, string | string[]> {
  const lines = content.split('\n');
  if (lines[0]?.trim() !== '---') return {};

  const endIndex = lines.slice(1).findIndex((line) => line.trim() === '---');
  if (endIndex === -1) return {};

  const frontmatterLines = lines.slice(1, endIndex + 1);
  const result: Record<string, string | string[]> = {};
  let currentKey: string | null = null;
  let currentValue: string[] = [];
  let multilineMode: 'folded' | 'literal' | 'list' | null = null;

  for (const line of frontmatterLines) {
    const keyMatch = line.match(/^([\w\-]+):\s*(.*)$/);
    if (keyMatch) {
      // Save previous key
      if (currentKey) {
        if (multilineMode === 'list') {
          result[currentKey] = currentValue;
        } else {
          result[currentKey] = currentValue.join(
            multilineMode === 'literal' ? '\n' : ' ',
          );
        }
      }

      currentKey = keyMatch[1];
      const value = keyMatch[2].trim();

      if (value === '>') {
        multilineMode = 'folded';
        currentValue = [];
      } else if (value === '|') {
        multilineMode = 'literal';
        currentValue = [];
      } else if (value === '') {
        // Could be start of a list
        multilineMode = 'list';
        currentValue = [];
      } else {
        result[currentKey] = value;
        currentKey = null;
        currentValue = [];
        multilineMode = null;
      }
    } else if (currentKey && multilineMode) {
      const trimmedLine = line.trimStart();
      if (multilineMode === 'list' && trimmedLine.startsWith('- ')) {
        currentValue.push(trimmedLine.slice(2).trim());
      } else if (trimmedLine) {
        currentValue.push(trimmedLine);
      }
    }
  }

  // Save last key
  if (currentKey) {
    if (multilineMode === 'list') {
      result[currentKey] = currentValue;
    } else {
      result[currentKey] = currentValue.join(
        multilineMode === 'literal' ? '\n' : ' ',
      );
    }
  }

  return result;
}

function discoverAgents(): AgentDefinition[] {
  const agentsDir = getAgentsDir();
  if (!fs.existsSync(agentsDir)) return [];

  const agents: AgentDefinition[] = [];

  try {
    const entries = fs.readdirSync(agentsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;

      const filePath = path.join(agentsDir, entry.name);
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const frontmatter = parseFrontmatter(content);
        const stats = fs.statSync(filePath);
        const id = entry.name.replace(/\.md$/, '');

        agents.push({
          id,
          name: (frontmatter.name as string) || id,
          description: (frontmatter.description as string) || '',
          tools: extractTools(frontmatter),
          updatedAt: stats.mtime.toISOString(),
        });
      } catch (err) {
        logger.warn(
          { filePath, error: err instanceof Error ? err.message : String(err) },
          'Failed to parse agent file',
        );
      }
    }
  } catch {
    // Directory not readable
  }

  return agents;
}

function getAgentDetail(id: string): AgentDefinitionDetail | null {
  if (!validateAgentId(id)) return null;

  const filePath = path.join(getAgentsDir(), `${id}.md`);
  if (!fs.existsSync(filePath)) return null;

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const frontmatter = parseFrontmatter(content);
    const stats = fs.statSync(filePath);

    return {
      id,
      name: (frontmatter.name as string) || id,
      description: (frontmatter.description as string) || '',
      tools: extractTools(frontmatter),
      updatedAt: stats.mtime.toISOString(),
      content,
    };
  } catch {
    return null;
  }
}

// --- Routes ---

// List all agent definitions
agentDefinitionsRoutes.get('/', authMiddleware, (c) => {
  const agents = discoverAgents();
  return c.json({ agents });
});

// Get single agent detail
agentDefinitionsRoutes.get('/:id', authMiddleware, (c) => {
  const id = c.req.param('id');
  const agent = getAgentDetail(id);
  if (!agent) {
    return c.json({ error: 'Agent definition not found' }, 404);
  }
  return c.json({ agent });
});

// Update agent content
agentDefinitionsRoutes.put(
  '/:id',
  authMiddleware,
  systemConfigMiddleware,
  async (c) => {
    const id = c.req.param('id');
    if (!validateAgentId(id)) {
      return c.json({ error: 'Invalid agent ID' }, 400);
    }

    const body = await c.req.json().catch(() => ({}));
    const { content } = body as { content: string };
    if (typeof content !== 'string') {
      return c.json({ error: 'content must be a string' }, 400);
    }

    const filePath = path.join(getAgentsDir(), `${id}.md`);
    try {
      fs.accessSync(filePath);
      fs.writeFileSync(filePath, content, 'utf-8');
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return c.json({ error: 'Agent definition not found' }, 404);
      }
      throw err;
    }
    return c.json({ success: true });
  },
);

// Create new agent
agentDefinitionsRoutes.post(
  '/',
  authMiddleware,
  systemConfigMiddleware,
  async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const { name, content } = body as { name: string; content: string };

    if (!name || typeof name !== 'string') {
      return c.json({ error: 'name is required' }, 400);
    }
    if (typeof content !== 'string') {
      return c.json({ error: 'content must be a string' }, 400);
    }

    try {
      const id = createUniqueAgentFile(content);
      return c.json({ success: true, id });
    } catch (err) {
      logger.warn(
        { error: err instanceof Error ? err.message : String(err) },
        'Failed to create agent definition',
      );
      return c.json({ error: 'Failed to generate unique agent ID' }, 500);
    }
  },
);

// Delete agent
agentDefinitionsRoutes.delete(
  '/:id',
  authMiddleware,
  systemConfigMiddleware,
  (c) => {
    const id = c.req.param('id');
    if (!validateAgentId(id)) {
      return c.json({ error: 'Invalid agent ID' }, 400);
    }

    const filePath = path.join(getAgentsDir(), `${id}.md`);
    try {
      fs.unlinkSync(filePath);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return c.json({ error: 'Agent definition not found' }, 404);
      }
      throw err;
    }
    return c.json({ success: true });
  },
);

// ---------- Marketplace: agency-agents-zh ----------

const MARKETPLACE_REPO = 'jnMetaCode/agency-agents-zh';
const MARKETPLACE_BRANCH = 'main';
const MARKETPLACE_RAW_BASE =
  `https://raw.githubusercontent.com/${MARKETPLACE_REPO}/${MARKETPLACE_BRANCH}`;

interface MarketplaceAgent {
  id: string;
  dept: string;
  name: string;
  path: string;
  description: string;
}

type MarketplaceAgentMeta = MarketplaceAgent & { installed: boolean };

function normalizeMarketplaceId(raw: string): string {
  // Prefix with "mp-" to avoid clashing with user-created `agent-xxxx` ids,
  // while preserving enough readability. Drop any non [\w\-] chars just in case.
  const safe = raw.replace(/[^\w\-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return `mp-${safe}`;
}

function listInstalledAgentIds(): Set<string> {
  const dir = getAgentsDir();
  const ids = new Set<string>();
  if (!fs.existsSync(dir)) return ids;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      ids.add(entry.name.slice(0, -3));
    }
  } catch {
    /* ignore */
  }
  return ids;
}

// List marketplace catalog (with optional search / dept filter + installed status).
agentDefinitionsRoutes.get('/marketplace/catalog', authMiddleware, (c) => {
  const q = (c.req.query('q') || '').trim().toLowerCase();
  const dept = (c.req.query('dept') || '').trim();
  const installedIds = listInstalledAgentIds();

  let list: MarketplaceAgentMeta[] = AGENCY_AGENTS_ZH_INDEX.map((a) => ({
    ...a,
    installed: installedIds.has(normalizeMarketplaceId(a.id)),
  }));

  if (dept) list = list.filter((a) => a.dept === dept);
  if (q) {
    list = list.filter(
      (a) =>
        a.name.toLowerCase().includes(q) ||
        a.description.toLowerCase().includes(q) ||
        a.id.toLowerCase().includes(q) ||
        a.dept.toLowerCase().includes(q),
    );
  }

  const departments = Array.from(
    new Set(AGENCY_AGENTS_ZH_INDEX.map((a) => a.dept)),
  ).sort();

  return c.json({
    total: list.length,
    departments,
    agents: list,
  });
});

// Fetch a single marketplace agent content (proxied from GitHub raw)
interface MarketplaceDetail extends MarketplaceAgentMeta {
  content: string | null;
  readme?: string | null;
}

agentDefinitionsRoutes.get('/marketplace/:agentId', authMiddleware, async (c) => {
  const agentId = c.req.param('agentId');
  const entry = AGENCY_AGENTS_ZH_INDEX.find((a) => a.id === agentId);
  if (!entry) return c.json({ error: 'Marketplace agent not found' }, 404);

  const installedIds = listInstalledAgentIds();
  const base: MarketplaceDetail = {
    ...entry,
    installed: installedIds.has(normalizeMarketplaceId(entry.id)),
    content: null,
  };

  try {
    const url = `${MARKETPLACE_RAW_BASE}/${entry.path}`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!resp.ok) {
      logger.warn({ url, status: resp.status }, 'marketplace fetch failed');
      return c.json({ agent: base });
    }
    const text = await resp.text();
    base.content = text;
    base.readme = text;
    return c.json({ agent: base });
  } catch (err) {
    logger.warn(
      { agentId, error: err instanceof Error ? err.message : String(err) },
      'marketplace agent detail fetch failed',
    );
    return c.json({ agent: base });
  }
});

interface InstallResult {
  success: boolean;
  id?: string;
  conflict?: boolean;
  overwrote?: boolean;
  error?: string;
}

// Install a marketplace agent into ~/.claude/agents/<normalized-id>.md
//
// Query/body params:
//   agentId: string            marketplace entry id (e.g. engineering-security-engineer)
//   force?: boolean            overwrite any existing file with the same target id (default false)
//   keepOriginalId?: boolean   use agentId literally as the file name (default false: use mp- prefix)
agentDefinitionsRoutes.post(
  '/marketplace/install',
  authMiddleware,
  systemConfigMiddleware,
  async (c): Promise<any> => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const agentId =
      typeof body.agentId === 'string' ? body.agentId.trim() : '';
    const force = body.force === true;
    const keepOriginalId = body.keepOriginalId === true;

    if (!agentId) {
      return c.json({ success: false, error: 'agentId is required' } as InstallResult, 400);
    }
    const entry = AGENCY_AGENTS_ZH_INDEX.find((a) => a.id === agentId);
    if (!entry) {
      return c.json({ success: false, error: 'Marketplace agent not found' } as InstallResult, 404);
    }

    const targetId = keepOriginalId ? agentId : normalizeMarketplaceId(agentId);
    if (!validateAgentId(targetId)) {
      return c.json({ success: false, error: 'Invalid resulting agent ID' } as InstallResult, 400);
    }

    // Fetch content from GitHub
    let content: string;
    try {
      const url = `${MARKETPLACE_RAW_BASE}/${entry.path}`;
      const resp = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (!resp.ok) {
        return c.json(
          {
            success: false,
            error: `Marketplace source unreachable (HTTP ${resp.status})`,
          } as InstallResult,
          502,
        );
      }
      content = await resp.text();
      if (!content || !content.startsWith('---')) {
        return c.json(
          { success: false, error: 'Marketplace content looks malformed' } as InstallResult,
          502,
        );
      }
    } catch (err) {
      return c.json(
        {
          success: false,
          error: err instanceof Error ? err.message : 'Unknown download error',
        } as InstallResult,
        502,
      );
    }

    const agentsDir = getAgentsDir();
    fs.mkdirSync(agentsDir, { recursive: true });
    const targetPath = path.join(agentsDir, `${targetId}.md`);
    const exists = fs.existsSync(targetPath);
    if (exists && !force) {
      return c.json(
        {
          success: false,
          id: targetId,
          conflict: true,
          error:
            '目标 ID 已存在，设置 force=true 可覆盖；或先删除本地同名 Agent。',
        } as InstallResult,
        409,
      );
    }

    try {
      fs.writeFileSync(targetPath, content, 'utf-8');
      return c.json({
        success: true,
        id: targetId,
        overwrote: exists,
      } as InstallResult);
    } catch (err) {
      logger.warn(
        {
          targetPath,
          error: err instanceof Error ? err.message : String(err),
        },
        'failed writing marketplace agent file',
      );
      return c.json(
        { success: false, error: '写入本地 Agent 文件失败' } as InstallResult,
        500,
      );
    }
  },
);

export default agentDefinitionsRoutes;
