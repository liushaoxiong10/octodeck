import crypto from 'crypto';
import Database from './sqlite-compat.js';
import fs from 'fs';
import path from 'path';

import { DATA_DIR, STORE_DIR, GROUPS_DIR } from './config.js';
import { getDatabaseBackendConfig } from './db-backend-config.js';
import {
  NoopPersistenceController,
  prepareSqlitePathForBackend,
  RemotePersistenceController,
} from './db-remote-store.js';
import { logger } from './logger.js';
import {
  AgentKind,
  AgentLink,
  AgentStatus,
  AuthAuditLog,
  AuthEventType,
  BalanceOperatorType,
  BalanceReferenceType,
  BalanceTransaction,
  BalanceTransactionSource,
  BalanceTransactionType,
  BillingAuditEventType,
  BillingAuditLog,
  BillingPlan,
  DailyUsage,
  ExecutionMode,
  GroupMember,
  InviteCode,
  InviteCodeWithCreator,
  MessageFinalizationReason,
  MonthlyUsage,
  NewMessage,
  MessageCursor,
  MessageSourceKind,
  ManagedRepo,
  ManagedRepoKind,
  RepoKnowledgeChunk,
  RepoKnowledgeChunkKind,
  RepoKnowledgeGraphEdge,
  RepoKnowledgeGraphEdgeKind,
  RepoKnowledgeIndex,
  RepoKnowledgeRun,
  RepoKnowledgeRunMilestone,
  RepoKnowledgeRunStatus,
  RepoKnowledgeSearchHit,
  RepoKnowledgeStatus,
  ImContextBinding,
  IssueAgentRun,
  IssueAgentRunEvent,
  IssueAgentRequest,
  IssueAttachment,
  IssueComment,
  IssueEvent,
  IssuePriority,
  IssueStatus,
  RedeemCode,
  RegisteredGroup,
  ScheduledTask,
  SubAgent,
  TaskRunLog,
  User,
  UserBalance,
  UserPublic,
  UserStatus,
  UserRole,
  UserSubscription,
  UserSession,
  UserSessionWithUser,
  WorkspaceIssue,
  Permission,
  PermissionTemplateKey,
} from './types.js';
import { getDefaultPermissions, normalizePermissions } from './permissions.js';

let db: InstanceType<typeof Database>;
let repoKnowledgeFtsAvailable = false;
let persistenceController: RemotePersistenceController =
  new NoopPersistenceController();
let persistenceExitHookRegistered = false;

// Prepared statement cache — lazy-initialized on first use after initDatabase()
let _stmts: {
  storeMessageSelect: any;
  storeMessageInsert: any;
  insertUsageInsert: any;
  insertUsageUpsert: any;
  getSessionWithUser: any;
  deleteSession: any;
  updateSessionLastActive: any;
  updateTokenUsageById: any;
  updateTokenUsageLatest: any;
  getMessagesSince: any;
  getExpiredSessionIds: any;
} | null = null;

const _newMsgStmtCache = new Map<number, any>();

function crypto_random_16(): string {
  return crypto.randomBytes(8).toString('hex');
}

function stmts() {
  if (!_stmts) {
    _stmts = {
      storeMessageSelect: db.prepare(
        `SELECT id FROM messages
         WHERE chat_jid = ? AND turn_id = ? AND source_kind = 'sdk_final'
         ORDER BY timestamp DESC LIMIT 1`,
      ),
      storeMessageInsert: db.prepare(
        `INSERT OR REPLACE INTO messages (
          id, chat_jid, source_jid, sender, sender_name, role, content, timestamp, is_from_me,
          attachments, token_usage, turn_id, session_id, sdk_message_uuid, source_kind, finalization_reason, task_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      insertUsageInsert: db.prepare(
        `INSERT INTO usage_records (id, user_id, group_folder, agent_id, message_id, model,
          input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens,
          cost_usd, duration_ms, num_turns, source, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      insertUsageUpsert: db.prepare(
        `INSERT INTO usage_daily_summary (user_id, model, date,
          total_input_tokens, total_output_tokens,
          total_cache_read_tokens, total_cache_creation_tokens,
          total_cost_usd, request_count, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, datetime('now'))
        ON CONFLICT(user_id, model, date) DO UPDATE SET
          total_input_tokens = total_input_tokens + excluded.total_input_tokens,
          total_output_tokens = total_output_tokens + excluded.total_output_tokens,
          total_cache_read_tokens = total_cache_read_tokens + excluded.total_cache_read_tokens,
          total_cache_creation_tokens = total_cache_creation_tokens + excluded.total_cache_creation_tokens,
          total_cost_usd = total_cost_usd + excluded.total_cost_usd,
          request_count = request_count + 1,
          updated_at = datetime('now')`,
      ),
      getSessionWithUser: db.prepare(
        `SELECT s.*, u.username, u.role, u.status, u.display_name, u.permissions, u.must_change_password
         FROM user_sessions s
         JOIN users u ON s.user_id = u.id
         WHERE s.id = ?`,
      ),
      deleteSession: db.prepare('DELETE FROM user_sessions WHERE id = ?'),
      updateSessionLastActive: db.prepare(
        'UPDATE user_sessions SET last_active_at = ? WHERE id = ?',
      ),
      updateTokenUsageById: db.prepare(
        `UPDATE messages SET token_usage = ?, cost_usd = ? WHERE id = ? AND chat_jid = ?`,
      ),
      updateTokenUsageLatest: db.prepare(
        `UPDATE messages SET token_usage = ?, cost_usd = ?
         WHERE rowid = (
           SELECT rowid FROM messages
           WHERE chat_jid = ? AND is_from_me = 1 AND token_usage IS NULL
             AND COALESCE(source_kind, 'legacy') != 'sdk_send_message'
           ORDER BY timestamp DESC LIMIT 1
         )`,
      ),
      getMessagesSince: db.prepare(
        `SELECT id, chat_jid, source_jid, sender, sender_name, role, content, timestamp, attachments, task_id
         FROM messages
         WHERE chat_jid = ? AND (timestamp > ? OR (timestamp = ? AND id > ?)) AND is_from_me = 0
         AND COALESCE(source_kind, '') != 'user_command'
         ORDER BY timestamp ASC, id ASC`,
      ),
      getExpiredSessionIds: db.prepare(
        'SELECT id FROM user_sessions WHERE expires_at < ?',
      ),
    };
  }
  return _stmts;
}

function getNewMessagesStmt(jidCount: number): any {
  let s = _newMsgStmtCache.get(jidCount);
  if (!s) {
    const placeholders = Array(jidCount).fill('?').join(',');
    s = db.prepare(
      `SELECT id, chat_jid, source_jid, sender, sender_name, role, content, timestamp, attachments, task_id
       FROM messages
       WHERE (timestamp > ? OR (timestamp = ? AND id > ?))
         AND chat_jid IN (${placeholders})
         AND is_from_me = 0
         AND COALESCE(source_kind, '') NOT IN ('user_command', 'scheduled_task_prompt')
       ORDER BY timestamp ASC, id ASC`,
    );
    _newMsgStmtCache.set(jidCount, s);
  }
  return s;
}

interface StoredMessageMeta {
  turnId?: string | null;
  sessionId?: string | null;
  sdkMessageUuid?: string | null;
  role?: 'user' | 'assistant' | 'tool' | null;
  sourceKind?: MessageSourceKind | null;
  finalizationReason?: MessageFinalizationReason | null;
  taskId?: string | null;
}

function hasColumn(tableName: string, columnName: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{
    name: string;
  }>;
  return columns.some((column) => column.name === columnName);
}

function ensureColumn(
  tableName: string,
  columnName: string,
  sqlTypeWithDefault: string,
): void {
  if (hasColumn(tableName, columnName)) return;
  db.exec(
    `ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${sqlTypeWithDefault}`,
  );
}

function assertSchema(
  tableName: string,
  requiredColumns: string[],
  forbiddenColumns: string[] = [],
): void {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{
    name: string;
  }>;
  const names = new Set(columns.map((c) => c.name));

  const missing = requiredColumns.filter((c) => !names.has(c));
  const forbidden = forbiddenColumns.filter((c) => names.has(c));

  if (missing.length > 0 || forbidden.length > 0) {
    throw new Error(
      `Incompatible DB schema in table "${tableName}". Missing: [${missing.join(', ')}], forbidden: [${forbidden.join(', ')}]. ` +
        'Please remove data/db/messages.db (or legacy store/messages.db) and restart.',
    );
  }
}

/** Internal helper — reads router_state before initDatabase exports are available. */
function getRouterStateInternal(key: string): string | undefined {
  try {
    const row = db
      .prepare('SELECT value FROM router_state WHERE key = ?')
      .get(key) as { value: string } | undefined;
    return row?.value;
  } catch {
    return undefined; // Table may not exist yet on first run
  }
}

function attachDatabasePersistenceHooks(
  database: InstanceType<typeof Database>,
  controller: RemotePersistenceController,
): void {
  const originalExec = database.exec.bind(database);
  database.exec = ((sql: string) => {
    const result = originalExec(sql);
    controller.schedulePersist();
    return result;
  }) as typeof database.exec;

  const originalPrepare = database.prepare.bind(database);
  database.prepare = ((sql: string) => {
    const statement = originalPrepare(sql);
    return new Proxy(statement, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (prop === 'run' && typeof value === 'function') {
          return (...args: unknown[]) => {
            const result = value.apply(target, args);
            controller.schedulePersist();
            return result;
          };
        }
        if (typeof value === 'function') return value.bind(target);
        return value;
      },
    });
  }) as typeof database.prepare;

  const originalTransaction = database.transaction.bind(database);
  database.transaction = ((fn: (...args: any[]) => any) => {
    const tx = originalTransaction(fn);
    return ((...args: unknown[]) => {
      const result = tx(...args);
      controller.schedulePersist();
      return result;
    }) as ReturnType<typeof database.transaction>;
  }) as typeof database.transaction;
}

function registerPersistenceExitHook(): void {
  if (persistenceExitHookRegistered) return;
  persistenceExitHookRegistered = true;
  process.once('beforeExit', () => {
    void persistenceController.flush().catch((err) => {
      logger.error({ err }, 'Failed to flush database persistence before exit');
    });
  });
}

function initializeSqliteDatabase(
  dbPath: string,
  controller: RemotePersistenceController,
): void {
  persistenceController = controller;
  _stmts = null;
  _newMsgStmtCache.clear();

  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new Database(dbPath);
  attachDatabasePersistenceHooks(db, controller);
  registerPersistenceExitHook();

  // Enable WAL mode for better concurrency and performance
  db.exec(
    controller.backend === 'sqlite'
      ? 'PRAGMA journal_mode = WAL'
      : 'PRAGMA journal_mode = DELETE',
  );
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(`
    CREATE TABLE IF NOT EXISTS chats (
      jid TEXT PRIMARY KEY,
      name TEXT,
      last_message_time TEXT,
      archived_at TEXT,
      archive_reason TEXT
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT,
      chat_jid TEXT,
      source_jid TEXT,
      sender TEXT,
      sender_name TEXT,
      role TEXT,
      content TEXT,
      timestamp TEXT,
      is_from_me INTEGER,
      attachments TEXT,
      token_usage TEXT,
      turn_id TEXT,
      session_id TEXT,
      sdk_message_uuid TEXT,
      source_kind TEXT,
      finalization_reason TEXT,
      PRIMARY KEY (id, chat_jid),
      FOREIGN KEY (chat_jid) REFERENCES chats(jid)
    );
    CREATE INDEX IF NOT EXISTS idx_timestamp ON messages(timestamp);
    CREATE INDEX IF NOT EXISTS idx_messages_jid_ts ON messages(chat_jid, timestamp);

    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      prompt TEXT NOT NULL,
      schedule_type TEXT NOT NULL,
      schedule_value TEXT NOT NULL,
      context_mode TEXT DEFAULT 'isolated',
      execution_type TEXT DEFAULT 'agent',
      runtime_profile TEXT,
      agent_client_id TEXT,
      backend TEXT,
      agent_model TEXT,
      script_command TEXT,
      next_run TEXT,
      last_run TEXT,
      last_result TEXT,
      status TEXT DEFAULT 'active',
      claim_token TEXT,
      claimed_by TEXT,
      claimed_at TEXT,
      lease_expires_at TEXT,
      created_at TEXT NOT NULL,
      created_by TEXT,
      notify_channels TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_next_run ON scheduled_tasks(next_run);
    CREATE INDEX IF NOT EXISTS idx_status ON scheduled_tasks(status);

    CREATE TABLE IF NOT EXISTS task_run_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      run_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      status TEXT NOT NULL,
      result TEXT,
      error TEXT,
      FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id)
    );
    CREATE INDEX IF NOT EXISTS idx_task_run_logs ON task_run_logs(task_id, run_at);

    CREATE TABLE IF NOT EXISTS issues (
      id TEXT PRIMARY KEY,
      workspace_jid TEXT NOT NULL,
      workspace_folder TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'todo',
      priority TEXT NOT NULL DEFAULT 'medium',
      assignee_user_id TEXT,
      due_date TEXT,
      project_repo_id TEXT,
      project_git_url TEXT,
      project_device_path TEXT,
      project_device_link_id TEXT,
      agent_link_id TEXT,
      agent_client_id TEXT,
      execution_node TEXT,
      backend TEXT,
      selected_skills TEXT,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      closed_at TEXT,
      last_run_id TEXT,
      last_run_status TEXT,
      last_run_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_issues_workspace_status ON issues(workspace_jid, status);
    CREATE INDEX IF NOT EXISTS idx_issues_updated_at ON issues(updated_at);
    CREATE INDEX IF NOT EXISTS idx_issues_created_by ON issues(created_by, created_at);

    CREATE TABLE IF NOT EXISTS issue_agent_runs (
      id TEXT PRIMARY KEY,
      issue_id TEXT NOT NULL,
      workspace_jid TEXT NOT NULL,
      workspace_folder TEXT NOT NULL,
      agent_link_id TEXT,
      agent_client_id TEXT,
      execution_node TEXT,
      backend TEXT,
      selected_skills TEXT,
      status TEXT NOT NULL DEFAULT 'queued',
      result TEXT,
      error TEXT,
      session_id TEXT,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      run_started_at TEXT,
      run_completed_at TEXT,
      FOREIGN KEY (issue_id) REFERENCES issues(id)
    );
    CREATE INDEX IF NOT EXISTS idx_issue_agent_runs_issue ON issue_agent_runs(issue_id, created_at);

    CREATE TABLE IF NOT EXISTS issue_agent_run_events (
      id TEXT PRIMARY KEY,
      issue_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      title TEXT,
      summary TEXT,
      detail TEXT,
      payload TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (issue_id) REFERENCES issues(id),
      FOREIGN KEY (run_id) REFERENCES issue_agent_runs(id)
    );
    CREATE INDEX IF NOT EXISTS idx_issue_run_events_run ON issue_agent_run_events(run_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_issue_run_events_issue ON issue_agent_run_events(issue_id, created_at);

    CREATE TABLE IF NOT EXISTS issue_agent_requests (
      id TEXT PRIMARY KEY,
      issue_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      correlation_id TEXT,
      title TEXT,
      summary TEXT,
      detail TEXT,
      payload TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      decision TEXT,
      answer TEXT,
      answered_at TEXT,
      answered_by TEXT,
      consumed_at TEXT,
      expires_at TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (issue_id) REFERENCES issues(id),
      FOREIGN KEY (run_id) REFERENCES issue_agent_runs(id)
    );
    CREATE INDEX IF NOT EXISTS idx_iar_run_status ON issue_agent_requests(run_id, status);
    CREATE INDEX IF NOT EXISTS idx_iar_issue_status ON issue_agent_requests(issue_id, status, created_at);
    CREATE INDEX IF NOT EXISTS idx_iar_correlation ON issue_agent_requests(correlation_id);

    CREATE TABLE IF NOT EXISTS issue_attachments (
      id TEXT PRIMARY KEY,
      issue_id TEXT NOT NULL,
      filename TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      data_url TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (issue_id) REFERENCES issues(id)
    );
    CREATE INDEX IF NOT EXISTS idx_issue_attachments_issue ON issue_attachments(issue_id, created_at);

    CREATE TABLE IF NOT EXISTS issue_events (
      id TEXT PRIMARY KEY,
      issue_id TEXT NOT NULL,
      run_id TEXT,
      event_type TEXT NOT NULL,
      actor_id TEXT,
      actor_type TEXT NOT NULL DEFAULT 'system',
      title TEXT,
      summary TEXT,
      detail TEXT,
      payload TEXT,
      reference_id TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (issue_id) REFERENCES issues(id),
      FOREIGN KEY (run_id) REFERENCES issue_agent_runs(id)
    );
    CREATE INDEX IF NOT EXISTS idx_issue_events_issue ON issue_events(issue_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_issue_events_run ON issue_events(run_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_issue_events_type ON issue_events(event_type, created_at);

    CREATE TABLE IF NOT EXISTS issue_comments (
      id TEXT PRIMARY KEY,
      issue_id TEXT NOT NULL,
      workspace_jid TEXT NOT NULL,
      body TEXT NOT NULL,
      created_by TEXT,
      source_type TEXT NOT NULL DEFAULT 'user',
      source_meta TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT,
      deleted_at TEXT,
      FOREIGN KEY (issue_id) REFERENCES issues(id)
    );
    CREATE INDEX IF NOT EXISTS idx_issue_comments_issue ON issue_comments(issue_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_issue_comments_workspace ON issue_comments(workspace_jid, created_at);

    CREATE TABLE IF NOT EXISTS issue_event_notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      target TEXT NOT NULL,
      sent_at TEXT NOT NULL,
      FOREIGN KEY (event_id) REFERENCES issue_events(id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_issue_event_notifications_unique ON issue_event_notifications(event_id, channel, target);
  `);

  // State tables (replacing JSON files)
  db.exec(`
    CREATE TABLE IF NOT EXISTS router_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS metadata_store (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS data_objects (
      key TEXT PRIMARY KEY,
      relative_path TEXT NOT NULL UNIQUE,
      entry_type TEXT NOT NULL DEFAULT 'file',
      content_type TEXT,
      data BLOB,
      size_bytes INTEGER NOT NULL DEFAULT 0,
      mode INTEGER,
      mtime_ms REAL,
      deleted_at TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_data_objects_path ON data_objects(relative_path);
    CREATE INDEX IF NOT EXISTS idx_data_objects_deleted ON data_objects(deleted_at);
    CREATE TABLE IF NOT EXISTS agent_team_runs (
      id TEXT PRIMARY KEY,
      team_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      prompt TEXT NOT NULL,
      status TEXT NOT NULL,
      trace_id TEXT NOT NULL,
      workflow_shape TEXT NOT NULL,
      role_assignments TEXT NOT NULL DEFAULT '{}',
      final_result TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_agent_team_runs_user_team_created ON agent_team_runs(user_id, team_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_agent_team_runs_user_status_created ON agent_team_runs(user_id, status, created_at);
    CREATE TABLE IF NOT EXISTS agent_team_tasks (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      role_id TEXT,
      phase TEXT,
      actor_id TEXT,
      status TEXT NOT NULL,
      attempt INTEGER NOT NULL DEFAULT 1,
      input TEXT,
      output TEXT,
      error TEXT,
      started_at TEXT,
      completed_at TEXT,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (run_id) REFERENCES agent_team_runs(id)
    );
    CREATE TABLE IF NOT EXISTS agent_team_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trace_id TEXT NOT NULL,
      span_id TEXT NOT NULL,
      parent_span_id TEXT,
      session_id TEXT,
      run_id TEXT NOT NULL,
      task_id TEXT,
      actor TEXT NOT NULL,
      type TEXT NOT NULL,
      payload TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      schema_version INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS agent_team_blackboard (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      task_id TEXT,
      role_id TEXT,
      kind TEXT NOT NULL,
      key TEXT NOT NULL,
      content_type TEXT NOT NULL,
      value TEXT NOT NULL,
      visibility TEXT NOT NULL DEFAULT 'run',
      created_at TEXT NOT NULL,
      FOREIGN KEY (run_id) REFERENCES agent_team_runs(id)
    );
    CREATE TABLE IF NOT EXISTS agent_team_artifacts (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      key TEXT NOT NULL,
      version INTEGER NOT NULL,
      content_type TEXT NOT NULL,
      value TEXT NOT NULL,
      source_step_id TEXT,
      source_task_id TEXT,
      source_role_id TEXT,
      confidence REAL,
      visibility TEXT NOT NULL DEFAULT 'run',
      created_at TEXT NOT NULL,
      FOREIGN KEY (run_id) REFERENCES agent_team_runs(id)
    );
    CREATE TABLE IF NOT EXISTS agent_team_artifact_edges (
      parent_artifact_id TEXT NOT NULL,
      child_artifact_id TEXT NOT NULL,
      relationship TEXT NOT NULL DEFAULT 'derived_from',
      created_at TEXT NOT NULL,
      PRIMARY KEY(parent_artifact_id, child_artifact_id, relationship)
    );
    CREATE TABLE IF NOT EXISTS agent_team_checkpoints (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      task_id TEXT,
      node_id TEXT NOT NULL,
      state TEXT NOT NULL,
      blackboard_cursor INTEGER,
      created_at TEXT NOT NULL,
      FOREIGN KEY (run_id) REFERENCES agent_team_runs(id)
    );
    CREATE TABLE IF NOT EXISTS agent_team_approvals (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      task_id TEXT,
      requested_by TEXT NOT NULL,
      status TEXT NOT NULL,
      risk_level TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      payload TEXT NOT NULL,
      resolved_by TEXT,
      resolved_at TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (run_id) REFERENCES agent_team_runs(id)
    );
    CREATE INDEX IF NOT EXISTS idx_agent_team_tasks_run ON agent_team_tasks(run_id, id);
    CREATE INDEX IF NOT EXISTS idx_agent_team_events_run ON agent_team_events(run_id, id);
    CREATE INDEX IF NOT EXISTS idx_agent_team_events_trace ON agent_team_events(trace_id, id);
    CREATE INDEX IF NOT EXISTS idx_agent_team_blackboard_run ON agent_team_blackboard(run_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_agent_team_artifacts_run_key ON agent_team_artifacts(run_id, key, version);
    CREATE INDEX IF NOT EXISTS idx_agent_team_checkpoints_run ON agent_team_checkpoints(run_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_agent_team_approvals_run ON agent_team_approvals(run_id, created_at);
    CREATE TABLE IF NOT EXISTS sessions (
      group_folder TEXT NOT NULL,
      session_id TEXT NOT NULL,
      agent_id TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (group_folder, agent_id)
    );
    CREATE TABLE IF NOT EXISTS registered_groups (
      jid TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      folder TEXT NOT NULL,
      added_at TEXT NOT NULL,
      container_config TEXT,
      created_by TEXT,
      is_home INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS im_context_bindings (
      source_jid TEXT NOT NULL,
      context_type TEXT NOT NULL,
      context_id TEXT NOT NULL,
      workspace_jid TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      root_message_id TEXT,
      title TEXT,
      last_active_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (source_jid, context_type, context_id)
    );
    CREATE INDEX IF NOT EXISTS idx_icb_workspace ON im_context_bindings(workspace_jid);
    CREATE INDEX IF NOT EXISTS idx_icb_agent ON im_context_bindings(agent_id);

    CREATE TABLE IF NOT EXISTS cloud_memories (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      memory_type TEXT NOT NULL,
      scope_key TEXT NOT NULL,
      group_folder TEXT,
      agent_id TEXT,
      device_link_id TEXT,
      path TEXT NOT NULL,
      content TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1,
      authority TEXT NOT NULL,
      source TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      updated_by TEXT,
      UNIQUE(user_id, memory_type, scope_key, path)
    );
    CREATE INDEX IF NOT EXISTS idx_cloud_memories_user_type ON cloud_memories(user_id, memory_type);
    CREATE INDEX IF NOT EXISTS idx_cloud_memories_scope ON cloud_memories(scope_key);
  `);

  // Auth tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      display_name TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL DEFAULT 'member',
      status TEXT NOT NULL DEFAULT 'active',
      permissions TEXT NOT NULL DEFAULT '[]',
      must_change_password INTEGER NOT NULL DEFAULT 0,
      disable_reason TEXT,
      notes TEXT,
      avatar_emoji TEXT,
      avatar_color TEXT,
      ai_name TEXT,
      ai_avatar_emoji TEXT,
      ai_avatar_color TEXT,
      ai_avatar_url TEXT,
      default_require_mention INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_login_at TEXT,
      deleted_at TEXT
    );

    CREATE TABLE IF NOT EXISTS invite_codes (
      code TEXT PRIMARY KEY,
      created_by TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member',
      permission_template TEXT,
      permissions TEXT NOT NULL DEFAULT '[]',
      max_uses INTEGER NOT NULL DEFAULT 1,
      used_count INTEGER NOT NULL DEFAULT 0,
      expires_at TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (created_by) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS user_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      ip_address TEXT,
      user_agent TEXT,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      last_active_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS auth_audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      username TEXT NOT NULL,
      actor_username TEXT,
      ip_address TEXT,
      user_agent TEXT,
      details TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_auth_audit_created ON auth_audit_log(created_at);
    CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_user_sessions_expires ON user_sessions(expires_at);
    CREATE INDEX IF NOT EXISTS idx_users_status_role ON users(status, role);
    CREATE INDEX IF NOT EXISTS idx_users_created_at ON users(created_at);
    CREATE INDEX IF NOT EXISTS idx_invites_created_at ON invite_codes(created_at);
  `);

  // Group members table for shared workspaces
  db.exec(`
    CREATE TABLE IF NOT EXISTS group_members (
      group_folder TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member',
      added_at TEXT NOT NULL,
      added_by TEXT,
      PRIMARY KEY (group_folder, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_group_members_user ON group_members(user_id);
  `);

  // User pinned groups (per-user workspace pinning)
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_pinned_groups (
      user_id TEXT NOT NULL,
      jid TEXT NOT NULL,
      pinned_at TEXT NOT NULL,
      PRIMARY KEY (user_id, jid)
    );
  `);

  // Sub-agents table for multi-agent parallel execution
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      name TEXT NOT NULL,
      prompt TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      created_by TEXT,
      created_at TEXT NOT NULL,
      completed_at TEXT,
      result_summary TEXT,
      last_im_jid TEXT,
      spawned_from_jid TEXT,
      source_kind TEXT,
      thread_id TEXT,
      root_message_id TEXT,
      title_source TEXT,
      last_active_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_agents_group ON agents(group_folder);
    CREATE INDEX IF NOT EXISTS idx_agents_jid ON agents(chat_jid);
    CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status);
  `);

  // Billing tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS billing_plans (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      tier INTEGER NOT NULL DEFAULT 0,
      monthly_cost_usd REAL NOT NULL DEFAULT 0,
      monthly_token_quota INTEGER,
      monthly_cost_quota REAL,
      daily_cost_quota REAL,
      weekly_cost_quota REAL,
      daily_token_quota INTEGER,
      weekly_token_quota INTEGER,
      rate_multiplier REAL NOT NULL DEFAULT 1.0,
      trial_days INTEGER,
      sort_order INTEGER NOT NULL DEFAULT 0,
      display_price TEXT,
      highlight INTEGER NOT NULL DEFAULT 0,
      max_groups INTEGER,
      max_concurrent_containers INTEGER,
      max_im_channels INTEGER,
      max_mcp_servers INTEGER,
      max_storage_mb INTEGER,
      allow_overage INTEGER NOT NULL DEFAULT 0,
      features TEXT NOT NULL DEFAULT '[]',
      is_default INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS user_subscriptions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      plan_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      started_at TEXT NOT NULL,
      expires_at TEXT,
      cancelled_at TEXT,
      trial_ends_at TEXT,
      notes TEXT,
      auto_renew INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (plan_id) REFERENCES billing_plans(id)
    );
    CREATE INDEX IF NOT EXISTS idx_user_sub_user ON user_subscriptions(user_id);
    CREATE INDEX IF NOT EXISTS idx_user_sub_status ON user_subscriptions(status);

    CREATE TABLE IF NOT EXISTS user_balances (
      user_id TEXT PRIMARY KEY,
      balance_usd REAL NOT NULL DEFAULT 0,
      total_deposited_usd REAL NOT NULL DEFAULT 0,
      total_consumed_usd REAL NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS balance_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      type TEXT NOT NULL,
      amount_usd REAL NOT NULL,
      balance_after REAL NOT NULL,
      description TEXT,
      reference_type TEXT,
      reference_id TEXT,
      actor_id TEXT,
      source TEXT NOT NULL DEFAULT 'system_adjustment',
      operator_type TEXT NOT NULL DEFAULT 'system',
      notes TEXT,
      idempotency_key TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_bal_tx_user ON balance_transactions(user_id);
    CREATE INDEX IF NOT EXISTS idx_bal_tx_created ON balance_transactions(created_at);

    CREATE TABLE IF NOT EXISTS monthly_usage (
      user_id TEXT NOT NULL,
      month TEXT NOT NULL,
      total_input_tokens INTEGER NOT NULL DEFAULT 0,
      total_output_tokens INTEGER NOT NULL DEFAULT 0,
      total_cost_usd REAL NOT NULL DEFAULT 0,
      message_count INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (user_id, month)
    );

    CREATE TABLE IF NOT EXISTS redeem_codes (
      code TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      value_usd REAL,
      plan_id TEXT,
      duration_days INTEGER,
      max_uses INTEGER NOT NULL DEFAULT 1,
      used_count INTEGER NOT NULL DEFAULT 0,
      expires_at TEXT,
      created_by TEXT NOT NULL,
      notes TEXT,
      batch_id TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS redeem_code_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL,
      user_id TEXT NOT NULL,
      redeemed_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_redeem_usage_user ON redeem_code_usage(user_id);

    CREATE TABLE IF NOT EXISTS billing_audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      user_id TEXT NOT NULL,
      actor_id TEXT,
      details TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_bill_audit_user ON billing_audit_log(user_id);
    CREATE INDEX IF NOT EXISTS idx_bill_audit_created ON billing_audit_log(created_at);

    CREATE TABLE IF NOT EXISTS daily_usage (
      user_id TEXT NOT NULL,
      date TEXT NOT NULL,
      total_input_tokens INTEGER NOT NULL DEFAULT 0,
      total_output_tokens INTEGER NOT NULL DEFAULT 0,
      total_cost_usd REAL NOT NULL DEFAULT 0,
      message_count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, date)
    );
    CREATE INDEX IF NOT EXISTS idx_daily_usage_date ON daily_usage(date);
    CREATE INDEX IF NOT EXISTS idx_daily_usage_user_date ON daily_usage(user_id, date);
  `);

  // Token usage tracking tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS usage_records (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      group_folder TEXT NOT NULL,
      agent_id TEXT,
      message_id TEXT,
      model TEXT NOT NULL DEFAULT 'unknown',
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_input_tokens INTEGER NOT NULL DEFAULT 0,
      cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0,
      duration_ms INTEGER DEFAULT 0,
      num_turns INTEGER DEFAULT 0,
      source TEXT NOT NULL DEFAULT 'agent',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_usage_user_date ON usage_records(user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_usage_group_date ON usage_records(group_folder, created_at);
    CREATE INDEX IF NOT EXISTS idx_usage_model_date ON usage_records(model, created_at);

    CREATE TABLE IF NOT EXISTS usage_daily_summary (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      model TEXT NOT NULL,
      date TEXT NOT NULL,
      total_input_tokens INTEGER NOT NULL DEFAULT 0,
      total_output_tokens INTEGER NOT NULL DEFAULT 0,
      total_cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      total_cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
      total_cost_usd REAL NOT NULL DEFAULT 0,
      request_count INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(user_id, model, date)
    );
    CREATE INDEX IF NOT EXISTS idx_daily_user_date ON usage_daily_summary(user_id, date);

    CREATE TABLE IF NOT EXISTS user_quotas (
      user_id TEXT PRIMARY KEY,
      monthly_cost_limit_usd REAL NOT NULL DEFAULT -1,
      monthly_token_limit INTEGER NOT NULL DEFAULT -1,
      daily_cost_limit_usd REAL NOT NULL DEFAULT -1,
      daily_request_limit INTEGER NOT NULL DEFAULT -1,
      billing_cycle_start TEXT,
      subscription_tier TEXT,
      subscription_expires_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Phase 5.1: octodeck-daemon client links. Online state lives only in
    -- AgentLinkRegistry memory; this table tracks identity, token hash,
    -- capabilities and last-seen heartbeat.
    CREATE TABLE IF NOT EXISTS agent_links (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      token_hash TEXT NOT NULL,
      capabilities TEXT NOT NULL DEFAULT '[]',
      agent_clients TEXT NOT NULL DEFAULT '[]',
      resources TEXT NOT NULL DEFAULT '{}',
      os TEXT,
      arch TEXT,
      hostname TEXT,
      client_version TEXT,
      last_connected_at TEXT,
      last_seen_at TEXT,
      created_at TEXT NOT NULL,
      revoked_at TEXT,
      FOREIGN KEY(user_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_agent_links_user ON agent_links(user_id);
    CREATE INDEX IF NOT EXISTS idx_agent_links_active
      ON agent_links(user_id) WHERE revoked_at IS NULL;

    CREATE TABLE IF NOT EXISTS cloud_skills (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      skill_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      content TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      package_name TEXT,
      package_source TEXT,
      source_provider TEXT,
      installed_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      files_json TEXT NOT NULL DEFAULT '[]',
      UNIQUE(user_id, skill_id),
      FOREIGN KEY(user_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_cloud_skills_user ON cloud_skills(user_id, updated_at);
    CREATE INDEX IF NOT EXISTS idx_cloud_skills_package ON cloud_skills(user_id, package_name);

    CREATE TABLE IF NOT EXISTS repos (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      git_url TEXT,
      main_branch TEXT,
      device_path TEXT,
      device_link_id TEXT,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_repos_created_by ON repos(created_by);

    CREATE TABLE IF NOT EXISTS repo_knowledge_indexes (
      repo_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      status TEXT NOT NULL,
      source_revision TEXT,
      summary TEXT,
      stats_json TEXT NOT NULL DEFAULT '{}',
      error TEXT,
      generated_at TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_repo_knowledge_indexes_user ON repo_knowledge_indexes(user_id, updated_at);

    CREATE TABLE IF NOT EXISTS repo_knowledge_runs (
      id TEXT PRIMARY KEY,
      repo_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      status TEXT NOT NULL,
      source_kind TEXT,
      execution_device_link_id TEXT,
      agent_client_id TEXT,
      upload_token_hash TEXT,
      files_uploaded_at TEXT,
      enabled_skills_json TEXT NOT NULL DEFAULT '[]',
      timeline_json TEXT NOT NULL DEFAULT '[]',
      stats_json TEXT NOT NULL DEFAULT '{}',
      error TEXT,
      queued_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_repo_knowledge_runs_repo ON repo_knowledge_runs(repo_id, user_id, updated_at);
    CREATE INDEX IF NOT EXISTS idx_repo_knowledge_runs_user ON repo_knowledge_runs(user_id, updated_at);

    CREATE TABLE IF NOT EXISTS repo_knowledge_chunks (
      id TEXT PRIMARY KEY,
      repo_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      path TEXT NOT NULL,
      kind TEXT NOT NULL,
      name TEXT,
      language TEXT,
      start_line INTEGER,
      end_line INTEGER,
      content TEXT NOT NULL,
      keywords TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_repo_knowledge_chunks_repo ON repo_knowledge_chunks(repo_id, kind, path);
    CREATE INDEX IF NOT EXISTS idx_repo_knowledge_chunks_user ON repo_knowledge_chunks(user_id, updated_at);

    CREATE TABLE IF NOT EXISTS repo_knowledge_graph_edges (
      id TEXT PRIMARY KEY,
      repo_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      from_path TEXT NOT NULL,
      to_path TEXT,
      edge_kind TEXT NOT NULL,
      symbol TEXT,
      package_name TEXT,
      source TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_repo_knowledge_edges_from ON repo_knowledge_graph_edges(repo_id, user_id, from_path, edge_kind);
    CREATE INDEX IF NOT EXISTS idx_repo_knowledge_edges_to ON repo_knowledge_graph_edges(repo_id, user_id, to_path, edge_kind);
    CREATE INDEX IF NOT EXISTS idx_repo_knowledge_edges_package ON repo_knowledge_graph_edges(repo_id, user_id, package_name);
  `);

  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS repo_knowledge_chunks_fts USING fts5(
        chunk_id UNINDEXED,
        repo_id UNINDEXED,
        user_id UNINDEXED,
        path,
        kind,
        name,
        language,
        keywords,
        content
      );
    `);
    repoKnowledgeFtsAvailable = true;
  } catch (err) {
    repoKnowledgeFtsAvailable = false;
    logger.warn({ err }, 'SQLite FTS5 unavailable for repo knowledge; falling back to LIKE search');
  }

  // Lightweight migrations for existing DBs
  ensureColumn('users', 'permissions', "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn('users', 'must_change_password', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('users', 'disable_reason', 'TEXT');
  ensureColumn('users', 'notes', 'TEXT');
  ensureColumn('users', 'deleted_at', 'TEXT');
  ensureColumn('invite_codes', 'permission_template', 'TEXT');
  ensureColumn('invite_codes', 'permissions', "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn('users', 'avatar_emoji', 'TEXT');
  ensureColumn('users', 'avatar_color', 'TEXT');
  ensureColumn('repos', 'main_branch', 'TEXT');
  ensureColumn('repo_knowledge_chunks', 'metadata_json', "TEXT NOT NULL DEFAULT '{}'");
  ensureColumn('chats', 'archived_at', 'TEXT');
  ensureColumn('chats', 'archive_reason', 'TEXT');
  ensureColumn(
    'registered_groups',
    'execution_mode',
    "TEXT DEFAULT 'container'",
  );
  ensureColumn('registered_groups', 'custom_cwd', 'TEXT');
  ensureColumn('registered_groups', 'repo_id', 'TEXT');
  ensureColumn('registered_groups', 'repo_git_url', 'TEXT');
  ensureColumn('registered_groups', 'repo_main_branch', 'TEXT');
  ensureColumn('registered_groups', 'repo_device_path', 'TEXT');
  ensureColumn('registered_groups', 'visible_repo_mode', 'TEXT');
  ensureColumn('registered_groups', 'visible_repo_ids', 'TEXT');
  ensureColumn('registered_groups', 'init_source_path', 'TEXT');
  ensureColumn('registered_groups', 'init_git_url', 'TEXT');
  ensureColumn('messages', 'attachments', 'TEXT');
  ensureColumn('messages', 'source_jid', 'TEXT');
  ensureColumn('registered_groups', 'created_by', 'TEXT');
  ensureColumn('registered_groups', 'is_home', 'INTEGER DEFAULT 0');
  ensureColumn('users', 'avatar_url', 'TEXT');
  ensureColumn('users', 'ai_name', 'TEXT');
  ensureColumn('users', 'ai_avatar_emoji', 'TEXT');
  ensureColumn('users', 'ai_avatar_color', 'TEXT');
  ensureColumn('users', 'ai_avatar_url', 'TEXT');
  ensureColumn(
    'users',
    'default_require_mention',
    'INTEGER NOT NULL DEFAULT 0',
  );
  ensureColumn('scheduled_tasks', 'created_by', 'TEXT');
  ensureColumn('scheduled_tasks', 'execution_type', "TEXT DEFAULT 'agent'");
  ensureColumn('scheduled_tasks', 'runtime_profile', 'TEXT');
  ensureColumn('scheduled_tasks', 'agent_client_id', 'TEXT');
  ensureColumn('scheduled_tasks', 'backend', 'TEXT');
  ensureColumn('scheduled_tasks', 'agent_model', 'TEXT');
  ensureColumn('scheduled_tasks', 'script_command', 'TEXT');
  ensureColumn('scheduled_tasks', 'notify_channels', 'TEXT');
  ensureColumn('scheduled_tasks', 'execution_mode', 'TEXT');
  ensureColumn('scheduled_tasks', 'execution_node', 'TEXT');
  ensureColumn('scheduled_tasks', 'workspace_jid', 'TEXT');
  ensureColumn('scheduled_tasks', 'workspace_folder', 'TEXT');
  ensureColumn('scheduled_tasks', 'claim_token', 'TEXT');
  ensureColumn('scheduled_tasks', 'claimed_by', 'TEXT');
  ensureColumn('scheduled_tasks', 'claimed_at', 'TEXT');
  ensureColumn('scheduled_tasks', 'lease_expires_at', 'TEXT');
  ensureColumn('issues', 'assignee_user_id', 'TEXT');
  ensureColumn('issues', 'due_date', 'TEXT');
  ensureColumn('issues', 'project_repo_id', 'TEXT');
  ensureColumn('issues', 'project_git_url', 'TEXT');
  ensureColumn('issues', 'project_device_path', 'TEXT');
  ensureColumn('issues', 'project_device_link_id', 'TEXT');
  ensureColumn('issues', 'agent_link_id', 'TEXT');
  ensureColumn('issues', 'agent_client_id', 'TEXT');
  ensureColumn('issues', 'execution_node', 'TEXT');
  ensureColumn('issues', 'backend', 'TEXT');
  ensureColumn('issues', 'selected_skills', 'TEXT');
  ensureColumn('issues', 'due_date', 'TEXT');
  ensureColumn('issues', 'last_run_id', 'TEXT');
  ensureColumn('issues', 'last_run_status', 'TEXT');
  ensureColumn('issues', 'last_run_at', 'TEXT');
  ensureColumn('issue_agent_run_events', 'title', 'TEXT');
  ensureColumn('issue_agent_run_events', 'summary', 'TEXT');
  ensureColumn('issue_agent_run_events', 'detail', 'TEXT');
  ensureColumn('issue_agent_run_events', 'payload', 'TEXT');
  ensureColumn('issue_agent_runs', 'last_seen_at', 'TEXT');
  ensureColumn('issue_agent_runs', 'heartbeat_deadline_at', 'TEXT');
  ensureColumn('issue_agent_runs', 'awaiting_kind', 'TEXT');
  ensureColumn('issue_agent_runs', 'awaiting_payload_id', 'TEXT');
  ensureColumn('issue_agent_runs', 'parent_run_id', 'TEXT');
  try {
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_issue_agent_runs_status_seen ON issue_agent_runs(status, last_seen_at)',
    );
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_issue_agent_runs_parent ON issue_agent_runs(parent_run_id)',
    );
  } catch {
    // ignore: idempotent index creation
  }
  ensureColumn('issue_attachments', 'filename', 'TEXT');
  ensureColumn('issue_attachments', 'mime_type', 'TEXT');
  ensureColumn('issue_attachments', 'size_bytes', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('issue_attachments', 'data_url', 'TEXT');
  ensureColumn('registered_groups', 'selected_skills', 'TEXT');
  ensureColumn('sessions', 'agent_id', "TEXT NOT NULL DEFAULT ''");
  ensureColumn('sessions', 'workspace_session_id', 'TEXT');
  ensureColumn('agents', 'kind', "TEXT NOT NULL DEFAULT 'task'");
  ensureColumn('registered_groups', 'target_agent_id', 'TEXT');
  ensureColumn('registered_groups', 'target_main_jid', 'TEXT');
  ensureColumn(
    'registered_groups',
    'reply_policy',
    "TEXT DEFAULT 'source_only'",
  );
  ensureColumn('registered_groups', 'require_mention', 'INTEGER DEFAULT 0');
  ensureColumn('registered_groups', 'mcp_mode', "TEXT DEFAULT 'inherit'");
  ensureColumn('registered_groups', 'selected_mcps', 'TEXT');
  ensureColumn('registered_groups', 'activation_mode', "TEXT DEFAULT 'auto'");
  ensureColumn('registered_groups', 'owner_im_id', 'TEXT');
  ensureColumn(
    'registered_groups',
    'conversation_source',
    "TEXT DEFAULT 'manual'",
  );
  ensureColumn(
    'registered_groups',
    'conversation_nav_mode',
    "TEXT DEFAULT 'horizontal'",
  );
  ensureColumn(
    'registered_groups',
    'binding_mode',
    "TEXT DEFAULT 'single_context'",
  );
  ensureColumn('registered_groups', 'feishu_chat_mode', 'TEXT');
  ensureColumn('registered_groups', 'feishu_group_message_type', 'TEXT');
  ensureColumn('registered_groups', 'sender_allowlist', 'TEXT');
  ensureColumn('registered_groups', 'backend', 'TEXT');
  ensureColumn('registered_groups', 'runtime_profile', 'TEXT');
  ensureColumn('registered_groups', 'device_link_id', 'TEXT');
  ensureColumn('registered_groups', 'agent_client_id', 'TEXT');
  ensureColumn('registered_groups', 'agent_model', 'TEXT');
  ensureColumn('registered_groups', 'agent_access_scope', 'TEXT');
  ensureColumn('registered_groups', 'permission_mode', 'TEXT');
  // Phase 5.1: per-group execution node (server-local | <agent_link_id>)
  ensureColumn('registered_groups', 'execution_node', 'TEXT');
  ensureColumn('agent_links', 'agent_clients', "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn('agent_links', 'resources', "TEXT NOT NULL DEFAULT '{}'");
  ensureColumn('messages', 'token_usage', 'TEXT');
  ensureColumn('messages', 'role', 'TEXT');
  ensureColumn('messages', 'turn_id', 'TEXT');
  ensureColumn('messages', 'session_id', 'TEXT');
  ensureColumn('messages', 'sdk_message_uuid', 'TEXT');
  ensureColumn('messages', 'source_kind', 'TEXT');
  ensureColumn('messages', 'finalization_reason', 'TEXT');
  ensureColumn('messages', 'task_id', 'TEXT');
  ensureColumn('agents', 'source_kind', 'TEXT');
  ensureColumn('agents', 'thread_id', 'TEXT');
  ensureColumn('agents', 'root_message_id', 'TEXT');
  ensureColumn('agents', 'title_source', 'TEXT');
  ensureColumn('agents', 'last_active_at', 'TEXT');

  // Add index on target_agent_id for fast lookup of IM bindings
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_rg_target_agent ON registered_groups(target_agent_id)',
  );
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_rg_target_main ON registered_groups(target_main_jid)',
  );

  // Migration: remove UNIQUE constraint from registered_groups.folder
  // Multiple groups (web:main + feishu chats) share folder='main' by design.
  // The old UNIQUE constraint caused INSERT OR REPLACE to silently delete
  // the conflicting row, making web:main and feishu groups mutually exclusive.
  const hasUniqueFolder =
    (
      db
        .prepare(
          `SELECT COUNT(*) as cnt FROM sqlite_master
         WHERE type='index' AND tbl_name='registered_groups'
         AND name='sqlite_autoindex_registered_groups_2'`,
        )
        .get() as { cnt: number }
    ).cnt > 0;
  if (hasUniqueFolder) {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE registered_groups_new (
          jid TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          folder TEXT NOT NULL,
          added_at TEXT NOT NULL,
          container_config TEXT,
          execution_mode TEXT DEFAULT 'container',
          custom_cwd TEXT,
          repo_id TEXT,
          repo_git_url TEXT,
          repo_main_branch TEXT,
          repo_device_path TEXT,
          init_source_path TEXT,
          init_git_url TEXT,
          created_by TEXT,
          is_home INTEGER DEFAULT 0
        );
        INSERT INTO registered_groups_new SELECT jid, name, folder, added_at, container_config, execution_mode, custom_cwd, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0 FROM registered_groups;
        DROP TABLE registered_groups;
        ALTER TABLE registered_groups_new RENAME TO registered_groups;
      `);
    })();
  }

  // v19→v20 migration: add token_usage column to messages
  ensureColumn('messages', 'token_usage', 'TEXT');
  assertSchema('messages', [
    'id',
    'chat_jid',
    'source_jid',
    'sender',
    'sender_name',
    'content',
    'timestamp',
    'is_from_me',
    'attachments',
    'token_usage',
  ]);
  assertSchema('scheduled_tasks', [
    'id',
    'group_folder',
    'chat_jid',
    'prompt',
    'schedule_type',
    'schedule_value',
    'context_mode',
    'next_run',
    'last_run',
    'last_result',
    'status',
    'claim_token',
    'claimed_by',
    'claimed_at',
    'lease_expires_at',
    'created_at',
    'created_by',
    'execution_type',
    'runtime_profile',
    'agent_client_id',
    'backend',
    'agent_model',
    'script_command',
    'execution_mode',
    'execution_node',
    'notify_channels',
  ]);
  assertSchema('issues', [
    'id',
    'workspace_jid',
    'workspace_folder',
    'title',
    'description',
    'status',
    'priority',
    'created_by',
    'created_at',
    'updated_at',
  ]);
  assertSchema(
    'registered_groups',
    [
      'jid',
      'name',
      'folder',
      'added_at',
      'container_config',
      'execution_mode',
      'custom_cwd',
      'repo_id',
      'repo_git_url',
      'repo_main_branch',
      'repo_device_path',
      'init_source_path',
      'init_git_url',
      'created_by',
      'is_home',
      'selected_skills',
      'target_agent_id',
      'target_main_jid',
      'reply_policy',
    ],
    ['trigger_pattern', 'requires_trigger'],
  );

  assertSchema('users', [
    'id',
    'username',
    'password_hash',
    'display_name',
    'role',
    'status',
    'permissions',
    'must_change_password',
    'disable_reason',
    'notes',
    'avatar_emoji',
    'avatar_color',
    'avatar_url',
    'ai_name',
    'ai_avatar_emoji',
    'ai_avatar_color',
    'ai_avatar_url',
    'default_require_mention',
    'created_at',
    'updated_at',
    'last_login_at',
    'deleted_at',
  ]);
  assertSchema('user_sessions', [
    'id',
    'user_id',
    'ip_address',
    'user_agent',
    'created_at',
    'expires_at',
    'last_active_at',
  ]);
  assertSchema('invite_codes', [
    'code',
    'created_by',
    'role',
    'permission_template',
    'permissions',
    'max_uses',
    'used_count',
    'expires_at',
    'created_at',
  ]);
  assertSchema('auth_audit_log', [
    'id',
    'event_type',
    'username',
    'actor_username',
    'ip_address',
    'user_agent',
    'details',
    'created_at',
  ]);

  // Store schema version after all migrations complete
  // Migrate existing web groups: assign to first admin
  db.exec(`
    UPDATE registered_groups SET created_by = (
      SELECT id FROM users WHERE role = 'admin' AND status = 'active' ORDER BY created_at ASC LIMIT 1
    ) WHERE jid LIKE 'web:%' AND folder != 'main' AND created_by IS NULL
  `);

  // Backfill owner for legacy web:main if missing.
  db.exec(`
    UPDATE registered_groups SET created_by = (
      SELECT id FROM users WHERE role = 'admin' AND status = 'active' ORDER BY created_at ASC LIMIT 1
    ) WHERE jid = 'web:main' AND created_by IS NULL
  `);

  // Backfill created_by for feishu/telegram groups by matching sibling groups in the same folder.
  // Only backfill when the folder has exactly one distinct owner; otherwise keep NULL
  // to avoid misrouting in ambiguous folders (e.g., shared admin main).
  db.exec(`
    UPDATE registered_groups
    SET created_by = (
      SELECT MIN(rg2.created_by)
      FROM registered_groups rg2
      WHERE rg2.folder = registered_groups.folder
        AND rg2.created_by IS NOT NULL
    )
    WHERE (jid LIKE 'feishu:%' OR jid LIKE 'telegram:%')
      AND created_by IS NULL
      AND (
        SELECT COUNT(DISTINCT rg3.created_by)
        FROM registered_groups rg3
        WHERE rg3.folder = registered_groups.folder
          AND rg3.created_by IS NOT NULL
      ) = 1
  `);

  // v13 migration: mark existing web:main group as is_home=1
  db.exec(`
    UPDATE registered_groups SET is_home = 1
    WHERE jid = 'web:main' AND folder = 'main' AND is_home = 0
  `);

  // v15 migration: backfill group_members for existing web groups
  const currentVersion = getRouterStateInternal('schema_version');
  if (!currentVersion || parseInt(currentVersion, 10) < 15) {
    db.transaction(() => {
      // Backfill owner records for all web groups with created_by set
      const webGroups = db
        .prepare(
          "SELECT DISTINCT folder, created_by FROM registered_groups WHERE jid LIKE 'web:%' AND created_by IS NOT NULL",
        )
        .all() as Array<{ folder: string; created_by: string }>;
      for (const g of webGroups) {
        db.prepare(
          `INSERT OR IGNORE INTO group_members (group_folder, user_id, role, added_at, added_by)
           VALUES (?, ?, 'owner', ?, ?)`,
        ).run(g.folder, g.created_by, new Date().toISOString(), g.created_by);
      }
    })();
  }

  // v16→v17 migration: rebuild sessions table with composite primary key
  // Old PK was (group_folder), which cannot store multiple agent sessions per folder.
  // New PK is (group_folder, COALESCE(agent_id, '')) to support per-agent sessions.
  const curVer = getRouterStateInternal('schema_version');
  if (curVer && parseInt(curVer, 10) < 17) {
    db.transaction(() => {
      // Check if the old table has single-column PK by inspecting table_info
      const pkCols = (
        db.prepare("PRAGMA table_info('sessions')").all() as Array<{
          name: string;
          pk: number;
        }>
      ).filter((c) => c.pk > 0);
      // Old schema: single PK column 'group_folder'. New schema: composite PK needs rebuild.
      if (pkCols.length === 1 && pkCols[0].name === 'group_folder') {
        db.exec(`
          CREATE TABLE sessions_new (
            group_folder TEXT NOT NULL,
            session_id TEXT NOT NULL,
            agent_id TEXT NOT NULL DEFAULT '',
            PRIMARY KEY (group_folder, agent_id)
          );
          INSERT OR IGNORE INTO sessions_new (group_folder, session_id, agent_id)
            SELECT group_folder, session_id, COALESCE(agent_id, '') FROM sessions;
          DROP TABLE sessions;
          ALTER TABLE sessions_new RENAME TO sessions;
        `);
      }
    })();
  }

  // v22: Fix target_main_jid that used folder-based JID (web:${folder})
  // instead of actual registered group JID (web:${uuid}).
  // Only affects non-home workspaces where folder != uuid.
  if (curVer && parseInt(curVer, 10) < 22) {
    const rows = db
      .prepare(
        "SELECT jid, target_main_jid FROM registered_groups WHERE target_main_jid IS NOT NULL AND target_main_jid != ''",
      )
      .all() as Array<{ jid: string; target_main_jid: string }>;
    for (const row of rows) {
      const targetJid = row.target_main_jid;
      // Check if target_main_jid is a real registered group JID
      const exists = db
        .prepare('SELECT 1 FROM registered_groups WHERE jid = ?')
        .get(targetJid);
      if (exists) continue;
      // Not a valid JID — try to resolve via folder
      if (!targetJid.startsWith('web:')) continue;
      const folder = targetJid.slice(4);
      const candidates = db
        .prepare(
          "SELECT jid FROM registered_groups WHERE folder = ? AND jid LIKE 'web:%'",
        )
        .all(folder) as Array<{ jid: string }>;
      if (candidates.length === 1) {
        db.prepare(
          'UPDATE registered_groups SET target_main_jid = ? WHERE jid = ?',
        ).run(candidates[0].jid, row.jid);
      }
    }
  }

  // v23→v24 migration: billing system initialization
  ensureColumn('users', 'subscription_plan_id', 'TEXT');
  const v24Ver = getRouterStateInternal('schema_version');
  if (!v24Ver || parseInt(v24Ver, 10) < 24) {
    db.transaction(() => {
      // Ensure a default free plan exists
      const existingDefault = db
        .prepare('SELECT id FROM billing_plans WHERE is_default = 1')
        .get();
      if (!existingDefault) {
        const now = new Date().toISOString();
        db.prepare(
          `INSERT OR IGNORE INTO billing_plans (id, name, description, tier, monthly_cost_usd, allow_overage, features, is_default, is_active, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run('free', '免费版', '基础免费套餐', 0, 0, 0, '[]', 1, 1, now, now);
      }

      // Initialize balances for all existing users
      const users = db
        .prepare("SELECT id FROM users WHERE status != 'deleted'")
        .all() as Array<{ id: string }>;
      const now = new Date().toISOString();
      for (const u of users) {
        db.prepare(
          'INSERT OR IGNORE INTO user_balances (user_id, balance_usd, total_deposited_usd, total_consumed_usd, updated_at) VALUES (?, 0, 0, 0, ?)',
        ).run(u.id, now);
      }

      // Create active subscriptions for existing users → free plan
      const freePlan = db
        .prepare('SELECT id FROM billing_plans WHERE is_default = 1')
        .get() as { id: string } | undefined;
      if (freePlan) {
        for (const u of users) {
          const existing = db
            .prepare(
              "SELECT id FROM user_subscriptions WHERE user_id = ? AND status = 'active'",
            )
            .get(u.id);
          if (!existing) {
            const subId = `sub_${u.id}_${Date.now()}`;
            db.prepare(
              `INSERT INTO user_subscriptions (id, user_id, plan_id, status, started_at, created_at)
               VALUES (?, ?, ?, 'active', ?, ?)`,
            ).run(subId, u.id, freePlan.id, now, now);
          }
        }
      }
    })();
  }

  // v24→v25 migration: billing system enhancement (daily/weekly quotas, rate_multiplier, trial)
  ensureColumn('billing_plans', 'daily_cost_quota', 'REAL');
  ensureColumn('billing_plans', 'weekly_cost_quota', 'REAL');
  ensureColumn('billing_plans', 'daily_token_quota', 'INTEGER');
  ensureColumn('billing_plans', 'weekly_token_quota', 'INTEGER');
  ensureColumn('billing_plans', 'rate_multiplier', 'REAL NOT NULL DEFAULT 1.0');
  ensureColumn('billing_plans', 'trial_days', 'INTEGER');
  ensureColumn('billing_plans', 'sort_order', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('billing_plans', 'display_price', 'TEXT');
  ensureColumn('billing_plans', 'highlight', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('user_subscriptions', 'trial_ends_at', 'TEXT');
  ensureColumn('user_subscriptions', 'notes', 'TEXT');
  ensureColumn('redeem_codes', 'batch_id', 'TEXT');

  // v25→v26 migration: cost_usd on messages + idempotency key for balance transactions
  ensureColumn('messages', 'cost_usd', 'REAL');

  // idempotency key for balance transactions
  ensureColumn('balance_transactions', 'idempotency_key', 'TEXT');
  ensureColumn(
    'balance_transactions',
    'source',
    "TEXT NOT NULL DEFAULT 'system_adjustment'",
  );
  ensureColumn(
    'balance_transactions',
    'operator_type',
    "TEXT NOT NULL DEFAULT 'system'",
  );
  ensureColumn('balance_transactions', 'notes', 'TEXT');
  // Create unique index only if it doesn't exist
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_bal_tx_idempotency ON balance_transactions(idempotency_key) WHERE idempotency_key IS NOT NULL`,
  );

  // v26→v27 migration: wallet-first commercialization baseline
  const v27Ver = getRouterStateInternal('schema_version');
  if (!v27Ver || parseInt(v27Ver, 10) < 27) {
    db.transaction(() => {
      const now = new Date().toISOString();
      const users = db
        .prepare(
          "SELECT id, role FROM users WHERE status != 'deleted' AND role != 'admin'",
        )
        .all() as Array<{ id: string; role: UserRole }>;
      for (const user of users) {
        db.prepare(
          `INSERT OR IGNORE INTO user_balances (
            user_id, balance_usd, total_deposited_usd, total_consumed_usd, updated_at
          ) VALUES (?, 0, 0, 0, ?)`,
        ).run(user.id, now);
        db.prepare(
          `UPDATE user_balances
           SET balance_usd = 0, total_deposited_usd = 0, total_consumed_usd = 0, updated_at = ?
           WHERE user_id = ?`,
        ).run(now, user.id);

        const hasOpening = db
          .prepare(
            "SELECT 1 FROM balance_transactions WHERE user_id = ? AND source = 'migration_opening' LIMIT 1",
          )
          .get(user.id);
        if (!hasOpening) {
          db.prepare(
            `INSERT INTO balance_transactions (
              user_id, type, amount_usd, balance_after, description, reference_type,
              reference_id, actor_id, source, operator_type, notes, idempotency_key, created_at
            ) VALUES (?, 'adjustment', 0, 0, ?, NULL, NULL, NULL, 'migration_opening', 'system', ?, NULL, ?)`,
          ).run(
            user.id,
            '商业化计费上线初始化',
            '上线迁移：普通用户默认余额归零，需充值后使用',
            now,
          );
        }
      }
    })();
  }

  // v27→v28: Token usage tables + history migration
  const v28Check = getRouterStateInternal('schema_version');
  if (!v28Check || parseInt(v28Check, 10) < 28) {
    db.transaction(() => {
      // Count messages with token_usage for logging
      const countBefore = (
        db
          .prepare(
            "SELECT COUNT(*) as cnt FROM messages WHERE token_usage IS NOT NULL AND json_extract(token_usage, '$.modelUsage') IS NOT NULL",
          )
          .get() as { cnt: number }
      ).cnt;

      // Migrate from messages.token_usage modelUsage into usage_records
      db.exec(`
        INSERT OR IGNORE INTO usage_records (id, user_id, group_folder, message_id, model,
          input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens,
          cost_usd, duration_ms, num_turns, source, created_at)
        SELECT
          lower(hex(randomblob(16))),
          COALESCE(rg.created_by, 'system'),
          COALESCE(rg.folder, m.chat_jid),
          m.id,
          COALESCE(jme.key, 'unknown'),
          COALESCE(json_extract(jme.value, '$.inputTokens'), 0),
          COALESCE(json_extract(jme.value, '$.outputTokens'), 0),
          0, 0,
          COALESCE(json_extract(jme.value, '$.costUSD'), 0),
          COALESCE(json_extract(m.token_usage, '$.durationMs'), 0),
          COALESCE(json_extract(m.token_usage, '$.numTurns'), 0),
          'agent',
          m.timestamp
        FROM messages m
          JOIN json_each(json_extract(m.token_usage, '$.modelUsage')) jme
          LEFT JOIN registered_groups rg ON rg.jid = m.chat_jid
        WHERE m.token_usage IS NOT NULL
          AND json_extract(m.token_usage, '$.modelUsage') IS NOT NULL
      `);

      // Migrate messages without modelUsage (legacy) using root-level fields
      db.exec(`
        INSERT OR IGNORE INTO usage_records (id, user_id, group_folder, message_id, model,
          input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens,
          cost_usd, duration_ms, num_turns, source, created_at)
        SELECT
          lower(hex(randomblob(16))),
          COALESCE(rg.created_by, 'system'),
          COALESCE(rg.folder, m.chat_jid),
          m.id,
          'legacy-unknown',
          COALESCE(json_extract(m.token_usage, '$.inputTokens'), 0),
          COALESCE(json_extract(m.token_usage, '$.outputTokens'), 0),
          COALESCE(json_extract(m.token_usage, '$.cacheReadInputTokens'), 0),
          COALESCE(json_extract(m.token_usage, '$.cacheCreationInputTokens'), 0),
          COALESCE(json_extract(m.token_usage, '$.costUSD'), 0),
          COALESCE(json_extract(m.token_usage, '$.durationMs'), 0),
          COALESCE(json_extract(m.token_usage, '$.numTurns'), 0),
          'agent',
          m.timestamp
        FROM messages m
          LEFT JOIN registered_groups rg ON rg.jid = m.chat_jid
        WHERE m.token_usage IS NOT NULL
          AND (json_extract(m.token_usage, '$.modelUsage') IS NULL
               OR json_type(json_extract(m.token_usage, '$.modelUsage')) != 'object')
      `);

      // Build daily summary from usage_records
      db.exec(`
        INSERT OR REPLACE INTO usage_daily_summary (user_id, model, date,
          total_input_tokens, total_output_tokens,
          total_cache_read_tokens, total_cache_creation_tokens,
          total_cost_usd, request_count, updated_at)
        SELECT
          user_id, model, date(created_at, 'localtime'),
          SUM(input_tokens), SUM(output_tokens),
          SUM(cache_read_input_tokens), SUM(cache_creation_input_tokens),
          SUM(cost_usd), COUNT(*), datetime('now')
        FROM usage_records
        GROUP BY user_id, model, date(created_at, 'localtime')
      `);

      const countAfter = (
        db.prepare('SELECT COUNT(*) as cnt FROM usage_records').get() as {
          cnt: number;
        }
      ).cnt;
      logger.info(
        { countBefore, countAfter },
        'Token usage migration v27→v28 completed',
      );
    })();
  }

  // v29 → v30: Add last_im_jid to agents table (#225)
  if (
    !db
      .prepare("PRAGMA table_info('agents')")
      .all()
      .some((c: any) => c.name === 'last_im_jid')
  ) {
    db.exec('ALTER TABLE agents ADD COLUMN last_im_jid TEXT');
  }

  // v31 → v32: Add spawned_from_jid to agents table (spawn parallel tasks)
  if (
    !db
      .prepare("PRAGMA table_info('agents')")
      .all()
      .some((c: any) => c.name === 'spawned_from_jid')
  ) {
    db.exec('ALTER TABLE agents ADD COLUMN spawned_from_jid TEXT');
  }

  // v36 → v37: Add provider_id to sessions table for sticky provider binding.
  // Prevents "Invalid signature in thinking block" errors when a Claude session
  // resumed across container restarts gets routed to a different OAuth account.
  if (
    !db
      .prepare("PRAGMA table_info('sessions')")
      .all()
      .some((c: any) => c.name === 'provider_id')
  ) {
    db.exec('ALTER TABLE sessions ADD COLUMN provider_id TEXT');
  }

  // v37 → v38: Added users.default_require_mention column (per-user default
  // for require_mention on auto-registered IM group chats). The actual
  // ensureColumn migration runs above with the other users.* additions —
  // its position before assertSchema('users', …) matters because the
  // schema check would otherwise reject pre-v38 databases on startup.

  // v38 → v39: Add issue_events (generalized timeline), issue_comments, and
  // issue_event_notifications tables. Migrate legacy issue_agent_run_events
  // rows into the new issue_events table.
  {
    const hasIssueEvents = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='issue_events'")
      .get();
    if (!hasIssueEvents) {
      db.exec(`
        CREATE TABLE issue_events (
          id TEXT PRIMARY KEY,
          issue_id TEXT NOT NULL,
          run_id TEXT,
          event_type TEXT NOT NULL,
          actor_id TEXT,
          actor_type TEXT NOT NULL DEFAULT 'system',
          title TEXT,
          summary TEXT,
          detail TEXT,
          payload TEXT,
          reference_id TEXT,
          created_at TEXT NOT NULL
        );
        CREATE INDEX idx_issue_events_issue ON issue_events(issue_id, created_at);
        CREATE INDEX idx_issue_events_run ON issue_events(run_id, created_at);
        CREATE INDEX idx_issue_events_type ON issue_events(event_type, created_at);
      `);
    }
    const hasIssueComments = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='issue_comments'")
      .get();
    if (!hasIssueComments) {
      db.exec(`
        CREATE TABLE issue_comments (
          id TEXT PRIMARY KEY,
          issue_id TEXT NOT NULL,
          workspace_jid TEXT NOT NULL,
          body TEXT NOT NULL,
          created_by TEXT,
          source_type TEXT NOT NULL DEFAULT 'user',
          source_meta TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT,
          deleted_at TEXT
        );
        CREATE INDEX idx_issue_comments_issue ON issue_comments(issue_id, created_at);
        CREATE INDEX idx_issue_comments_workspace ON issue_comments(workspace_jid, created_at);
      `);
    }
    const hasIssueEventNotifications = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='issue_event_notifications'")
      .get();
    if (!hasIssueEventNotifications) {
      db.exec(`
        CREATE TABLE issue_event_notifications (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          event_id TEXT NOT NULL,
          channel TEXT NOT NULL,
          target TEXT NOT NULL,
          sent_at TEXT NOT NULL
        );
        CREATE UNIQUE INDEX idx_issue_event_notifications_unique
          ON issue_event_notifications(event_id, channel, target);
      `);
    }

    // Migrate legacy issue_agent_run_events into issue_events if any rows
    // exist and issue_events is empty for those run ids.
    const legacyCount = (db.prepare("SELECT COUNT(*) as c FROM issue_agent_run_events").get() as { c: number }).c;
    const migratedCount = (db.prepare("SELECT COUNT(*) as c FROM issue_events WHERE run_id IS NOT NULL").get() as { c: number }).c;
    if (legacyCount > 0 && migratedCount === 0) {
      const insert = db.prepare(`
        INSERT INTO issue_events
          (id, issue_id, run_id, event_type, actor_id, actor_type, title, summary, detail, payload, reference_id, created_at)
        VALUES
          (@id, @issue_id, @run_id, @event_type, NULL, 'agent', @title, @summary, @detail, @payload, NULL, @created_at)
      `);
      const select = db.prepare("SELECT id, issue_id, run_id, event_type, title, summary, detail, payload, created_at FROM issue_agent_run_events");
      const tx = db.transaction((rows: unknown[]) => {
        for (const row of rows) insert.run(row as any);
      });
      const allRows = select.all();
      if (allRows.length <= 500) {
        tx(allRows);
      } else {
        for (let i = 0; i < allRows.length; i += 500) tx(allRows.slice(i, i + 500));
      }
    }
  }

  // v39 → v40: repo_knowledge_runs 增加 task-agent 所需字段和 timeline 存储
  {
    const ensure = (col: string, decl: string) => {
      const has = db.prepare("PRAGMA table_info('repo_knowledge_runs')").all()
        .some((c: any) => c.name === col);
      if (!has) db.exec(`ALTER TABLE repo_knowledge_runs ADD COLUMN ${col} ${decl}`);
    };
    ensure('agent_client_id', 'TEXT');
    ensure('upload_token_hash', 'TEXT');
    ensure('files_uploaded_at', 'TEXT');
    ensure('enabled_skills_json', "TEXT NOT NULL DEFAULT '[]'");
    ensure('timeline_json', "TEXT NOT NULL DEFAULT '[]'");
  }

  const SCHEMA_VERSION = '40';
  db.prepare(
    'INSERT OR REPLACE INTO router_state (key, value) VALUES (?, ?)',
  ).run('schema_version', SCHEMA_VERSION);
}

async function initializeRemoteBackedDatabase(dbPath: string): Promise<void> {
  const config = getDatabaseBackendConfig();
  const controller = await prepareSqlitePathForBackend(config, dbPath);
  initializeSqliteDatabase(dbPath, controller);
}

export function initDatabase(): void | Promise<void> {
  const dbPath = path.join(STORE_DIR, 'messages.db');
  const config = getDatabaseBackendConfig();

  if (config.backend === 'sqlite') {
    initializeSqliteDatabase(dbPath, new NoopPersistenceController());
    return;
  }

  return initializeRemoteBackedDatabase(dbPath);
}

export function getDatabaseForInternalUse(): InstanceType<typeof Database> {
  if (!db) {
    throw new Error('Database not initialized');
  }
  return db;
}

export async function flushDatabasePersistence(): Promise<void> {
  await persistenceController.flush();
}

export function getMetadataValue(key: string): string | undefined {
  if (!db) return undefined;
  try {
    const row = db
      .prepare('SELECT value FROM metadata_store WHERE key = ?')
      .get(key) as { value: string } | undefined;
    return row?.value;
  } catch {
    return undefined;
  }
}

export function setMetadataValue(key: string, value: string): void {
  if (!db) return;
  db.prepare(
    `INSERT INTO metadata_store (key, value, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       value = excluded.value,
       updated_at = excluded.updated_at`,
  ).run(key, value, new Date().toISOString());
}

export interface DataObjectRecord {
  key: string;
  relativePath: string;
  entryType: 'file' | 'directory';
  contentType?: string | null;
  data?: Buffer | null;
  sizeBytes: number;
  mode?: number | null;
  mtimeMs?: number | null;
  deletedAt?: string | null;
  updatedAt: string;
}

function normalizeDataObjectPath(relativePath: string): string {
  const normalized = path.posix
    .normalize(relativePath.replace(/\\/g, '/'))
    .replace(/^\.\/?/, '')
    .replace(/^\/+/g, '');
  if (!normalized || normalized === '..' || normalized.startsWith('../')) {
    throw new Error(`Invalid data object path: ${relativePath}`);
  }
  if (normalized === 'db' || normalized.startsWith('db/')) {
    throw new Error('data/db is owned by the database backend and cannot be stored as a data object');
  }
  return normalized;
}

function dataObjectKey(relativePath: string): string {
  return `data:${normalizeDataObjectPath(relativePath)}`;
}

function mapDataObjectRow(row: any): DataObjectRecord {
  return {
    key: String(row.key),
    relativePath: String(row.relative_path),
    entryType: row.entry_type === 'directory' ? 'directory' : 'file',
    contentType: row.content_type ?? null,
    data: row.data ? Buffer.from(row.data) : null,
    sizeBytes: Number(row.size_bytes || 0),
    mode: row.mode ?? null,
    mtimeMs: row.mtime_ms ?? null,
    deletedAt: row.deleted_at ?? null,
    updatedAt: String(row.updated_at),
  };
}

export function putDataObject(input: {
  relativePath: string;
  entryType?: 'file' | 'directory';
  contentType?: string | null;
  data?: Buffer | Uint8Array | string | null;
  mode?: number | null;
  mtimeMs?: number | null;
}): void {
  if (!db) throw new Error('Database not initialized');
  const relativePath = normalizeDataObjectPath(input.relativePath);
  const entryType = input.entryType || 'file';
  const data =
    entryType === 'directory'
      ? null
      : input.data == null
        ? Buffer.alloc(0)
        : Buffer.isBuffer(input.data)
          ? input.data
          : typeof input.data === 'string'
            ? Buffer.from(input.data)
            : Buffer.from(input.data);
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO data_objects (
      key, relative_path, entry_type, content_type, data, size_bytes, mode, mtime_ms, deleted_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
    ON CONFLICT(key) DO UPDATE SET
      relative_path = excluded.relative_path,
      entry_type = excluded.entry_type,
      content_type = excluded.content_type,
      data = excluded.data,
      size_bytes = excluded.size_bytes,
      mode = excluded.mode,
      mtime_ms = excluded.mtime_ms,
      deleted_at = NULL,
      updated_at = excluded.updated_at`,
  ).run(
    dataObjectKey(relativePath),
    relativePath,
    entryType,
    input.contentType ?? null,
    data,
    data?.length ?? 0,
    input.mode ?? null,
    input.mtimeMs ?? null,
    now,
  );
}

export function getDataObject(relativePath: string): DataObjectRecord | null {
  if (!db) throw new Error('Database not initialized');
  const row = db
    .prepare(
      'SELECT * FROM data_objects WHERE key = ? AND deleted_at IS NULL LIMIT 1',
    )
    .get(dataObjectKey(relativePath));
  return row ? mapDataObjectRow(row) : null;
}

export function deleteDataObject(relativePath: string): void {
  if (!db) throw new Error('Database not initialized');
  db.prepare(
    'UPDATE data_objects SET deleted_at = ?, updated_at = ? WHERE key = ?',
  ).run(new Date().toISOString(), new Date().toISOString(), dataObjectKey(relativePath));
}

export function listDataObjects(prefix = ''): DataObjectRecord[] {
  if (!db) throw new Error('Database not initialized');
  const normalizedPrefix = prefix ? normalizeDataObjectPath(prefix) : '';
  const rows = normalizedPrefix
    ? db
        .prepare(
          `SELECT * FROM data_objects
           WHERE deleted_at IS NULL AND (relative_path = ? OR relative_path LIKE ?)
           ORDER BY relative_path ASC`,
        )
        .all(normalizedPrefix, `${normalizedPrefix}/%`)
    : db
        .prepare(
          `SELECT * FROM data_objects
           WHERE deleted_at IS NULL
           ORDER BY relative_path ASC`,
        )
        .all();
  return rows.map(mapDataObjectRow);
}

export function importDataFileToDatabase(absPath: string): void {
  const relativePath = path.relative(DATA_DIR, absPath).replace(/\\/g, '/');
  if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) return;
  if (relativePath === 'db' || relativePath.startsWith('db/')) return;
  const stat = fs.statSync(absPath);
  if (stat.isDirectory()) {
    putDataObject({
      relativePath,
      entryType: 'directory',
      mode: stat.mode,
      mtimeMs: stat.mtimeMs,
    });
    return;
  }
  if (!stat.isFile()) return;
  putDataObject({
    relativePath,
    entryType: 'file',
    data: fs.readFileSync(absPath),
    mode: stat.mode,
    mtimeMs: stat.mtimeMs,
  });
}

export function migrateDataDirectoryToDatabase(): { files: number; directories: number } {
  if (!db) throw new Error('Database not initialized');
  if (!fs.existsSync(DATA_DIR)) return { files: 0, directories: 0 };
  let files = 0;
  let directories = 0;

  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (dir === DATA_DIR && entry.name === 'db') continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        importDataFileToDatabase(abs);
        directories += 1;
        walk(abs);
      } else if (entry.isFile()) {
        importDataFileToDatabase(abs);
        files += 1;
      }
    }
  };
  walk(DATA_DIR);
  setMetadataValue('data_objects:last_import_at', new Date().toISOString());
  return { files, directories };
}

export interface AgentTeamRunRecord {
  id: string;
  teamId: string;
  userId: string;
  prompt: string;
  status:
    | 'running'
    | 'waiting_approval'
    | 'paused'
    | 'success'
    | 'error'
    | 'cancelled';
  traceId: string;
  workflowShape: string;
  roleAssignments?: unknown;
  finalResult?: string;
  error?: string;
  createdAt?: string;
  startedAt?: string;
  completedAt?: string;
  updatedAt?: string;
}

export interface AgentTeamTaskRecord {
  id: string;
  runId: string;
  roleId?: string;
  phase?: string;
  actorId?: string;
  status: 'running' | 'success' | 'error' | 'skipped' | 'cancelled';
  attempt?: number;
  input?: string;
  output?: string;
  error?: string;
  startedAt?: string;
  completedAt?: string;
  updatedAt?: string;
}

export interface AgentTeamTraceEventRecord {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  sessionId?: string;
  runId: string;
  taskId?: string;
  actor: string;
  type: string;
  payload: unknown;
  timestamp: string;
  schemaVersion: number;
}

export interface AgentTeamBlackboardRecord {
  id: string;
  runId: string;
  taskId?: string;
  roleId?: string;
  kind:
    | 'input'
    | 'role_output'
    | 'artifact'
    | 'route_decision'
    | 'verifier_report'
    | 'approval_note'
    | 'checkpoint';
  key: string;
  contentType: string;
  value: string;
  visibility?: 'run' | 'role' | 'system';
  createdAt?: string;
}

export interface AgentTeamArtifactRecord {
  id: string;
  runId: string;
  key: string;
  version: number;
  contentType: string;
  value: string;
  sourceStepId?: string;
  sourceTaskId?: string;
  sourceRoleId?: string;
  confidence?: number;
  visibility?: 'run' | 'role' | 'system';
  parentArtifactIds?: string[];
  createdAt?: string;
}

export interface AgentTeamRunView {
  id: string;
  teamId: string;
  userId: string;
  prompt: string;
  status: string;
  traceId: string;
  workflowShape: string;
  roleAssignments: unknown;
  finalResult?: string;
  error?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  updatedAt: string;
}

export interface AgentTeamCheckpointRecord {
  id: string;
  runId: string;
  taskId?: string;
  nodeId: string;
  state: unknown;
  blackboardCursor?: number;
  createdAt?: string;
}

export interface AgentTeamApprovalRecord {
  id: string;
  runId: string;
  taskId?: string;
  requestedBy: string;
  status: 'pending' | 'approved' | 'rejected';
  riskLevel: string;
  title: string;
  description: string;
  payload: unknown;
  resolvedBy?: string;
  resolvedAt?: string;
  createdAt?: string;
}

export function recordAgentTeamRun(record: AgentTeamRunRecord): void {
  if (!db) return;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO agent_team_runs (
      id, team_id, user_id, prompt, status, trace_id, workflow_shape, role_assignments,
      final_result, error, created_at, started_at, completed_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      status = excluded.status,
      role_assignments = excluded.role_assignments,
      final_result = excluded.final_result,
      error = excluded.error,
      completed_at = excluded.completed_at,
      updated_at = excluded.updated_at`,
  ).run(
    record.id,
    record.teamId,
    record.userId,
    record.prompt,
    record.status,
    record.traceId,
    record.workflowShape,
    JSON.stringify(record.roleAssignments ?? {}),
    record.finalResult ?? null,
    record.error ?? null,
    record.createdAt ?? now,
    record.startedAt ?? now,
    record.completedAt ?? null,
    record.updatedAt ?? now,
  );
}

export function recordAgentTeamTask(record: AgentTeamTaskRecord): void {
  if (!db) return;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO agent_team_tasks (
      id, run_id, role_id, phase, actor_id, status, attempt, input, output, error,
      started_at, completed_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      actor_id = excluded.actor_id,
      status = excluded.status,
      output = excluded.output,
      error = excluded.error,
      completed_at = excluded.completed_at,
      updated_at = excluded.updated_at`,
  ).run(
    record.id,
    record.runId,
    record.roleId ?? null,
    record.phase ?? null,
    record.actorId ?? null,
    record.status,
    record.attempt ?? 1,
    record.input ?? null,
    record.output ?? null,
    record.error ?? null,
    record.startedAt ?? now,
    record.completedAt ?? null,
    record.updatedAt ?? now,
  );
}

export function recordAgentTeamTraceEvent(
  event: AgentTeamTraceEventRecord,
): void {
  if (!db) return;
  db.prepare(
    `INSERT INTO agent_team_events (
      trace_id, span_id, parent_span_id, session_id, run_id, task_id, actor, type,
      payload, timestamp, schema_version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    event.traceId,
    event.spanId,
    event.parentSpanId ?? null,
    event.sessionId ?? null,
    event.runId,
    event.taskId ?? null,
    event.actor,
    event.type,
    JSON.stringify(event.payload ?? null),
    event.timestamp,
    event.schemaVersion,
  );
}

export function recordAgentTeamBlackboard(
  record: AgentTeamBlackboardRecord,
): void {
  if (!db) return;
  db.prepare(
    `INSERT INTO agent_team_blackboard (
      id, run_id, task_id, role_id, kind, key, content_type, value, visibility, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      value = excluded.value,
      visibility = excluded.visibility,
      created_at = excluded.created_at`,
  ).run(
    record.id,
    record.runId,
    record.taskId ?? null,
    record.roleId ?? null,
    record.kind,
    record.key,
    record.contentType,
    record.value,
    record.visibility ?? 'run',
    record.createdAt ?? new Date().toISOString(),
  );
}

export function recordAgentTeamArtifact(record: AgentTeamArtifactRecord): void {
  if (!db) return;
  const createdAt = record.createdAt ?? new Date().toISOString();
  db.prepare(
    `INSERT INTO agent_team_artifacts (
      id, run_id, key, version, content_type, value, source_step_id, source_task_id,
      source_role_id, confidence, visibility, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      key = excluded.key,
      version = excluded.version,
      content_type = excluded.content_type,
      value = excluded.value,
      source_step_id = excluded.source_step_id,
      source_task_id = excluded.source_task_id,
      source_role_id = excluded.source_role_id,
      confidence = excluded.confidence,
      visibility = excluded.visibility,
      created_at = excluded.created_at`,
  ).run(
    record.id,
    record.runId,
    record.key,
    record.version,
    record.contentType,
    record.value,
    record.sourceStepId ?? null,
    record.sourceTaskId ?? null,
    record.sourceRoleId ?? null,
    record.confidence ?? null,
    record.visibility ?? 'run',
    createdAt,
  );
  db.prepare('DELETE FROM agent_team_artifact_edges WHERE child_artifact_id = ?').run(
    record.id,
  );
  const insertEdge = db.prepare(
    `INSERT OR REPLACE INTO agent_team_artifact_edges (
      parent_artifact_id, child_artifact_id, relationship, created_at
    ) VALUES (?, ?, ?, ?)`,
  );
  for (const parentArtifactId of record.parentArtifactIds ?? []) {
    insertEdge.run(parentArtifactId, record.id, 'derived_from', createdAt);
  }
}

export function recordAgentTeamCheckpoint(
  record: AgentTeamCheckpointRecord,
): void {
  if (!db) return;
  db.prepare(
    `INSERT INTO agent_team_checkpoints (id, run_id, task_id, node_id, state, blackboard_cursor, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET state = excluded.state, blackboard_cursor = excluded.blackboard_cursor`,
  ).run(
    record.id,
    record.runId,
    record.taskId ?? null,
    record.nodeId,
    JSON.stringify(record.state ?? null),
    record.blackboardCursor ?? null,
    record.createdAt ?? new Date().toISOString(),
  );
}

export function recordAgentTeamApproval(record: AgentTeamApprovalRecord): void {
  if (!db) return;
  db.prepare(
    `INSERT INTO agent_team_approvals (
      id, run_id, task_id, requested_by, status, risk_level, title, description, payload, resolved_by, resolved_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      status = excluded.status,
      resolved_by = excluded.resolved_by,
      resolved_at = excluded.resolved_at`,
  ).run(
    record.id,
    record.runId,
    record.taskId ?? null,
    record.requestedBy,
    record.status,
    record.riskLevel,
    record.title,
    record.description,
    JSON.stringify(record.payload ?? null),
    record.resolvedBy ?? null,
    record.resolvedAt ?? null,
    record.createdAt ?? new Date().toISOString(),
  );
}

export function getAgentTeamRun(
  id: string,
  userId?: string,
): AgentTeamRunView | null {
  if (!db) return null;
  const row = db
    .prepare(
      `SELECT id, team_id, user_id, prompt, status, trace_id, workflow_shape, role_assignments,
      final_result, error, created_at, started_at, completed_at, updated_at
     FROM agent_team_runs WHERE id = ? ${userId ? 'AND user_id = ?' : ''}`,
    )
    .get(...(userId ? [id, userId] : [id])) as any;
  if (!row) return null;
  return {
    id: row.id,
    teamId: row.team_id,
    userId: row.user_id,
    prompt: row.prompt,
    status: row.status,
    traceId: row.trace_id,
    workflowShape: row.workflow_shape,
    roleAssignments: JSON.parse(row.role_assignments || '{}'),
    finalResult: row.final_result ?? undefined,
    error: row.error ?? undefined,
    createdAt: row.created_at,
    startedAt: row.started_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
    updatedAt: row.updated_at,
  };
}

export function listAgentTeamRuns(options: {
  userId: string;
  teamId?: string;
  status?: string;
  limit?: number;
}): AgentTeamRunView[] {
  if (!db) return [];
  const clauses = ['user_id = ?'];
  const params: unknown[] = [options.userId];
  if (options.teamId) {
    clauses.push('team_id = ?');
    params.push(options.teamId);
  }
  if (options.status) {
    clauses.push('status = ?');
    params.push(options.status);
  }
  const limit = Math.max(1, Math.min(100, Math.trunc(options.limit ?? 50)));
  params.push(limit);
  const rows = db
    .prepare(
      `SELECT id, team_id, user_id, prompt, status, trace_id, workflow_shape, role_assignments,
      final_result, error, created_at, started_at, completed_at, updated_at
     FROM agent_team_runs
     WHERE ${clauses.join(' AND ')}
     ORDER BY created_at DESC, rowid DESC
     LIMIT ?`,
    )
    .all(...params) as any[];
  return rows.map((row) => ({
    id: row.id,
    teamId: row.team_id,
    userId: row.user_id,
    prompt: row.prompt,
    status: row.status,
    traceId: row.trace_id,
    workflowShape: row.workflow_shape,
    roleAssignments: JSON.parse(row.role_assignments || '{}'),
    finalResult: row.final_result ?? undefined,
    error: row.error ?? undefined,
    createdAt: row.created_at,
    startedAt: row.started_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
    updatedAt: row.updated_at,
  }));
}

export function listAgentTeamRunsForMetrics(options: {
  userId: string;
  teamId?: string;
  since?: string;
  until?: string;
  limit?: number;
}): {
  runs: AgentTeamRunView[];
  tasks: Array<Record<string, unknown>>;
  approvals: Array<Record<string, unknown>>;
} {
  const clauses = ['user_id = ?'];
  const params: unknown[] = [options.userId];
  if (options.teamId) {
    clauses.push('team_id = ?');
    params.push(options.teamId);
  }
  if (options.since) {
    clauses.push('created_at >= ?');
    params.push(options.since);
  }
  if (options.until) {
    clauses.push('created_at <= ?');
    params.push(options.until);
  }
  const limit = Math.max(1, Math.min(500, Math.trunc(options.limit ?? 100)));
  params.push(limit);

  const rows = db
    .prepare(
      `SELECT id, team_id, user_id, prompt, status, trace_id, workflow_shape, role_assignments,
      final_result, error, created_at, started_at, completed_at, updated_at
     FROM agent_team_runs
     WHERE ${clauses.join(' AND ')}
     ORDER BY created_at DESC, rowid DESC
     LIMIT ?`,
    )
    .all(...params) as any[];
  const runs = rows.map((row) => ({
    id: row.id,
    teamId: row.team_id,
    userId: row.user_id,
    prompt: row.prompt,
    status: row.status,
    traceId: row.trace_id,
    workflowShape: row.workflow_shape,
    roleAssignments: JSON.parse(row.role_assignments || '{}'),
    finalResult: row.final_result ?? undefined,
    error: row.error ?? undefined,
    createdAt: row.created_at,
    startedAt: row.started_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
    updatedAt: row.updated_at,
  }));
  if (runs.length === 0) return { runs, tasks: [], approvals: [] };

  const placeholders = runs.map(() => '?').join(',');
  const runIds = runs.map((run) => run.id);
  const tasks = db
    .prepare(
      `SELECT id, run_id AS runId, role_id AS roleId, phase, actor_id AS actorId, status, attempt, input, output, error,
      started_at AS startedAt, completed_at AS completedAt, updated_at AS updatedAt
     FROM agent_team_tasks WHERE run_id IN (${placeholders}) ORDER BY started_at, id`,
    )
    .all(...runIds) as Array<Record<string, unknown>>;
  const approvals = (
    db
      .prepare(
        `SELECT id, run_id AS runId, task_id AS taskId, requested_by AS requestedBy, status, risk_level AS riskLevel,
      title, description, payload, resolved_by AS resolvedBy, resolved_at AS resolvedAt, created_at AS createdAt
     FROM agent_team_approvals WHERE run_id IN (${placeholders}) ORDER BY created_at, id`,
      )
      .all(...runIds) as Array<Record<string, unknown>>
  ).map((row) => ({
    ...row,
    payload: JSON.parse(String(row.payload ?? 'null')),
  }));

  return { runs, tasks, approvals };
}

export function listAgentTeamTasks(
  runId: string,
): Array<Record<string, unknown>> {
  if (!db) return [];
  return db
    .prepare(
      `SELECT id, run_id AS runId, role_id AS roleId, phase, actor_id AS actorId, status, attempt, input, output, error,
      started_at AS startedAt, completed_at AS completedAt, updated_at AS updatedAt
     FROM agent_team_tasks WHERE run_id = ? ORDER BY started_at, id`,
    )
    .all(runId) as Array<Record<string, unknown>>;
}

export function listAgentTeamTraceEvents(
  runId: string,
): Array<Record<string, unknown>> {
  if (!db) return [];
  return (
    db
      .prepare(
        `SELECT trace_id AS traceId, span_id AS spanId, parent_span_id AS parentSpanId, session_id AS sessionId,
      run_id AS runId, task_id AS taskId, actor, type, payload, timestamp, schema_version AS schemaVersion
     FROM agent_team_events WHERE run_id = ? ORDER BY id`,
      )
      .all(runId) as Array<Record<string, unknown>>
  ).map((row) => ({
    ...row,
    payload: JSON.parse(String(row.payload ?? 'null')),
  }));
}

export function listAgentTeamBlackboard(
  runId: string,
): Array<Record<string, unknown>> {
  if (!db) return [];
  return db
    .prepare(
      `SELECT id, run_id AS runId, task_id AS taskId, role_id AS roleId, kind, key, content_type AS contentType,
      value, visibility, created_at AS createdAt
     FROM agent_team_blackboard WHERE run_id = ? ORDER BY created_at, id`,
    )
    .all(runId) as Array<Record<string, unknown>>;
}

function artifactFromRow(row: Record<string, unknown>): AgentTeamArtifactRecord {
  const parentRows = db
    ?.prepare(
      `SELECT parent_artifact_id AS parentArtifactId
       FROM agent_team_artifact_edges
       WHERE child_artifact_id = ?
       ORDER BY created_at, parent_artifact_id`,
    )
    .all(row.id) as Array<{ parentArtifactId: string }> | undefined;
  return {
    id: String(row.id),
    runId: String(row.runId),
    key: String(row.key),
    version: Number(row.version),
    contentType: String(row.contentType),
    value: String(row.value),
    sourceStepId:
      typeof row.sourceStepId === 'string' ? row.sourceStepId : undefined,
    sourceTaskId:
      typeof row.sourceTaskId === 'string' ? row.sourceTaskId : undefined,
    sourceRoleId:
      typeof row.sourceRoleId === 'string' ? row.sourceRoleId : undefined,
    confidence:
      typeof row.confidence === 'number' ? row.confidence : undefined,
    visibility:
      row.visibility === 'role' || row.visibility === 'system'
        ? row.visibility
        : 'run',
    parentArtifactIds:
      parentRows?.map((parent) => parent.parentArtifactId) ?? [],
    createdAt: String(row.createdAt),
  };
}

export function listAgentTeamArtifacts(
  runId: string,
): AgentTeamArtifactRecord[] {
  if (!db) return [];
  const rows = db
    .prepare(
      `SELECT id, run_id AS runId, key, version, content_type AS contentType,
      value, source_step_id AS sourceStepId, source_task_id AS sourceTaskId,
      source_role_id AS sourceRoleId, confidence, visibility, created_at AS createdAt
     FROM agent_team_artifacts WHERE run_id = ? ORDER BY created_at, id`,
    )
    .all(runId) as Array<Record<string, unknown>>;
  return rows.map(artifactFromRow);
}

export function getAgentTeamArtifact(
  id: string,
  runId: string,
): AgentTeamArtifactRecord | null {
  if (!db) return null;
  const row = db
    .prepare(
      `SELECT id, run_id AS runId, key, version, content_type AS contentType,
      value, source_step_id AS sourceStepId, source_task_id AS sourceTaskId,
      source_role_id AS sourceRoleId, confidence, visibility, created_at AS createdAt
     FROM agent_team_artifacts WHERE id = ? AND run_id = ?`,
    )
    .get(id, runId) as Record<string, unknown> | undefined;
  return row ? artifactFromRow(row) : null;
}

export function getAgentTeamApproval(
  id: string,
  runId: string,
): Record<string, unknown> | null {
  if (!db) return null;
  const row = db
    .prepare(
      `SELECT id, run_id AS runId, task_id AS taskId, requested_by AS requestedBy, status, risk_level AS riskLevel,
      title, description, payload, resolved_by AS resolvedBy, resolved_at AS resolvedAt, created_at AS createdAt
     FROM agent_team_approvals WHERE id = ? AND run_id = ?`,
    )
    .get(id, runId) as Record<string, unknown> | undefined;
  return row
    ? { ...row, payload: JSON.parse(String(row.payload ?? 'null')) }
    : null;
}

export function listAgentTeamApprovals(
  runId: string,
): Array<Record<string, unknown>> {
  if (!db) return [];
  return (
    db
      .prepare(
        `SELECT id, run_id AS runId, task_id AS taskId, requested_by AS requestedBy, status, risk_level AS riskLevel,
      title, description, payload, resolved_by AS resolvedBy, resolved_at AS resolvedAt, created_at AS createdAt
     FROM agent_team_approvals WHERE run_id = ? ORDER BY created_at, id`,
      )
      .all(runId) as Array<Record<string, unknown>>
  ).map((row) => ({
    ...row,
    payload: JSON.parse(String(row.payload ?? 'null')),
  }));
}

export function listAgentTeamCheckpoints(
  runId: string,
): Array<Record<string, unknown>> {
  if (!db) return [];
  return (
    db
      .prepare(
        `SELECT id, run_id AS runId, task_id AS taskId, node_id AS nodeId, state, blackboard_cursor AS blackboardCursor, created_at AS createdAt
     FROM agent_team_checkpoints WHERE run_id = ? ORDER BY created_at, id`,
      )
      .all(runId) as Array<Record<string, unknown>>
  ).map((row) => ({ ...row, state: JSON.parse(String(row.state ?? 'null')) }));
}

/**
 * Store chat metadata only (no message content).
 * Used for all chats to enable group discovery without storing sensitive content.
 */
export function storeChatMetadata(
  chatJid: string,
  timestamp: string,
  name?: string,
): void {
  if (name) {
    // Update with name, preserving existing timestamp if newer
    db.prepare(
      `
      INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        name = excluded.name,
        last_message_time = MAX(last_message_time, excluded.last_message_time),
        archived_at = NULL,
        archive_reason = NULL
    `,
    ).run(chatJid, name, timestamp);
  } else {
    // Update timestamp only, preserve existing name if any
    db.prepare(
      `
      INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        last_message_time = MAX(last_message_time, excluded.last_message_time),
        archived_at = NULL,
        archive_reason = NULL
    `,
    ).run(chatJid, chatJid, timestamp);
  }
}

/**
 * Update chat name without changing timestamp for existing chats.
 * New chats get the current time as their initial timestamp.
 * Used during group metadata sync.
 */
export function updateChatName(chatJid: string, name: string): void {
  db.prepare(
    `
    INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)
    ON CONFLICT(jid) DO UPDATE SET name = excluded.name
  `,
  ).run(chatJid, name, new Date().toISOString());
}

export interface ChatInfo {
  jid: string;
  name: string;
  last_message_time: string;
}

/**
 * Get all known chats, ordered by most recent activity.
 */
export function getAllChats(): ChatInfo[] {
  return db
    .prepare(
      `
    SELECT jid, name, last_message_time
    FROM chats
    WHERE archived_at IS NULL
    ORDER BY last_message_time DESC
  `,
    )
    .all() as ChatInfo[];
}

/**
 * Get timestamp of last group metadata sync.
 */
export function getLastGroupSync(): string | null {
  // Store sync time in a special chat entry
  const row = db
    .prepare(`SELECT last_message_time FROM chats WHERE jid = '__group_sync__'`)
    .get() as { last_message_time: string } | undefined;
  return row?.last_message_time || null;
}

/**
 * Record that group metadata was synced.
 */
export function setLastGroupSync(): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR REPLACE INTO chats (jid, name, last_message_time) VALUES ('__group_sync__', '__group_sync__', ?)`,
  ).run(now);
}

/**
 * Coerce a value flowing through a TEXT-affinity column into a JS string.
 *
 * SQLite is dynamically typed: a TEXT column will silently accept a
 * Buffer/Uint8Array binding and store it as BLOB. better-sqlite3 reads such
 * cells back as Buffer, which propagates through JSON.stringify as
 * `{type:"Buffer",data:[…]}` and breaks any consumer expecting a string.
 *
 * Wraps both write paths (where `warnField` surfaces the offending caller)
 * and read paths (no `warnField`, silent normalization of legacy bad data).
 */
function toUtf8String(value: unknown, warnField?: string): string {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    const decoded = Buffer.from(value as Uint8Array).toString('utf8');
    if (warnField) {
      logger.warn(
        {
          field: warnField,
          byteLen: (value as Uint8Array).byteLength,
          sample: decoded.slice(0, 80),
        },
        'toUtf8String: Buffer on TEXT column, decoded as UTF-8',
      );
    }
    return decoded;
  }
  const coerced = String(value);
  if (warnField) {
    logger.warn(
      { field: warnField, jsType: typeof value, sample: coerced.slice(0, 80) },
      'toUtf8String: non-string on TEXT column, coerced via String()',
    );
  }
  return coerced;
}

/** Variant that preserves null (vs the default '' fallback). */
function toUtf8StringOrNull(value: unknown): string | null {
  return value == null ? null : toUtf8String(value);
}

/** Normalize a raw message row from sqlite: decode content + boolify is_from_me.
 *  The is_from_me overload must come first — TS overload resolution stops at
 *  the first match and `NewMessage & { is_from_me: number }` is a subtype of
 *  `NewMessage`. */
function normalizeMessageRow(
  row: NewMessage & { is_from_me: number },
): NewMessage & { is_from_me: boolean };
function normalizeMessageRow(row: NewMessage): NewMessage;
function normalizeMessageRow(
  row: NewMessage & { is_from_me?: number },
): NewMessage & { is_from_me?: boolean } {
  const { is_from_me, content, ...rest } = row;
  const out: NewMessage & { is_from_me?: boolean } = {
    ...rest,
    content: toUtf8String(content),
  };
  if (typeof is_from_me === 'number') {
    out.is_from_me = is_from_me === 1;
  }
  if (!out.role) {
    out.role = out.is_from_me ? 'assistant' : 'user';
  }
  return out;
}

/**
 * Ensure a chat row exists in the chats table (avoids FK violation on messages insert).
 */
export function ensureChatExists(chatJid: string): void {
  db.prepare(
    `INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)
     ON CONFLICT(jid) DO UPDATE SET
       last_message_time = MAX(last_message_time, excluded.last_message_time),
       archived_at = NULL,
       archive_reason = NULL`,
  ).run(chatJid, chatJid, new Date().toISOString());
}

/**
 * Store a message with full content (channel-agnostic).
 * Only call this for registered groups where message history is needed.
 */
export function storeMessageDirect(
  msgId: string,
  chatJid: string,
  sender: string,
  senderName: string,
  content: string,
  timestamp: string,
  isFromMe: boolean,
  opts?: {
    attachments?: string;
    tokenUsage?: string;
    sourceJid?: string;
    meta?: StoredMessageMeta;
  },
): string {
  const { attachments, tokenUsage, sourceJid, meta } = opts ?? {};
  const existingFinalRow =
    meta?.sourceKind === 'sdk_final' && meta.turnId
      ? (stmts().storeMessageSelect.get(chatJid, meta.turnId) as
          | { id: string }
          | undefined)
      : undefined;
  const effectiveMsgId = existingFinalRow?.id || msgId;
  stmts().storeMessageInsert.run(
    effectiveMsgId,
    chatJid,
    sourceJid ?? chatJid,
    sender,
    senderName,
    meta?.role ?? (isFromMe ? 'assistant' : 'user'),
    toUtf8String(content, 'messages.content'),
    timestamp,
    isFromMe ? 1 : 0,
    attachments ?? null,
    tokenUsage ?? null,
    meta?.turnId ?? null,
    meta?.sessionId ?? null,
    meta?.sdkMessageUuid ?? null,
    meta?.sourceKind ?? null,
    meta?.finalizationReason ?? null,
    meta?.taskId ?? null,
  );
  return effectiveMsgId;
}

/**
 * Overwrite the `attachments` JSON column for a single message row.
 *
 * Used by the plugin-command expander to persist the expanded-prompt
 * sentinel after inline `!` commands run successfully (P1 round-14
 * crash-safety): the next recovery pass reads the sentinel and reuses
 * the stored prompt instead of re-executing inline.
 */
export function updateMessageAttachments(
  chatJid: string,
  msgId: string,
  attachmentsJson: string,
): void {
  db.prepare(
    `UPDATE messages SET attachments = ? WHERE id = ? AND chat_jid = ?`,
  ).run(attachmentsJson, msgId, chatJid);
}

/**
 * Read the `attachments` JSON column for a single message row, or null
 * if the row is missing (caller treats null as "no persisted state").
 */
export function getMessageAttachments(
  chatJid: string,
  msgId: string,
): string | null {
  const row = db
    .prepare(
      `SELECT attachments FROM messages WHERE id = ? AND chat_jid = ? LIMIT 1`,
    )
    .get(msgId, chatJid) as { attachments: string | null } | undefined;
  if (!row) return null;
  return row.attachments ?? null;
}

/**
 * Update the token_usage field on a specific agent message, or fall back to
 * the most recent agent message without token_usage for the given chat.
 * When msgId is provided, uses precise `WHERE id = ? AND chat_jid = ?` match
 * to avoid race conditions in concurrent scenarios.
 */
export function updateLatestMessageTokenUsage(
  chatJid: string,
  tokenUsage: string,
  msgId?: string,
  costUsd?: number,
): void {
  if (msgId) {
    stmts().updateTokenUsageById.run(
      tokenUsage,
      costUsd ?? null,
      msgId,
      chatJid,
    );
  } else {
    stmts().updateTokenUsageLatest.run(tokenUsage, costUsd ?? null, chatJid);
  }
}

/**
 * Get token usage statistics aggregated by date.
 */
export function getTokenUsageStats(
  days: number,
  chatJids?: string[],
): Array<{
  date: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  cost_usd: number;
  message_count: number;
}> {
  const since = new Date();
  since.setDate(since.getDate() - days);
  const sinceStr = since.toISOString();

  const jidFilter =
    chatJids && chatJids.length > 0
      ? `AND m.chat_jid IN (${chatJids.map(() => '?').join(',')})`
      : '';
  const params: unknown[] = [sinceStr, ...(chatJids || [])];

  const baseQuery = `
    SELECT
      date(m.timestamp) as date,
      json_extract(m.token_usage, '$.modelUsage') as model_usage_json,
      json_extract(m.token_usage, '$.inputTokens') as input_tokens,
      json_extract(m.token_usage, '$.outputTokens') as output_tokens,
      json_extract(m.token_usage, '$.cacheReadInputTokens') as cache_read_tokens,
      json_extract(m.token_usage, '$.cacheCreationInputTokens') as cache_creation_tokens,
      json_extract(m.token_usage, '$.costUSD') as cost_usd
    FROM messages m
    WHERE m.token_usage IS NOT NULL
      AND m.timestamp >= ?
      ${jidFilter}
    ORDER BY m.timestamp ASC
  `;

  const rows = db.prepare(baseQuery).all(...params) as Array<{
    date: string;
    model_usage_json: string | null;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_creation_tokens: number;
    cost_usd: number;
  }>;

  // Aggregate by date + model
  type AggregatedEntry = {
    date: string;
    model: string;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_creation_tokens: number;
    cost_usd: number;
    message_count: number;
  };
  const aggregated = new Map<string, AggregatedEntry>();

  function addToAggregated(
    date: string,
    model: string,
    inputTokens: number,
    outputTokens: number,
    cacheReadTokens: number,
    cacheCreationTokens: number,
    costUsd: number,
  ): void {
    const key = `${date}|${model}`;
    const existing = aggregated.get(key);
    if (existing) {
      existing.input_tokens += inputTokens;
      existing.output_tokens += outputTokens;
      existing.cache_read_tokens += cacheReadTokens;
      existing.cache_creation_tokens += cacheCreationTokens;
      existing.cost_usd += costUsd;
      existing.message_count += 1;
    } else {
      aggregated.set(key, {
        date,
        model,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cache_read_tokens: cacheReadTokens,
        cache_creation_tokens: cacheCreationTokens,
        cost_usd: costUsd,
        message_count: 1,
      });
    }
  }

  for (const row of rows) {
    if (row.model_usage_json) {
      try {
        const modelUsage = JSON.parse(row.model_usage_json) as Record<
          string,
          { inputTokens: number; outputTokens: number; costUSD: number }
        >;
        for (const [model, usage] of Object.entries(modelUsage)) {
          addToAggregated(
            row.date,
            model,
            usage.inputTokens || 0,
            usage.outputTokens || 0,
            0,
            0,
            usage.costUSD || 0,
          );
        }
      } catch (e) {
        logger.warn(
          { date: row.date, error: e },
          'Failed to parse model_usage_json',
        );
        // fallback: use aggregate fields
        addToAggregated(
          row.date,
          'unknown',
          row.input_tokens || 0,
          row.output_tokens || 0,
          row.cache_read_tokens || 0,
          row.cache_creation_tokens || 0,
          row.cost_usd || 0,
        );
      }
    } else {
      addToAggregated(
        row.date,
        'unknown',
        row.input_tokens || 0,
        row.output_tokens || 0,
        row.cache_read_tokens || 0,
        row.cache_creation_tokens || 0,
        row.cost_usd || 0,
      );
    }
  }

  return Array.from(aggregated.values());
}

/**
 * Get token usage summary totals.
 */
export function getTokenUsageSummary(
  days: number,
  chatJids?: string[],
): {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheCreationTokens: number;
  totalCostUSD: number;
  totalMessages: number;
  totalActiveDays: number;
} {
  const since = new Date();
  since.setDate(since.getDate() - days);
  const sinceStr = since.toISOString();

  const jidFilter =
    chatJids && chatJids.length > 0
      ? `AND chat_jid IN (${chatJids.map(() => '?').join(',')})`
      : '';
  const params: unknown[] = [sinceStr, ...(chatJids || [])];

  const row = db
    .prepare(
      `
    SELECT
      COALESCE(SUM(json_extract(token_usage, '$.inputTokens')), 0) as total_input,
      COALESCE(SUM(json_extract(token_usage, '$.outputTokens')), 0) as total_output,
      COALESCE(SUM(json_extract(token_usage, '$.cacheReadInputTokens')), 0) as total_cache_read,
      COALESCE(SUM(json_extract(token_usage, '$.cacheCreationInputTokens')), 0) as total_cache_creation,
      COALESCE(SUM(json_extract(token_usage, '$.costUSD')), 0) as total_cost,
      COUNT(*) as total_messages,
      COUNT(DISTINCT date(timestamp)) as total_active_days
    FROM messages
    WHERE token_usage IS NOT NULL AND timestamp >= ?
      ${jidFilter}
  `,
    )
    .get(...params) as {
    total_input: number;
    total_output: number;
    total_cache_read: number;
    total_cache_creation: number;
    total_cost: number;
    total_messages: number;
    total_active_days: number;
  };

  return {
    totalInputTokens: row.total_input,
    totalOutputTokens: row.total_output,
    totalCacheReadTokens: row.total_cache_read,
    totalCacheCreationTokens: row.total_cache_creation,
    totalCostUSD: row.total_cost,
    totalMessages: row.total_messages,
    totalActiveDays: row.total_active_days,
  };
}

/**
 * Get a local timezone date string (YYYY-MM-DD) from a Date or ISO string.
 */
function toLocalDateString(date?: Date | string): string {
  const d = date ? new Date(date) : new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Insert a usage record and update daily summary.
 */
export function insertUsageRecord(record: {
  userId: string;
  groupFolder: string;
  agentId?: string | null;
  messageId?: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  costUSD: number;
  durationMs?: number;
  numTurns?: number;
  source?: string;
}): void {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const localDate = toLocalDateString();

  db.transaction(() => {
    stmts().insertUsageInsert.run(
      id,
      record.userId,
      record.groupFolder,
      record.agentId ?? null,
      record.messageId ?? null,
      record.model,
      record.inputTokens,
      record.outputTokens,
      record.cacheReadInputTokens,
      record.cacheCreationInputTokens,
      record.costUSD,
      record.durationMs ?? 0,
      record.numTurns ?? 0,
      record.source ?? 'agent',
      now,
    );
    stmts().insertUsageUpsert.run(
      record.userId,
      record.model,
      localDate,
      record.inputTokens,
      record.outputTokens,
      record.cacheReadInputTokens,
      record.cacheCreationInputTokens,
      record.costUSD,
    );
  })();
}

/**
 * Repair usage records that were written without a real owner (historically
 * possible for Device/Daemon agent runs when the effective group did not carry
 * created_by). Rebuild the daily summary from usage_records so /api/usage
 * immediately reflects the corrected owner mapping.
 */
export function repairSystemUsageRecordOwners(): number {
  return db.transaction(() => {
    const result = db
      .prepare(
        `
        UPDATE usage_records
        SET user_id = (
          SELECT rg.created_by
          FROM registered_groups rg
          WHERE rg.created_by IS NOT NULL
            AND (rg.folder = usage_records.group_folder OR rg.jid = usage_records.group_folder)
          ORDER BY CASE WHEN rg.folder = usage_records.group_folder THEN 0 ELSE 1 END
          LIMIT 1
        )
        WHERE (user_id IS NULL OR user_id = '' OR user_id = 'system')
          AND EXISTS (
            SELECT 1
            FROM registered_groups rg
            WHERE rg.created_by IS NOT NULL
              AND (rg.folder = usage_records.group_folder OR rg.jid = usage_records.group_folder)
          )
        `,
      )
      .run();

    if ((result.changes ?? 0) > 0) {
      db.exec(`
        DELETE FROM usage_daily_summary;
        INSERT INTO usage_daily_summary (user_id, model, date,
          total_input_tokens, total_output_tokens,
          total_cache_read_tokens, total_cache_creation_tokens,
          total_cost_usd, request_count, updated_at)
        SELECT
          user_id,
          model,
          date(created_at, 'localtime'),
          SUM(input_tokens), SUM(output_tokens),
          SUM(cache_read_input_tokens), SUM(cache_creation_input_tokens),
          SUM(cost_usd), COUNT(*), datetime('now')
        FROM usage_records
        GROUP BY user_id, model, date(created_at, 'localtime')
      `);
    }

    return result.changes ?? 0;
  })();
}

/**
 * Get usage stats from daily summary table (fixes timezone + token KPI issues).
 */
export function getUsageDailyStats(
  days: number,
  userId?: string,
  modelFilter?: string,
): Array<{
  date: string;
  model: string;
  user_id: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  cost_usd: number;
  request_count: number;
}> {
  const sinceDate = toLocalDateString(new Date(Date.now() - days * 86400000));
  const conditions: string[] = ['date >= ?'];
  const params: unknown[] = [sinceDate];

  if (userId) {
    conditions.push('user_id = ?');
    params.push(userId);
  }
  if (modelFilter) {
    conditions.push('model = ?');
    params.push(modelFilter);
  }

  const whereClause = conditions.join(' AND ');
  return db
    .prepare(
      `
    SELECT date, model, user_id,
      total_input_tokens as input_tokens,
      total_output_tokens as output_tokens,
      total_cache_read_tokens as cache_read_tokens,
      total_cache_creation_tokens as cache_creation_tokens,
      total_cost_usd as cost_usd,
      request_count
    FROM usage_daily_summary
    WHERE ${whereClause}
    ORDER BY date ASC
  `,
    )
    .all(...params) as Array<{
    date: string;
    model: string;
    user_id: string;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_creation_tokens: number;
    cost_usd: number;
    request_count: number;
  }>;
}

/**
 * Get usage summary from daily summary table.
 */
export function getUsageDailySummary(
  days: number,
  userId?: string,
  modelFilter?: string,
): {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheCreationTokens: number;
  totalCostUSD: number;
  totalMessages: number;
  totalActiveDays: number;
} {
  const sinceDate = toLocalDateString(new Date(Date.now() - days * 86400000));
  const conditions: string[] = ['date >= ?'];
  const params: unknown[] = [sinceDate];

  if (userId) {
    conditions.push('user_id = ?');
    params.push(userId);
  }
  if (modelFilter) {
    conditions.push('model = ?');
    params.push(modelFilter);
  }

  const whereClause = conditions.join(' AND ');
  const row = db
    .prepare(
      `
    SELECT
      COALESCE(SUM(total_input_tokens), 0) as total_input,
      COALESCE(SUM(total_output_tokens), 0) as total_output,
      COALESCE(SUM(total_cache_read_tokens), 0) as total_cache_read,
      COALESCE(SUM(total_cache_creation_tokens), 0) as total_cache_creation,
      COALESCE(SUM(total_cost_usd), 0) as total_cost,
      COALESCE(SUM(request_count), 0) as total_messages,
      COUNT(DISTINCT date) as total_active_days
    FROM usage_daily_summary
    WHERE ${whereClause}
  `,
    )
    .get(...params) as {
    total_input: number;
    total_output: number;
    total_cache_read: number;
    total_cache_creation: number;
    total_cost: number;
    total_messages: number;
    total_active_days: number;
  };

  return {
    totalInputTokens: row.total_input,
    totalOutputTokens: row.total_output,
    totalCacheReadTokens: row.total_cache_read,
    totalCacheCreationTokens: row.total_cache_creation,
    totalCostUSD: row.total_cost,
    totalMessages: row.total_messages,
    totalActiveDays: row.total_active_days,
  };
}

/**
 * Get list of all models that have usage data.
 */
export function getUsageModels(): string[] {
  const rows = db
    .prepare('SELECT DISTINCT model FROM usage_daily_summary ORDER BY model')
    .all() as Array<{ model: string }>;
  return rows.map((r) => r.model);
}

/**
 * Get list of users that have usage data.
 */
export function getUsageUsers(): Array<{ id: string; username: string }> {
  const rows = db
    .prepare(
      `
    SELECT DISTINCT uds.user_id as id, COALESCE(u.username, uds.user_id) as username
    FROM usage_daily_summary uds
    LEFT JOIN users u ON u.id = uds.user_id
    ORDER BY u.username
  `,
    )
    .all() as Array<{ id: string; username: string }>;
  return rows;
}

export function getNewMessages(
  jids: string[],
  cursor: MessageCursor,
): { messages: NewMessage[]; newCursor: MessageCursor } {
  if (jids.length === 0) return { messages: [], newCursor: cursor };

  const rawRows = getNewMessagesStmt(jids.length).all(
    cursor.timestamp,
    cursor.timestamp,
    cursor.id,
    ...jids,
  ) as NewMessage[];
  const rows = rawRows.map((r) => normalizeMessageRow(r));
  const last = rows[rows.length - 1];
  return {
    messages: rows,
    newCursor: last ? { timestamp: last.timestamp, id: last.id } : cursor,
  };
}

export function getMessagesSince(
  chatJid: string,
  cursor: MessageCursor,
): NewMessage[] {
  const rows = stmts().getMessagesSince.all(
    chatJid,
    cursor.timestamp,
    cursor.timestamp,
    cursor.id,
  ) as NewMessage[];
  return rows.map((row) => normalizeMessageRow(row));
}

export function createTask(
  task: Omit<ScheduledTask, 'last_run' | 'last_result'>,
): void {
  db.prepare(
    `
    INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, context_mode, execution_type, runtime_profile, agent_client_id, backend, agent_model, script_command, execution_mode, execution_node, next_run, status, created_at, created_by, notify_channels)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    task.id,
    task.group_folder,
    task.chat_jid,
    toUtf8String(task.prompt, 'scheduled_tasks.prompt'),
    task.schedule_type,
    task.schedule_value,
    task.context_mode || 'group',
    task.execution_type || 'agent',
    task.runtime_profile ?? null,
    task.agent_client_id ?? null,
    task.backend ?? null,
    task.agent_model ?? null,
    task.script_command == null
      ? null
      : toUtf8String(task.script_command, 'scheduled_tasks.script_command'),
    task.execution_mode ?? null,
    task.execution_node ?? null,
    task.next_run,
    task.status,
    task.created_at,
    task.created_by ?? null,
    task.notify_channels != null ? JSON.stringify(task.notify_channels) : null,
  );
}

/** Parse notify_channels from JSON string stored in DB and normalize new fields */
function mapTaskRow(row: unknown): ScheduledTask {
  const r = row as any;
  if (typeof r.notify_channels === 'string') {
    try {
      r.notify_channels = JSON.parse(r.notify_channels);
    } catch {
      r.notify_channels = null;
    }
  } else if (r.notify_channels === undefined) {
    r.notify_channels = null;
  }
  // Normalize new nullable fields
  if (r.runtime_profile === undefined) r.runtime_profile = null;
  if (r.agent_client_id === undefined) r.agent_client_id = null;
  if (r.backend === undefined) r.backend = null;
  if (r.agent_model === undefined) r.agent_model = null;
  if (r.execution_mode === undefined) r.execution_mode = null;
  if (r.execution_node === undefined) r.execution_node = null;
  if (r.workspace_jid === undefined) r.workspace_jid = null;
  if (r.workspace_folder === undefined) r.workspace_folder = null;
  if (r.claim_token === undefined) r.claim_token = null;
  if (r.claimed_by === undefined) r.claimed_by = null;
  if (r.claimed_at === undefined) r.claimed_at = null;
  if (r.lease_expires_at === undefined) r.lease_expires_at = null;
  // Defensive: legacy BLOB cells in TEXT-affinity columns come back as Buffer.
  r.prompt = toUtf8String(r.prompt);
  if (r.script_command !== undefined)
    r.script_command = toUtf8StringOrNull(r.script_command);
  return r as ScheduledTask;
}

export function getTaskById(id: string): ScheduledTask | undefined {
  const row = db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(id);
  return row ? mapTaskRow(row) : undefined;
}

export function getTasksForGroup(groupFolder: string): ScheduledTask[] {
  return db
    .prepare(
      'SELECT * FROM scheduled_tasks WHERE group_folder = ? ORDER BY created_at DESC',
    )
    .all(groupFolder)
    .map(mapTaskRow);
}

export function getAllTasks(): ScheduledTask[] {
  return db
    .prepare('SELECT * FROM scheduled_tasks ORDER BY created_at DESC')
    .all()
    .map(mapTaskRow);
}

export function updateTask(
  id: string,
  updates: Partial<
    Pick<
      ScheduledTask,
      | 'prompt'
      | 'schedule_type'
      | 'schedule_value'
      | 'context_mode'
      | 'execution_type'
      | 'runtime_profile'
      | 'agent_client_id'
      | 'backend'
      | 'agent_model'
      | 'execution_mode'
      | 'execution_node'
      | 'script_command'
      | 'next_run'
      | 'status'
      | 'notify_channels'
      | 'chat_jid'
      | 'group_folder'
    >
  >,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.prompt !== undefined) {
    fields.push('prompt = ?');
    values.push(toUtf8String(updates.prompt, 'scheduled_tasks.prompt'));
  }
  if (updates.schedule_type !== undefined) {
    fields.push('schedule_type = ?');
    values.push(updates.schedule_type);
  }
  if (updates.schedule_value !== undefined) {
    fields.push('schedule_value = ?');
    values.push(updates.schedule_value);
  }
  if (updates.context_mode !== undefined) {
    fields.push('context_mode = ?');
    values.push(updates.context_mode);
  }
  if (updates.execution_type !== undefined) {
    fields.push('execution_type = ?');
    values.push(updates.execution_type);
  }
  if (updates.runtime_profile !== undefined) {
    fields.push('runtime_profile = ?');
    values.push(updates.runtime_profile);
  }
  if (updates.agent_client_id !== undefined) {
    fields.push('agent_client_id = ?');
    values.push(updates.agent_client_id || null);
  }
  if (updates.backend !== undefined) {
    fields.push('backend = ?');
    values.push(updates.backend || null);
  }
  if (updates.agent_model !== undefined) {
    fields.push('agent_model = ?');
    values.push(updates.agent_model || null);
  }
  if (updates.execution_mode !== undefined) {
    fields.push('execution_mode = ?');
    values.push(updates.execution_mode);
  }
  if (updates.execution_node !== undefined) {
    fields.push('execution_node = ?');
    values.push(updates.execution_node);
  }
  if (updates.script_command !== undefined) {
    fields.push('script_command = ?');
    values.push(
      updates.script_command == null
        ? null
        : toUtf8String(
            updates.script_command,
            'scheduled_tasks.script_command',
          ),
    );
  }
  if (updates.next_run !== undefined) {
    fields.push('next_run = ?');
    values.push(updates.next_run);
  }
  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }
  if (updates.notify_channels !== undefined) {
    fields.push('notify_channels = ?');
    values.push(
      updates.notify_channels != null
        ? JSON.stringify(updates.notify_channels)
        : null,
    );
  }
  if (updates.chat_jid !== undefined) {
    fields.push('chat_jid = ?');
    values.push(updates.chat_jid);
  }
  if (updates.group_folder !== undefined) {
    fields.push('group_folder = ?');
    values.push(updates.group_folder);
  }

  if (fields.length === 0) return;

  values.push(id);
  db.prepare(
    `UPDATE scheduled_tasks SET ${fields.join(', ')} WHERE id = ?`,
  ).run(...values);
}

export function updateTaskWorkspace(
  id: string,
  workspaceJid: string,
  workspaceFolder: string,
): void {
  db.prepare(
    'UPDATE scheduled_tasks SET workspace_jid = ?, workspace_folder = ? WHERE id = ?',
  ).run(workspaceJid, workspaceFolder, id);
}

export function deleteTask(id: string): void {
  // Delete child records first (FK constraint)
  db.prepare('DELETE FROM task_run_logs WHERE task_id = ?').run(id);
  db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id);
}

export function deleteTasksForGroup(groupFolder: string): void {
  const tx = db.transaction((folder: string) => {
    db.prepare(
      `
      DELETE FROM task_run_logs
      WHERE task_id IN (
        SELECT id FROM scheduled_tasks WHERE group_folder = ?
      )
      `,
    ).run(folder);
    db.prepare('DELETE FROM scheduled_tasks WHERE group_folder = ?').run(
      folder,
    );
  });
  tx(groupFolder);
}

export function getDueTasks(): ScheduledTask[] {
  const now = new Date().toISOString();
  return db
    .prepare(
      `
    SELECT * FROM scheduled_tasks
    WHERE status = 'active' AND next_run IS NOT NULL AND next_run <= ?
    ORDER BY next_run
  `,
    )
    .all(now)
    .map(mapTaskRow);
}

export interface TaskRunClaim {
  token: string;
  claimedBy: string;
  claimedAt: string;
  leaseExpiresAt: string;
}

export function claimTaskRun(
  id: string,
  options: {
    expectedNextRun?: string | null;
    manualRun?: boolean;
    claimedBy?: string;
    leaseMs?: number;
  } = {},
): TaskRunClaim | null {
  const now = new Date();
  const nowIso = now.toISOString();
  const leaseMs = Math.max(1_000, options.leaseMs ?? 6 * 60 * 60 * 1000);
  const leaseExpiresAt = new Date(now.getTime() + leaseMs).toISOString();
  const claimedBy = options.claimedBy ?? 'scheduler';
  const token = crypto.randomUUID();
  const isManualRun = options.manualRun === true;

  const result = isManualRun
    ? db
        .prepare(
          `
        UPDATE scheduled_tasks
        SET claim_token = ?, claimed_by = ?, claimed_at = ?, lease_expires_at = ?
        WHERE id = ?
          AND status = 'active'
          AND (claim_token IS NULL OR lease_expires_at IS NULL OR lease_expires_at <= ?)
        `,
        )
        .run(token, claimedBy, nowIso, leaseExpiresAt, id, nowIso)
    : db
        .prepare(
          `
        UPDATE scheduled_tasks
        SET claim_token = ?, claimed_by = ?, claimed_at = ?, lease_expires_at = ?
        WHERE id = ?
          AND status = 'active'
          AND next_run = ?
          AND next_run IS NOT NULL
          AND next_run <= ?
          AND (claim_token IS NULL OR lease_expires_at IS NULL OR lease_expires_at <= ?)
        `,
        )
        .run(
          token,
          claimedBy,
          nowIso,
          leaseExpiresAt,
          id,
          options.expectedNextRun ?? null,
          nowIso,
          nowIso,
        );

  return result.changes === 1
    ? { token, claimedBy, claimedAt: nowIso, leaseExpiresAt }
    : null;
}

export function updateTaskAfterRun(
  id: string,
  nextRun: string | null,
  lastResult: string,
): void {
  const now = new Date().toISOString();
  db.prepare(
    `
    UPDATE scheduled_tasks
    SET next_run = ?, last_run = ?, last_result = ?, status = CASE WHEN ? IS NULL THEN 'completed' ELSE status END
    WHERE id = ?
  `,
  ).run(nextRun, now, lastResult, nextRun, id);
}

export function updateTaskAfterRunClaimed(
  id: string,
  claimToken: string,
  nextRun: string | null,
  lastResult: string,
): boolean {
  const now = new Date().toISOString();
  const result = db
    .prepare(
      `
    UPDATE scheduled_tasks
    SET next_run = ?,
        last_run = ?,
        last_result = ?,
        status = CASE WHEN ? IS NULL THEN 'completed' ELSE status END,
        claim_token = NULL,
        claimed_by = NULL,
        claimed_at = NULL,
        lease_expires_at = NULL
    WHERE id = ? AND claim_token = ?
  `,
    )
    .run(nextRun, now, lastResult, nextRun, id, claimToken);
  return result.changes === 1;
}

export function releaseTaskRunClaim(id: string, claimToken: string): boolean {
  const result = db
    .prepare(
      `
    UPDATE scheduled_tasks
    SET claim_token = NULL,
        claimed_by = NULL,
        claimed_at = NULL,
        lease_expires_at = NULL
    WHERE id = ? AND claim_token = ?
    `,
    )
    .run(id, claimToken);
  return result.changes === 1;
}

// Advance next_run for a task we deliberately did NOT execute (e.g. overdue
// beyond the backfill grace window). Does not touch last_run, so the task
// detail view continues to reflect the last *actual* run.
export function advanceSkippedTask(id: string, nextRun: string | null): void {
  db.prepare(
    `
    UPDATE scheduled_tasks
    SET next_run = ?, status = CASE WHEN ? IS NULL THEN 'completed' ELSE status END
    WHERE id = ?
  `,
  ).run(nextRun, nextRun, id);
}

export function logTaskRun(log: TaskRunLog): void {
  db.prepare(
    `
    INSERT INTO task_run_logs (task_id, run_at, duration_ms, status, result, error)
    VALUES (?, ?, ?, ?, ?, ?)
  `,
  ).run(
    log.task_id,
    log.run_at,
    log.duration_ms,
    log.status,
    log.result,
    log.error,
  );
}

export function logTaskRunStart(taskId: string): number {
  const result = db
    .prepare(
      `
    INSERT INTO task_run_logs (task_id, run_at, duration_ms, status, result, error)
    VALUES (?, ?, 0, 'running', NULL, NULL)
  `,
    )
    .run(taskId, new Date().toISOString());
  return Number(result.lastInsertRowid);
}

export function updateTaskRunLog(
  id: number,
  updates: {
    duration_ms: number;
    status: 'success' | 'error';
    result: string | null;
    error: string | null;
  },
): void {
  db.prepare(
    `
    UPDATE task_run_logs SET duration_ms = ?, status = ?, result = ?, error = ?
    WHERE id = ?
  `,
  ).run(updates.duration_ms, updates.status, updates.result, updates.error, id);
}

export function cleanupStaleRunningLogs(): number {
  const result = db
    .prepare(
      `
    UPDATE task_run_logs SET status = 'error', error = 'Process crashed before completion'
    WHERE status = 'running'
  `,
    )
    .run();
  return result.changes;
}

export function cleanupOldTaskRunLogs(retentionDays = 30): number {
  const cutoff = new Date(
    Date.now() - retentionDays * 24 * 60 * 60 * 1000,
  ).toISOString();
  const result = db
    .prepare(`DELETE FROM task_run_logs WHERE run_at < ?`)
    .run(cutoff);
  return result.changes;
}

type IssueRow = Omit<WorkspaceIssue, 'selected_skills'> & {
  selected_skills?: string | null;
};

function parseIssueSkills(value: string | null | undefined): string[] | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : null;
  } catch {
    return null;
  }
}

function mapIssueRow(row: unknown): WorkspaceIssue {
  const r = row as IssueRow;
  return {
    ...r,
    title: toUtf8String(r.title),
    description: toUtf8String(r.description),
    status: r.status as IssueStatus,
    priority: r.priority as IssuePriority,
    selected_skills: parseIssueSkills(r.selected_skills),
  };
}

function mapIssueRunRow(row: unknown): IssueAgentRun {
  const r = row as Omit<IssueAgentRun, 'selected_skills'> & {
    selected_skills?: string | null;
  };
  return {
    ...r,
    result: toUtf8StringOrNull(r.result),
    error: toUtf8StringOrNull(r.error),
    selected_skills: parseIssueSkills(r.selected_skills),
  };
}

function mapIssueRunEventRow(row: unknown): IssueAgentRunEvent {
  const r = row as Omit<IssueAgentRunEvent, 'payload'> & { payload?: string | null };
  let payload: Record<string, unknown> | null = null;
  if (r.payload) {
    try {
      const parsed = JSON.parse(r.payload);
      payload = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : { value: parsed };
    } catch {
      payload = { raw: r.payload };
    }
  }
  return {
    ...r,
    title: toUtf8StringOrNull(r.title),
    summary: toUtf8StringOrNull(r.summary),
    detail: toUtf8StringOrNull(r.detail),
    payload,
  };
}

function mapIssueAttachmentRow(row: unknown): IssueAttachment {
  const r = row as IssueAttachment;
  return {
    ...r,
    filename: toUtf8String(r.filename),
    mime_type: toUtf8String(r.mime_type),
    data_url: toUtf8String(r.data_url),
  };
}

export interface IssueListFilters {
  workspaceJid?: string;
  workspaceJids?: string[];
  query?: string;
  statuses?: IssueStatus[];
  priorities?: IssuePriority[];
  assigneeUserId?: string;
  projectRepoId?: string;
  showDone?: boolean;
  sort?: 'status' | 'updated' | 'created' | 'priority' | 'due_date';
  direction?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

export function createIssue(
  issue: Omit<WorkspaceIssue, 'selected_skills'> & { selected_skills?: string[] | null },
): WorkspaceIssue {
  db.prepare(
    `
    INSERT INTO issues (
      id, workspace_jid, workspace_folder, title, description, status, priority,
      assignee_user_id, due_date,
      project_repo_id, project_git_url, project_device_path, project_device_link_id,
      agent_link_id, agent_client_id, execution_node, backend, selected_skills,
      created_by, created_at, updated_at, closed_at, last_run_id, last_run_status, last_run_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
  ).run(
    issue.id,
    issue.workspace_jid,
    issue.workspace_folder,
    toUtf8String(issue.title, 'issues.title'),
    toUtf8String(issue.description, 'issues.description'),
    issue.status,
    issue.priority,
    issue.assignee_user_id ?? null,
    issue.due_date ?? null,
    issue.project_repo_id ?? null,
    issue.project_git_url ?? null,
    issue.project_device_path ?? null,
    issue.project_device_link_id ?? null,
    issue.agent_link_id ?? null,
    issue.agent_client_id ?? null,
    issue.execution_node ?? null,
    issue.backend ?? null,
    issue.selected_skills ? JSON.stringify(issue.selected_skills) : null,
    issue.created_by,
    issue.created_at,
    issue.updated_at,
    issue.closed_at ?? null,
    issue.last_run_id ?? null,
    issue.last_run_status ?? null,
    issue.last_run_at ?? null,
  );
  const created = getIssueById(issue.id);
  if (!created) throw new Error('Failed to create issue');
  return created;
}

export function getIssueById(id: string): WorkspaceIssue | undefined {
  const row = db.prepare('SELECT * FROM issues WHERE id = ?').get(id);
  return row ? mapIssueRow(row) : undefined;
}

export function listIssues(filters: IssueListFilters = {}): {
  issues: WorkspaceIssue[];
  total: number;
} {
  const where: string[] = [];
  const values: unknown[] = [];
  if (filters.workspaceJid) {
    where.push('workspace_jid = ?');
    values.push(filters.workspaceJid);
  } else if (filters.workspaceJids) {
    const workspaceJids = Array.from(new Set(filters.workspaceJids)).filter(
      Boolean,
    );
    if (workspaceJids.length === 0) {
      where.push('1 = 0');
    } else {
      where.push(`workspace_jid IN (${workspaceJids.map(() => '?').join(',')})`);
      values.push(...workspaceJids);
    }
  }
  if (filters.query?.trim()) {
    where.push('(title LIKE ? OR description LIKE ?)');
    const q = `%${filters.query.trim()}%`;
    values.push(q, q);
  }
  if (filters.statuses?.length) {
    where.push(`status IN (${filters.statuses.map(() => '?').join(',')})`);
    values.push(...filters.statuses);
  } else if (!filters.showDone) {
    where.push("status != 'done'");
  }
  if (filters.priorities?.length) {
    where.push(`priority IN (${filters.priorities.map(() => '?').join(',')})`);
    values.push(...filters.priorities);
  }
  if (filters.assigneeUserId) {
    where.push('assignee_user_id = ?');
    values.push(filters.assigneeUserId);
  }
  if (filters.projectRepoId) {
    where.push('project_repo_id = ?');
    values.push(filters.projectRepoId);
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const sortColumn =
    filters.sort === 'status'
      ? 'status'
      : filters.sort === 'created'
        ? 'created_at'
        : filters.sort === 'priority'
          ? `CASE priority WHEN 'urgent' THEN 4 WHEN 'high' THEN 3 WHEN 'medium' THEN 2 WHEN 'low' THEN 1 ELSE 0 END`
          : filters.sort === 'due_date'
            ? 'due_date'
            : 'updated_at';
  const direction = filters.direction === 'asc' ? 'ASC' : 'DESC';
  const limit = Math.max(1, Math.min(200, filters.limit ?? 100));
  const offset = Math.max(0, filters.offset ?? 0);
  const total = (
    db.prepare(`SELECT COUNT(*) as total FROM issues ${whereSql}`).get(...values) as {
      total: number;
    }
  ).total;
  const rows = db
    .prepare(
      `SELECT * FROM issues ${whereSql} ORDER BY ${sortColumn} ${direction}, updated_at DESC LIMIT ? OFFSET ?`,
    )
    .all(...values, limit, offset);
  return { issues: rows.map(mapIssueRow), total };
}

export function listAutoDrivableIssues(limit = 20): WorkspaceIssue[] {
  const rows = db
    .prepare(
      `
      SELECT i.*
      FROM issues i
      WHERE i.closed_at IS NULL
        AND (
          i.execution_node IS NOT NULL OR
          i.agent_link_id IS NOT NULL OR
          i.agent_client_id IS NOT NULL OR
          i.backend IS NOT NULL
        )
        AND NOT EXISTS (
          SELECT 1 FROM issue_agent_runs r
          WHERE r.issue_id = i.id AND r.status IN ('queued', 'running', 'awaiting_input')
        )
        AND (
          i.status = 'todo'
          OR (
            i.status = 'waiting_for_human' AND EXISTS (
              SELECT 1 FROM issue_agent_requests q
              WHERE q.issue_id = i.id AND q.status = 'answered' AND q.consumed_at IS NULL
            )
          )
        )
      ORDER BY
        CASE i.priority WHEN 'urgent' THEN 4 WHEN 'high' THEN 3 WHEN 'medium' THEN 2 WHEN 'low' THEN 1 ELSE 0 END DESC,
        i.created_at ASC
      LIMIT ?
      `,
    )
    .all(Math.max(1, Math.min(100, limit)));
  return rows.map(mapIssueRow);
}

export function updateIssue(
  id: string,
  updates: Partial<
    Pick<
      WorkspaceIssue,
      | 'title'
      | 'description'
      | 'status'
      | 'priority'
      | 'assignee_user_id'
      | 'due_date'
      | 'project_repo_id'
      | 'project_git_url'
      | 'project_device_path'
      | 'project_device_link_id'
      | 'agent_link_id'
      | 'agent_client_id'
      | 'execution_node'
      | 'backend'
      | 'selected_skills'
      | 'closed_at'
    >
  >,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];
  const add = (column: string, value: unknown) => {
    fields.push(`${column} = ?`);
    values.push(value);
  };
  if (updates.title !== undefined) add('title', toUtf8String(updates.title, 'issues.title'));
  if (updates.description !== undefined)
    add('description', toUtf8String(updates.description, 'issues.description'));
  if (updates.status !== undefined) {
    add('status', updates.status);
    add('closed_at', updates.status === 'done' || updates.status === 'canceled' ? new Date().toISOString() : null);
  }
  if (updates.priority !== undefined) add('priority', updates.priority);
  if (updates.assignee_user_id !== undefined) add('assignee_user_id', updates.assignee_user_id);
  if (updates.due_date !== undefined) add('due_date', updates.due_date);
  if (updates.project_repo_id !== undefined) add('project_repo_id', updates.project_repo_id);
  if (updates.project_git_url !== undefined) add('project_git_url', updates.project_git_url);
  if (updates.project_device_path !== undefined) add('project_device_path', updates.project_device_path);
  if (updates.project_device_link_id !== undefined) add('project_device_link_id', updates.project_device_link_id);
  if (updates.agent_link_id !== undefined) add('agent_link_id', updates.agent_link_id);
  if (updates.agent_client_id !== undefined) add('agent_client_id', updates.agent_client_id);
  if (updates.execution_node !== undefined) add('execution_node', updates.execution_node);
  if (updates.backend !== undefined) add('backend', updates.backend);
  if (updates.selected_skills !== undefined)
    add('selected_skills', updates.selected_skills ? JSON.stringify(updates.selected_skills) : null);
  if (updates.closed_at !== undefined) add('closed_at', updates.closed_at);
  if (fields.length === 0) return;
  add('updated_at', new Date().toISOString());
  values.push(id);
  db.prepare(`UPDATE issues SET ${fields.join(', ')} WHERE id = ?`).run(...values);
}

export function updateIssueLastRun(
  issueId: string,
  runId: string,
  status: IssueAgentRun['status'],
): void {
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE issues SET last_run_id = ?, last_run_status = ?, last_run_at = ?, updated_at = ? WHERE id = ?`,
  ).run(runId, status, now, now, issueId);
}

export function deleteIssue(id: string): void {
  db.prepare('DELETE FROM issue_attachments WHERE issue_id = ?').run(id);
  db.prepare('DELETE FROM issue_comments WHERE issue_id = ?').run(id);
  // notifications reference events, events reference runs — delete in order
  db.prepare(
    `DELETE FROM issue_event_notifications WHERE event_id IN (SELECT id FROM issue_events WHERE issue_id = ?)`,
  ).run(id);
  db.prepare('DELETE FROM issue_events WHERE issue_id = ?').run(id);
  db.prepare('DELETE FROM issue_agent_requests WHERE issue_id = ?').run(id);
  db.prepare('DELETE FROM issue_agent_run_events WHERE issue_id = ?').run(id);
  db.prepare('DELETE FROM issue_agent_runs WHERE issue_id = ?').run(id);
  db.prepare('DELETE FROM issues WHERE id = ?').run(id);
}

export function createIssueAgentRun(
  run: Omit<IssueAgentRun, 'selected_skills'> & { selected_skills?: string[] | null },
): IssueAgentRun {
  db.prepare(
    `
    INSERT INTO issue_agent_runs (
      id, issue_id, workspace_jid, workspace_folder, agent_link_id, agent_client_id,
      execution_node, backend, selected_skills, status, result, error, session_id,
      parent_run_id, awaiting_kind, awaiting_payload_id, last_seen_at, heartbeat_deadline_at,
      created_by, created_at, run_started_at, run_completed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
  ).run(
    run.id,
    run.issue_id,
    run.workspace_jid,
    run.workspace_folder,
    run.agent_link_id ?? null,
    run.agent_client_id ?? null,
    run.execution_node ?? null,
    run.backend ?? null,
    run.selected_skills ? JSON.stringify(run.selected_skills) : null,
    run.status,
    run.result == null ? null : toUtf8String(run.result, 'issue_agent_runs.result'),
    run.error == null ? null : toUtf8String(run.error, 'issue_agent_runs.error'),
    run.session_id ?? null,
    run.parent_run_id ?? null,
    run.awaiting_kind ?? null,
    run.awaiting_payload_id ?? null,
    run.last_seen_at ?? null,
    run.heartbeat_deadline_at ?? null,
    run.created_by,
    run.created_at,
    run.run_started_at ?? null,
    run.run_completed_at ?? null,
  );
  const created = getIssueAgentRunById(run.id);
  if (!created) throw new Error('Failed to create issue agent run');
  return created;
}

export function getIssueAgentRunById(id: string): IssueAgentRun | undefined {
  const row = db.prepare('SELECT * FROM issue_agent_runs WHERE id = ?').get(id);
  return row ? mapIssueRunRow(row) : undefined;
}

export function listIssueAgentRuns(issueId: string): IssueAgentRun[] {
  return db
    .prepare('SELECT * FROM issue_agent_runs WHERE issue_id = ? ORDER BY created_at DESC')
    .all(issueId)
    .map(mapIssueRunRow);
}

export function updateIssueAgentRun(
  id: string,
  updates: Partial<
    Pick<
      IssueAgentRun,
      | 'status'
      | 'result'
      | 'error'
      | 'session_id'
      | 'parent_run_id'
      | 'awaiting_kind'
      | 'awaiting_payload_id'
      | 'last_seen_at'
      | 'heartbeat_deadline_at'
      | 'run_started_at'
      | 'run_completed_at'
    >
  >,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];
  const add = (column: string, value: unknown) => {
    fields.push(`${column} = ?`);
    values.push(value);
  };
  if (updates.status !== undefined) add('status', updates.status);
  if (updates.result !== undefined)
    add('result', updates.result == null ? null : toUtf8String(updates.result, 'issue_agent_runs.result'));
  if (updates.error !== undefined)
    add('error', updates.error == null ? null : toUtf8String(updates.error, 'issue_agent_runs.error'));
  if (updates.session_id !== undefined) add('session_id', updates.session_id);
  if (updates.parent_run_id !== undefined) add('parent_run_id', updates.parent_run_id);
  if (updates.awaiting_kind !== undefined) add('awaiting_kind', updates.awaiting_kind);
  if (updates.awaiting_payload_id !== undefined) add('awaiting_payload_id', updates.awaiting_payload_id);
  if (updates.last_seen_at !== undefined) add('last_seen_at', updates.last_seen_at);
  if (updates.heartbeat_deadline_at !== undefined) add('heartbeat_deadline_at', updates.heartbeat_deadline_at);
  if (updates.run_started_at !== undefined) add('run_started_at', updates.run_started_at);
  if (updates.run_completed_at !== undefined) add('run_completed_at', updates.run_completed_at);
  if (fields.length === 0) return;
  values.push(id);
  db.prepare(`UPDATE issue_agent_runs SET ${fields.join(', ')} WHERE id = ?`).run(...values);
}

export function createIssueAgentRunEvent(
  event: Omit<IssueAgentRunEvent, 'payload'> & { payload?: Record<string, unknown> | null },
): IssueAgentRunEvent {
  db.prepare(
    `
    INSERT INTO issue_agent_run_events (
      id, issue_id, run_id, event_type, title, summary, detail, payload, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
  ).run(
    event.id,
    event.issue_id,
    event.run_id,
    event.event_type,
    event.title == null ? null : toUtf8String(event.title, 'issue_agent_run_events.title'),
    event.summary == null ? null : toUtf8String(event.summary, 'issue_agent_run_events.summary'),
    event.detail == null ? null : toUtf8String(event.detail, 'issue_agent_run_events.detail'),
    event.payload == null ? null : JSON.stringify(event.payload),
    event.created_at,
  );
  const created = db.prepare('SELECT * FROM issue_agent_run_events WHERE id = ?').get(event.id);
  if (!created) throw new Error('Failed to create issue agent run event');
  return mapIssueRunEventRow(created);
}

export function listIssueAgentRunEvents(runId: string): IssueAgentRunEvent[] {
  return db
    .prepare('SELECT * FROM issue_agent_run_events WHERE run_id = ? ORDER BY created_at ASC')
    .all(runId)
    .map(mapIssueRunEventRow);
}

// --- Issue agent run heartbeat / awaiting helpers (P0) ---

const HEARTBEAT_DEADLINE_MS_DEFAULT = 90_000;

export function touchIssueAgentRunHeartbeat(
  runId: string,
  opts: { now?: string; deadlineMs?: number } = {},
): void {
  const now = opts.now ?? new Date().toISOString();
  const deadlineMs = opts.deadlineMs ?? HEARTBEAT_DEADLINE_MS_DEFAULT;
  const deadline = new Date(Date.now() + deadlineMs).toISOString();
  db.prepare(
    `UPDATE issue_agent_runs
       SET last_seen_at = ?, heartbeat_deadline_at = ?
     WHERE id = ?
       AND status IN ('queued', 'running', 'awaiting_input', 'paused')`,
  ).run(now, deadline, runId);
}

export function markIssueAgentRunLost(runId: string, reason: string): void {
  db.prepare(
    `UPDATE issue_agent_runs
       SET status = 'lost', error = ?
     WHERE id = ? AND status IN ('queued', 'running')`,
  ).run(reason, runId);
}

export function findStaleRunningRuns(now: string, staleMs: number): IssueAgentRun[] {
  const threshold = new Date(new Date(now).getTime() - staleMs).toISOString();
  const rows = db
    .prepare(
      `SELECT * FROM issue_agent_runs
        WHERE status IN ('running', 'queued')
          AND (last_seen_at IS NULL OR last_seen_at < ?)
          AND created_at < ?`,
    )
    .all(threshold, threshold);
  return rows.map(mapIssueRunRow);
}

export function setIssueAgentRunAwaiting(
  runId: string,
  kind: 'permission' | 'clarification',
  payloadId: string,
): void {
  db.prepare(
    `UPDATE issue_agent_runs
       SET status = 'awaiting_input', awaiting_kind = ?, awaiting_payload_id = ?
     WHERE id = ?`,
  ).run(kind, payloadId, runId);
}

export function clearIssueAgentRunAwaiting(runId: string): void {
  db.prepare(
    `UPDATE issue_agent_runs
       SET awaiting_kind = NULL, awaiting_payload_id = NULL
     WHERE id = ?`,
  ).run(runId);
}

// --- Issue agent requests (P1) ---

function mapIssueAgentRequestRow(row: unknown): IssueAgentRequest {
  const r = row as Omit<IssueAgentRequest, 'payload'> & { payload?: string | null };
  let payload: Record<string, unknown> | null = null;
  if (r.payload) {
    try {
      const parsed = JSON.parse(r.payload);
      payload = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : { value: parsed };
    } catch {
      payload = { raw: r.payload };
    }
  }
  return {
    ...r,
    title: toUtf8StringOrNull(r.title),
    summary: toUtf8StringOrNull(r.summary),
    detail: toUtf8StringOrNull(r.detail),
    answer: toUtf8StringOrNull(r.answer),
    payload,
  };
}

export function createIssueAgentRequest(
  input: Omit<IssueAgentRequest, 'payload'> & { payload?: Record<string, unknown> | null },
): IssueAgentRequest {
  db.prepare(
    `INSERT INTO issue_agent_requests (
        id, issue_id, run_id, kind, correlation_id, title, summary, detail, payload,
        status, decision, answer, answered_at, answered_by, consumed_at, expires_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.issue_id,
    input.run_id,
    input.kind,
    input.correlation_id ?? null,
    input.title == null ? null : toUtf8String(input.title, 'issue_agent_requests.title'),
    input.summary == null ? null : toUtf8String(input.summary, 'issue_agent_requests.summary'),
    input.detail == null ? null : toUtf8String(input.detail, 'issue_agent_requests.detail'),
    input.payload == null ? null : JSON.stringify(input.payload),
    input.status,
    input.decision ?? null,
    input.answer == null ? null : toUtf8String(input.answer, 'issue_agent_requests.answer'),
    input.answered_at ?? null,
    input.answered_by ?? null,
    input.consumed_at ?? null,
    input.expires_at ?? null,
    input.created_at,
  );
  const created = getIssueAgentRequestById(input.id);
  if (!created) throw new Error('Failed to create issue agent request');
  return created;
}

export function getIssueAgentRequestById(id: string): IssueAgentRequest | undefined {
  const row = db.prepare('SELECT * FROM issue_agent_requests WHERE id = ?').get(id);
  return row ? mapIssueAgentRequestRow(row) : undefined;
}

export function getIssueAgentRequestByCorrelationId(
  correlationId: string,
): IssueAgentRequest | undefined {
  const row = db
    .prepare('SELECT * FROM issue_agent_requests WHERE correlation_id = ? ORDER BY created_at DESC')
    .get(correlationId);
  return row ? mapIssueAgentRequestRow(row) : undefined;
}

export function listIssueAgentRequests(
  issueId: string,
  opts: { status?: IssueAgentRequest['status']; runId?: string } = {},
): IssueAgentRequest[] {
  const clauses: string[] = ['issue_id = ?'];
  const params: unknown[] = [issueId];
  if (opts.status) {
    clauses.push('status = ?');
    params.push(opts.status);
  }
  if (opts.runId) {
    clauses.push('run_id = ?');
    params.push(opts.runId);
  }
  const rows = db
    .prepare(
      `SELECT * FROM issue_agent_requests WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC`,
    )
    .all(...params);
  return rows.map(mapIssueAgentRequestRow);
}

export function answerIssueAgentRequest(
  id: string,
  args: {
    decision: NonNullable<IssueAgentRequest['decision']>;
    answer?: string | null;
    answered_by?: string | null;
    now: string;
  },
): IssueAgentRequest | undefined {
  db.prepare(
    `UPDATE issue_agent_requests
       SET status = 'answered',
           decision = ?,
           answer = ?,
           answered_by = ?,
           answered_at = ?
     WHERE id = ? AND status = 'pending'`,
  ).run(
    args.decision,
    args.answer == null ? null : toUtf8String(args.answer, 'issue_agent_requests.answer'),
    args.answered_by ?? null,
    args.now,
    id,
  );
  return getIssueAgentRequestById(id);
}

export function consumeIssueAgentRequest(id: string, now: string): void {
  db.prepare(
    `UPDATE issue_agent_requests SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL`,
  ).run(now, id);
}

export function expireIssueAgentRequests(now: string): IssueAgentRequest[] {
  const rows = db
    .prepare(
      `SELECT * FROM issue_agent_requests
        WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at < ?`,
    )
    .all(now) as Array<{ id: string }>;
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);
  const placeholders = ids.map(() => '?').join(',');
  db.prepare(`UPDATE issue_agent_requests SET status = 'expired' WHERE id IN (${placeholders})`).run(
    ...ids,
  );
  return rows.map(mapIssueAgentRequestRow);
}

export function getLastCompletedIssueRunAt(issueId: string, excludeRunId?: string): string | null {
  const args: unknown[] = [issueId];
  let excludeSql = '';
  if (excludeRunId) {
    excludeSql = 'AND id != ?';
    args.push(excludeRunId);
  }
  const row = db
    .prepare(
      `SELECT run_completed_at FROM issue_agent_runs
       WHERE issue_id = ? AND status IN ('success','error','canceled') ${excludeSql}
       ORDER BY run_completed_at DESC LIMIT 1`,
    )
    .get(...args) as { run_completed_at?: string | null } | undefined;
  return row?.run_completed_at ?? null;
}

export function createIssueAttachment(input: Omit<IssueAttachment, 'created_at'> & { created_at?: string }): IssueAttachment {
  const createdAt = input.created_at ?? new Date().toISOString();
  db.prepare(
    `INSERT INTO issue_attachments (id, issue_id, filename, mime_type, size_bytes, data_url, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.issue_id,
    toUtf8String(input.filename, 'issue_attachments.filename'),
    input.mime_type,
    input.size_bytes,
    toUtf8String(input.data_url, 'issue_attachments.data_url'),
    input.created_by,
    createdAt,
  );
  const attachment = getIssueAttachmentById(input.id);
  if (!attachment) throw new Error('Failed to create issue attachment');
  return attachment;
}

export function getIssueAttachmentById(id: string): IssueAttachment | undefined {
  const row = db.prepare('SELECT * FROM issue_attachments WHERE id = ?').get(id);
  return row ? mapIssueAttachmentRow(row) : undefined;
}

export function listIssueAttachments(issueId: string): IssueAttachment[] {
  return db
    .prepare('SELECT * FROM issue_attachments WHERE issue_id = ? ORDER BY created_at DESC')
    .all(issueId)
    .map(mapIssueAttachmentRow);
}

export function deleteIssueAttachment(id: string): boolean {
  const result = db.prepare('DELETE FROM issue_attachments WHERE id = ?').run(id);
  return result.changes > 0;
}

// --- Issue events (generalized timeline) ---

type IssueEventRow = Omit<IssueEvent, 'detail' | 'payload' | 'source_meta'> & {
  detail?: string | null;
  payload?: string | null;
};

function parseNullableJson<T = Record<string, unknown>>(value: string | null | undefined): T | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as T) : null;
  } catch {
    return null;
  }
}

function mapIssueEventRow(row: unknown): IssueEvent {
  const r = row as IssueEventRow;
  return {
    ...r,
    run_id: r.run_id ?? null,
    actor_id: r.actor_id ?? null,
    event_type: r.event_type as IssueEvent['event_type'],
    title: r.title ? toUtf8StringOrNull(r.title) : null,
    summary: r.summary ? toUtf8StringOrNull(r.summary) : null,
    detail: parseNullableJson(r.detail),
    payload: parseNullableJson(r.payload),
    reference_id: r.reference_id ?? null,
  };
}

export interface CreateIssueEventInput {
  id?: string;
  issue_id: string;
  run_id?: string | null;
  event_type: IssueEvent['event_type'];
  actor_id?: string | null;
  actor_type?: IssueEvent['actor_type'];
  title?: string | null;
  summary?: string | null;
  detail?: Record<string, unknown> | null;
  payload?: Record<string, unknown> | null;
  reference_id?: string | null;
  created_at?: string;
}

export function createIssueEvent(input: CreateIssueEventInput): IssueEvent {
  const now = new Date().toISOString();
  const id = input.id ?? `iev_${crypto_random_16()}`;
  db.prepare(
    `
    INSERT INTO issue_events
      (id, issue_id, run_id, event_type, actor_id, actor_type, title, summary, detail, payload, reference_id, created_at)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
  ).run(
    id,
    input.issue_id,
    input.run_id ?? null,
    input.event_type,
    input.actor_id ?? null,
    input.actor_type ?? 'system',
    input.title ? toUtf8String(input.title, 'issue_events.title') : null,
    input.summary ? toUtf8String(input.summary, 'issue_events.summary') : null,
    input.detail == null ? null : JSON.stringify(input.detail),
    input.payload == null ? null : JSON.stringify(input.payload),
    input.reference_id ?? null,
    input.created_at ?? now,
  );
  const created = db.prepare('SELECT * FROM issue_events WHERE id = ?').get(id);
  if (!created) throw new Error('Failed to create issue event');
  return mapIssueEventRow(created);
}

export interface ListIssueEventsFilters {
  sinceId?: string;
  sinceAt?: string;
  eventTypes?: IssueEvent['event_type'][];
  runId?: string;
  limit?: number;
}

export function listIssueEvents(issueId: string, filters: ListIssueEventsFilters = {}): IssueEvent[] {
  const where: string[] = ['issue_id = ?'];
  const values: unknown[] = [issueId];
  if (filters.runId) {
    where.push('run_id = ?');
    values.push(filters.runId);
  }
  if (filters.sinceId) {
    where.push('id > ?');
    values.push(filters.sinceId);
  }
  if (filters.sinceAt) {
    where.push('created_at > ?');
    values.push(filters.sinceAt);
  }
  if (filters.eventTypes?.length) {
    where.push(`event_type IN (${filters.eventTypes.map(() => '?').join(',')})`);
    values.push(...filters.eventTypes);
  }
  const limit = Math.max(1, Math.min(1000, filters.limit ?? 500));
  const whereSql = `WHERE ${where.join(' AND ')}`;
  const rows = db
    .prepare(`SELECT * FROM issue_events ${whereSql} ORDER BY created_at ASC, id ASC LIMIT ?`)
    .all(...values, limit);
  return rows.map(mapIssueEventRow);
}

export function markIssueEventNotified(eventId: string, channel: string, target: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO issue_event_notifications (event_id, channel, target, sent_at)
     VALUES (?, ?, ?, ?)`,
  ).run(eventId, channel, target, new Date().toISOString());
}

export function isIssueEventNotified(eventId: string, channel: string, target: string): boolean {
  const row = db
    .prepare(
      `SELECT 1 FROM issue_event_notifications WHERE event_id = ? AND channel = ? AND target = ?`,
    )
    .get(eventId, channel, target);
  return !!row;
}

// --- Issue comments ---

type IssueCommentRow = Omit<IssueComment, 'source_meta'> & { source_meta?: string | null };

function mapIssueCommentRow(row: unknown): IssueComment {
  const r = row as IssueCommentRow;
  return {
    ...r,
    body: toUtf8String(r.body),
    created_by: r.created_by ?? null,
    source_type: r.source_type as IssueComment['source_type'],
    source_meta: parseNullableJson(r.source_meta),
    updated_at: r.updated_at ?? null,
    deleted_at: r.deleted_at ?? null,
  };
}

export interface CreateIssueCommentInput {
  id?: string;
  issue_id: string;
  workspace_jid: string;
  body: string;
  created_by?: string | null;
  source_type?: IssueComment['source_type'];
  source_meta?: Record<string, unknown> | null;
  created_at?: string;
}

export function createIssueComment(input: CreateIssueCommentInput): IssueComment {
  const id = input.id ?? `icm_${crypto_random_16()}`;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO issue_comments
      (id, issue_id, workspace_jid, body, created_by, source_type, source_meta, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.issue_id,
    input.workspace_jid,
    toUtf8String(input.body, 'issue_comments.body'),
    input.created_by ?? null,
    input.source_type ?? 'user',
    input.source_meta == null ? null : JSON.stringify(input.source_meta),
    input.created_at ?? now,
  );
  const created = db.prepare('SELECT * FROM issue_comments WHERE id = ?').get(id);
  if (!created) throw new Error('Failed to create issue comment');
  return mapIssueCommentRow(created);
}

export function getIssueCommentById(id: string): IssueComment | undefined {
  const row = db.prepare("SELECT * FROM issue_comments WHERE id = ? AND deleted_at IS NULL").get(id);
  return row ? mapIssueCommentRow(row) : undefined;
}

export interface ListIssueCommentsFilters {
  cursor?: string;        // last seen id for pagination (not strictly needed, since we expect O(100) per issue)
  sinceAt?: string;       // comments created after timestamp (used for run context injection)
  limit?: number;
  includeDeleted?: boolean;
}

export function listIssueComments(issueId: string, filters: ListIssueCommentsFilters = {}): IssueComment[] {
  const where: string[] = ['issue_id = ?'];
  const values: unknown[] = [issueId];
  if (!filters.includeDeleted) where.push('deleted_at IS NULL');
  if (filters.sinceAt) {
    where.push('(created_at > ? OR (updated_at IS NOT NULL AND updated_at > ?))');
    values.push(filters.sinceAt, filters.sinceAt);
  }
  if (filters.cursor) {
    where.push('id > ?');
    values.push(filters.cursor);
  }
  const limit = Math.max(1, Math.min(500, filters.limit ?? 200));
  const whereSql = `WHERE ${where.join(' AND ')}`;
  const rows = db
    .prepare(`SELECT * FROM issue_comments ${whereSql} ORDER BY created_at ASC, id ASC LIMIT ?`)
    .all(...values, limit);
  return rows.map(mapIssueCommentRow);
}

export function updateIssueComment(id: string, body: string): IssueComment | undefined {
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE issue_comments SET body = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`,
  ).run(toUtf8String(body, 'issue_comments.body'), now, id);
  return getIssueCommentById(id);
}

export function softDeleteIssueComment(id: string): boolean {
  const now = new Date().toISOString();
  const result = db
    .prepare(`UPDATE issue_comments SET deleted_at = ?, body = '' WHERE id = ? AND deleted_at IS NULL`)
    .run(now, id);
  return result.changes > 0;
}

// Issue delete helper cascade: update deleteIssue to also wipe comments + events + notifications
// (existing deleteIssue at ~line 4206 handles attachments and runs — add comments, events, notifications)

export function cleanupOldDailyUsage(retentionDays = 90): number {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  const result = db
    .prepare('DELETE FROM daily_usage WHERE date < ?')
    .run(cutoff);
  return result.changes;
}

export function cleanupOldBillingAuditLog(retentionDays = 365): number {
  const cutoff = new Date(
    Date.now() - retentionDays * 24 * 60 * 60 * 1000,
  ).toISOString();
  const result = db
    .prepare('DELETE FROM billing_audit_log WHERE created_at < ?')
    .run(cutoff);
  return result.changes;
}

// --- Router state accessors ---

export function getRouterState(key: string): string | undefined {
  const row = db
    .prepare('SELECT value FROM router_state WHERE key = ?')
    .get(key) as { value: string } | undefined;
  return row?.value;
}

export function setRouterState(key: string, value: string): void {
  db.prepare(
    'INSERT OR REPLACE INTO router_state (key, value) VALUES (?, ?)',
  ).run(key, value);
}

export function deleteRouterState(key: string): void {
  db.prepare('DELETE FROM router_state WHERE key = ?').run(key);
}

export function getRouterStateByPrefix(
  prefix: string,
): Array<{ key: string; value: string }> {
  return db
    .prepare('SELECT key, value FROM router_state WHERE key LIKE ?')
    .all(`${prefix}%`) as Array<{ key: string; value: string }>;
}

// --- Session accessors ---

export function getSession(
  groupFolder: string,
  agentId?: string | null,
): string | undefined {
  const effectiveAgentId = agentId || '';
  const row = db
    .prepare(
      'SELECT session_id FROM sessions WHERE group_folder = ? AND agent_id = ?',
    )
    .get(groupFolder, effectiveAgentId) as { session_id: string } | undefined;
  return row?.session_id;
}

export function setSession(
  groupFolder: string,
  sessionId: string,
  agentId?: string | null,
): void {
  const effectiveAgentId = agentId || '';
  db.prepare(
    `INSERT INTO sessions (group_folder, session_id, agent_id) VALUES (?, ?, ?)
     ON CONFLICT(group_folder, agent_id) DO UPDATE SET session_id = excluded.session_id`,
  ).run(groupFolder, sessionId, effectiveAgentId);
}

export function getSessionWorkspaceSessionId(
  groupFolder: string,
  agentId?: string | null,
): string | undefined {
  const effectiveAgentId = agentId || '';
  const row = db
    .prepare(
      'SELECT workspace_session_id FROM sessions WHERE group_folder = ? AND agent_id = ?',
    )
    .get(groupFolder, effectiveAgentId) as
    | { workspace_session_id: string | null }
    | undefined;
  const value = row?.workspace_session_id?.trim();
  return value || undefined;
}

export function ensureSessionWorkspaceSessionId(
  groupFolder: string,
  agentId?: string | null,
): string {
  const existing = getSessionWorkspaceSessionId(groupFolder, agentId);
  if (existing) return existing;
  const effectiveAgentId = agentId || '';
  const workspaceSessionId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO sessions (group_folder, session_id, agent_id, workspace_session_id)
     VALUES (?, '', ?, ?)
     ON CONFLICT(group_folder, agent_id) DO UPDATE SET
       workspace_session_id = COALESCE(sessions.workspace_session_id, excluded.workspace_session_id)`,
  ).run(groupFolder, effectiveAgentId, workspaceSessionId);
  return getSessionWorkspaceSessionId(groupFolder, agentId) || workspaceSessionId;
}

export function deleteSession(
  groupFolder: string,
  agentId?: string | null,
): void {
  const effectiveAgentId = agentId || '';
  db.prepare(
    'DELETE FROM sessions WHERE group_folder = ? AND agent_id = ?',
  ).run(groupFolder, effectiveAgentId);
}

/**
 * Get the provider_id bound to a session (group_folder + agent_id).
 * Returns undefined if no row or no binding recorded.
 *
 * Used by ProviderPool sticky-selection: when resuming a Claude session that
 * already produced thinking blocks, route back to the same provider/account so
 * thinking-block signatures validate.
 */
export function getSessionProviderId(
  groupFolder: string,
  agentId?: string | null,
): string | undefined {
  const effectiveAgentId = agentId || '';
  const row = db
    .prepare(
      'SELECT provider_id FROM sessions WHERE group_folder = ? AND agent_id = ?',
    )
    .get(groupFolder, effectiveAgentId) as
    | { provider_id: string | null }
    | undefined;
  return row?.provider_id ?? undefined;
}

/**
 * Bind a session to a specific provider_id, or clear the binding (provider_id=null).
 * Upserts a sessions row if one does not yet exist (with empty session_id).
 */
export function setSessionProviderId(
  groupFolder: string,
  agentId: string | null | undefined,
  providerId: string | null,
): void {
  const effectiveAgentId = agentId || '';
  db.prepare(
    `INSERT INTO sessions (group_folder, session_id, agent_id, provider_id)
     VALUES (?, '', ?, ?)
     ON CONFLICT(group_folder, agent_id) DO UPDATE SET provider_id = excluded.provider_id`,
  ).run(groupFolder, effectiveAgentId, providerId);
}

export function deleteAllSessionsForFolder(groupFolder: string): void {
  db.prepare('DELETE FROM sessions WHERE group_folder = ?').run(groupFolder);
}

/**
 * Delete all session rows bound to the given provider_id.
 *
 * Used when a provider's protocol-level fields (anthropicBaseUrl /
 * anthropicModel) change: any session whose history contains thinking blocks /
 * model-specific framing produced by this provider must restart fresh,
 * otherwise resuming under the new config can fail with "Invalid signature in
 * thinking block" or "model mismatch" errors. Sessions bound to *other*
 * providers are left intact so unrelated sticky bindings survive a partial
 * config update — see issue #476.
 *
 * Returns the affected `group_folder` values so callers can also evict the
 * in-memory sessions cache and the row count for telemetry.
 */
export function deleteSessionsByProviderId(providerId: string): {
  deletedCount: number;
  affectedFolders: string[];
} {
  const tx = db.transaction((id: string) => {
    const rows = db
      .prepare(
        'SELECT DISTINCT group_folder FROM sessions WHERE provider_id = ?',
      )
      .all(id) as Array<{ group_folder: string }>;
    const affectedFolders = rows.map((r) => r.group_folder);
    const result = db
      .prepare('DELETE FROM sessions WHERE provider_id = ?')
      .run(id);
    return {
      deletedCount: result.changes,
      affectedFolders,
    };
  });
  return tx(providerId);
}

export function getAllSessions(): Record<string, string> {
  const rows = db
    .prepare(
      "SELECT group_folder, session_id FROM sessions WHERE agent_id = ''",
    )
    .all() as Array<{ group_folder: string; session_id: string }>;
  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.group_folder] = row.session_id;
  }
  return result;
}

// --- Registered group accessors ---

function parseExecutionMode(
  raw: string | null,
  context: string,
): ExecutionMode {
  if (raw === 'container' || raw === 'host') return raw;
  if (raw !== null && raw !== '') {
    console.warn(
      `Invalid execution_mode "${raw}" for ${context}, falling back to "container"`,
    );
  }
  return 'container';
}

function parseRuntimeProfile(
  raw: string | null,
): import('./types.js').AgentRuntimeProfile | undefined {
  if (
    raw === 'server-agent' ||
    raw === 'server-agent-device-tools' ||
    raw === 'device-cli-agent'
  ) {
    return raw;
  }
  return undefined;
}

/** Raw row shape from registered_groups table — single source of truth for column mapping. */
type RegisteredGroupRow = {
  jid: string;
  name: string;
  folder: string;
  added_at: string;
  container_config: string | null;
  execution_mode: string | null;
  custom_cwd: string | null;
  repo_id: string | null;
  repo_git_url: string | null;
  repo_main_branch: string | null;
  repo_device_path: string | null;
  visible_repo_mode: string | null;
  visible_repo_ids: string | null;
  init_source_path: string | null;
  init_git_url: string | null;
  created_by: string | null;
  is_home: number;
  selected_skills: string | null;
  target_agent_id: string | null;
  target_main_jid: string | null;
  reply_policy: string | null;
  require_mention: number;
  activation_mode: string | null;
  owner_im_id: string | null;
  mcp_mode: string | null;
  selected_mcps: string | null;
  conversation_source: string | null;
  conversation_nav_mode: string | null;
  binding_mode: string | null;
  feishu_chat_mode: string | null;
  feishu_group_message_type: string | null;
  sender_allowlist: string | null;
  runtime_profile: string | null;
  device_link_id: string | null;
  agent_client_id: string | null;
  agent_model: string | null;
  agent_access_scope: string | null;
  permission_mode: string | null;
  backend: string | null;
  execution_node: string | null;
};

/** Convert a raw DB row into a RegisteredGroup domain object. */
function parseGroupRow(
  row: RegisteredGroupRow,
): RegisteredGroup & { jid: string } {
  return {
    jid: row.jid,
    name: row.name,
    folder: row.folder,
    added_at: row.added_at,
    containerConfig: row.container_config
      ? JSON.parse(row.container_config)
      : undefined,
    executionMode: parseExecutionMode(row.execution_mode, `group ${row.jid}`),
    customCwd: row.custom_cwd ?? undefined,
    repoId: row.repo_id ?? undefined,
    repoGitUrl: row.repo_git_url ?? undefined,
    repoMainBranch: row.repo_main_branch ?? undefined,
    repoDevicePath: row.repo_device_path ?? undefined,
    visibleRepoMode:
      row.visible_repo_mode === 'selected' || row.visible_repo_mode === 'all'
        ? row.visible_repo_mode
        : undefined,
    visibleRepoIds:
      row.visible_repo_ids != null
        ? (JSON.parse(row.visible_repo_ids) as string[])
        : undefined,
    initSourcePath: row.init_source_path ?? undefined,
    initGitUrl: row.init_git_url ?? undefined,
    created_by: row.created_by ?? undefined,
    is_home: row.is_home === 1,
    target_agent_id: row.target_agent_id ?? undefined,
    target_main_jid: row.target_main_jid ?? undefined,
    reply_policy: row.reply_policy === 'mirror' ? 'mirror' : 'source_only',
    require_mention: row.require_mention === 1,
    activation_mode: parseActivationMode(row.activation_mode),
    owner_im_id: row.owner_im_id ?? undefined,
    conversation_source:
      row.conversation_source === 'feishu_thread' ? 'feishu_thread' : 'manual',
    conversation_nav_mode:
      row.conversation_nav_mode === 'vertical_threads'
        ? 'vertical_threads'
        : 'horizontal',
    binding_mode:
      row.binding_mode === 'thread_map' ? 'thread_map' : 'single_context',
    feishu_chat_mode: row.feishu_chat_mode ?? undefined,
    feishu_group_message_type: row.feishu_group_message_type ?? undefined,
    sender_allowlist:
      row.sender_allowlist != null
        ? (JSON.parse(row.sender_allowlist) as string[])
        : undefined,
    runtimeProfile: parseRuntimeProfile(row.runtime_profile),
    deviceLinkId: row.device_link_id ?? undefined,
    agentClientId: row.agent_client_id ?? undefined,
    agentModel: row.agent_model ?? undefined,
    agentAccessScope:
      row.agent_access_scope === 'all' || row.agent_access_scope === 'workspace'
        ? row.agent_access_scope
        : undefined,
    permissionMode:
      row.permission_mode === 'default' ||
      row.permission_mode === 'acceptEdits' ||
      row.permission_mode === 'bypassPermissions' ||
      row.permission_mode === 'plan'
        ? row.permission_mode
        : undefined,
    backend: row.backend ?? undefined,
    executionNode: row.execution_node ?? undefined,
  };
}

export const VALID_ACTIVATION_MODES = new Set([
  'auto',
  'always',
  'when_mentioned',
  'owner_mentioned',
  'disabled',
]);

function parseActivationMode(
  raw: string | null,
): 'auto' | 'always' | 'when_mentioned' | 'owner_mentioned' | 'disabled' {
  if (raw && VALID_ACTIVATION_MODES.has(raw))
    return raw as
      | 'auto'
      | 'always'
      | 'when_mentioned'
      | 'owner_mentioned'
      | 'disabled';
  return 'auto';
}

export function getRegisteredGroup(
  jid: string,
): (RegisteredGroup & { jid: string }) | undefined {
  const row = db
    .prepare('SELECT * FROM registered_groups WHERE jid = ?')
    .get(jid) as RegisteredGroupRow | undefined;
  if (!row) return undefined;
  return parseGroupRow(row);
}

export function setRegisteredGroup(jid: string, group: RegisteredGroup): void {
  db.prepare(
    `INSERT OR REPLACE INTO registered_groups (jid, name, folder, added_at, container_config, execution_mode, custom_cwd, repo_id, repo_git_url, repo_main_branch, repo_device_path, visible_repo_mode, visible_repo_ids, init_source_path, init_git_url, created_by, is_home, selected_skills, target_agent_id, target_main_jid, reply_policy, require_mention, activation_mode, owner_im_id, mcp_mode, selected_mcps, conversation_source, conversation_nav_mode, binding_mode, feishu_chat_mode, feishu_group_message_type, sender_allowlist, runtime_profile, device_link_id, agent_client_id, agent_model, agent_access_scope, permission_mode, backend, execution_node)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    jid,
    group.name,
    group.folder,
    group.added_at,
    group.containerConfig ? JSON.stringify(group.containerConfig) : null,
    group.executionMode ?? 'container',
    group.customCwd ?? null,
    group.repoId ?? null,
    group.repoGitUrl ?? null,
    group.repoMainBranch ?? null,
    group.repoDevicePath ?? null,
    group.visibleRepoMode ?? null,
    group.visibleRepoIds != null ? JSON.stringify(group.visibleRepoIds) : null,
    group.initSourcePath ?? null,
    group.initGitUrl ?? null,
    group.created_by ?? null,
    group.is_home ? 1 : 0,
    null, // selected_skills: deprecated, always null (user-level skills apply globally)
    group.target_agent_id ?? null,
    group.target_main_jid ?? null,
    group.reply_policy ?? 'source_only',
    group.require_mention === true ? 1 : 0,
    group.activation_mode ?? 'auto',
    group.owner_im_id ?? null,
    'inherit', // mcp_mode: deprecated, always inherit (user-level MCP applies globally)
    null, // selected_mcps: deprecated, always null
    group.conversation_source ?? 'manual',
    group.conversation_nav_mode ?? 'horizontal',
    group.binding_mode ?? 'single_context',
    group.feishu_chat_mode ?? null,
    group.feishu_group_message_type ?? null,
    group.sender_allowlist != null
      ? JSON.stringify(group.sender_allowlist)
      : null,
    group.runtimeProfile ?? null,
    group.deviceLinkId ?? null,
    group.agentClientId ?? null,
    group.agentModel ?? null,
    group.agentAccessScope ?? null,
    group.permissionMode ?? null,
    group.backend ?? null,
    group.executionNode ?? null,
  );
}

export function deleteRegisteredGroup(jid: string): void {
  db.prepare('DELETE FROM registered_groups WHERE jid = ?').run(jid);
}

export function moveWorkspaceFolderReferences(
  oldFolder: string,
  newFolder: string,
): void {
  if (!oldFolder || !newFolder || oldFolder === newFolder) return;
  const tx = db.transaction(() => {
    db.prepare('UPDATE group_members SET group_folder = ? WHERE group_folder = ?').run(
      newFolder,
      oldFolder,
    );
    db.prepare('UPDATE scheduled_tasks SET group_folder = ? WHERE group_folder = ?').run(
      newFolder,
      oldFolder,
    );
    db.prepare('UPDATE scheduled_tasks SET workspace_folder = ? WHERE workspace_folder = ?').run(
      newFolder,
      oldFolder,
    );
    db.prepare('UPDATE agents SET group_folder = ? WHERE group_folder = ?').run(
      newFolder,
      oldFolder,
    );
  });
  tx();
}

type ManagedRepoRow = {
  id: string;
  name: string;
  kind: string;
  git_url: string | null;
  main_branch: string | null;
  device_path: string | null;
  device_link_id: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
};

function parseManagedRepoRow(row: ManagedRepoRow): ManagedRepo {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind === 'device_path' ? 'device_path' : 'git',
    gitUrl: row.git_url ?? undefined,
    mainBranch: row.main_branch ?? undefined,
    devicePath: row.device_path ?? undefined,
    deviceLinkId: row.device_link_id ?? undefined,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createManagedRepo(input: {
  name: string;
  kind: ManagedRepoKind;
  gitUrl?: string;
  mainBranch?: string;
  devicePath?: string;
  deviceLinkId?: string;
  createdBy: string;
}): ManagedRepo {
  const now = new Date().toISOString();
  const repo: ManagedRepo = {
    id: `repo_${crypto.randomBytes(8).toString('hex')}`,
    name: input.name,
    kind: input.kind,
    gitUrl: input.gitUrl,
    mainBranch: input.mainBranch,
    devicePath: input.devicePath,
    deviceLinkId: input.deviceLinkId,
    createdBy: input.createdBy,
    createdAt: now,
    updatedAt: now,
  };
  db.prepare(
    `INSERT INTO repos (id, name, kind, git_url, main_branch, device_path, device_link_id, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    repo.id,
    repo.name,
    repo.kind,
    repo.gitUrl ?? null,
    repo.kind === 'git' ? (repo.mainBranch ?? null) : null,
    repo.devicePath ?? null,
    repo.deviceLinkId ?? null,
    repo.createdBy,
    repo.createdAt,
    repo.updatedAt,
  );
  return repo;
}

export function listManagedReposByUser(userId: string): ManagedRepo[] {
  const rows = db
    .prepare(
      'SELECT * FROM repos WHERE created_by = ? ORDER BY updated_at DESC, created_at DESC',
    )
    .all(userId) as ManagedRepoRow[];
  return rows.map(parseManagedRepoRow);
}

export function getManagedRepoById(id: string): ManagedRepo | undefined {
  const row = db.prepare('SELECT * FROM repos WHERE id = ?').get(id) as
    | ManagedRepoRow
    | undefined;
  return row ? parseManagedRepoRow(row) : undefined;
}

export function deleteManagedRepo(id: string, userId: string): boolean {
  const transaction = db.transaction(() => {
    const result = db
      .prepare('DELETE FROM repos WHERE id = ? AND created_by = ?')
      .run(id, userId);
    if (result.changes > 0) {
      db.prepare('DELETE FROM repo_knowledge_chunks WHERE repo_id = ? AND user_id = ?').run(id, userId);
      if (repoKnowledgeFtsAvailable) {
        db.prepare('DELETE FROM repo_knowledge_chunks_fts WHERE repo_id = ? AND user_id = ?').run(id, userId);
      }
      db.prepare('DELETE FROM repo_knowledge_graph_edges WHERE repo_id = ? AND user_id = ?').run(id, userId);
      db.prepare('DELETE FROM repo_knowledge_indexes WHERE repo_id = ? AND user_id = ?').run(id, userId);
      db.prepare('DELETE FROM repo_knowledge_runs WHERE repo_id = ? AND user_id = ?').run(id, userId);
    }
    return result.changes > 0;
  });
  return transaction();
}

type RepoKnowledgeIndexRow = {
  repo_id: string;
  user_id: string;
  status: string;
  source_revision: string | null;
  summary: string | null;
  stats_json: string | null;
  error: string | null;
  generated_at: string | null;
  updated_at: string;
};

type RepoKnowledgeRunRow = {
  id: string;
  repo_id: string;
  user_id: string;
  status: string;
  source_kind: string | null;
  execution_device_link_id: string | null;
  agent_client_id: string | null;
  upload_token_hash: string | null;
  files_uploaded_at: string | null;
  enabled_skills_json: string | null;
  timeline_json: string | null;
  stats_json: string | null;
  error: string | null;
  queued_at: string;
  started_at: string | null;
  completed_at: string | null;
  updated_at: string;
};

type RepoKnowledgeChunkRow = {
  id: string;
  repo_id: string;
  user_id: string;
  path: string;
  kind: string;
  name: string | null;
  language: string | null;
  start_line: number | null;
  end_line: number | null;
  content: string;
  keywords: string | null;
  metadata_json: string | null;
  updated_at: string;
};

type RepoKnowledgeGraphEdgeRow = {
  id: string;
  repo_id: string;
  user_id: string;
  from_path: string;
  to_path: string | null;
  edge_kind: string;
  symbol: string | null;
  package_name: string | null;
  source: string;
  metadata_json: string | null;
  updated_at: string;
};

function parseJsonObject(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function parseRepoKnowledgeIndexRow(row: RepoKnowledgeIndexRow): RepoKnowledgeIndex {
  const status: RepoKnowledgeStatus =
    row.status === 'indexing' || row.status === 'ready' || row.status === 'error'
      ? row.status
      : 'none';
  return {
    repoId: row.repo_id,
    userId: row.user_id,
    status,
    sourceRevision: row.source_revision ?? undefined,
    summary: row.summary ?? undefined,
    stats: parseJsonObject(row.stats_json),
    error: row.error ?? undefined,
    generatedAt: row.generated_at ?? undefined,
    updatedAt: row.updated_at,
  };
}

function parseJsonArray<T = unknown>(value: string | null | undefined): T[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function parseRepoKnowledgeRunRow(row: RepoKnowledgeRunRow): RepoKnowledgeRun {
  const status: RepoKnowledgeRunStatus =
    row.status === 'queued' || row.status === 'running' || row.status === 'uploading' || row.status === 'ready' || row.status === 'error'
      ? row.status
      : 'error';
  return {
    id: row.id,
    repoId: row.repo_id,
    userId: row.user_id,
    status,
    sourceKind: row.source_kind ?? undefined,
    executionDeviceLinkId: row.execution_device_link_id ?? undefined,
    agentClientId: row.agent_client_id ?? undefined,
    uploadTokenHash: row.upload_token_hash ?? undefined,
    filesUploadedAt: row.files_uploaded_at ?? undefined,
    enabledSkills: parseJsonArray<string>(row.enabled_skills_json),
    timeline: parseJsonArray<RepoKnowledgeRunMilestone>(row.timeline_json),
    stats: parseJsonObject(row.stats_json),
    error: row.error ?? undefined,
    queuedAt: row.queued_at,
    startedAt: row.started_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
    updatedAt: row.updated_at,
  };
}

function parseRepoKnowledgeChunkRow(row: RepoKnowledgeChunkRow): RepoKnowledgeChunk {
  const kind: RepoKnowledgeChunkKind =
    row.kind === 'overview' || row.kind === 'symbol' || row.kind === 'dependency' || row.kind === 'doc' || row.kind === 'graph'
      ? row.kind
      : 'file';
  return {
    id: row.id,
    repoId: row.repo_id,
    userId: row.user_id,
    path: row.path,
    kind,
    name: row.name ?? undefined,
    language: row.language ?? undefined,
    startLine: row.start_line ?? undefined,
    endLine: row.end_line ?? undefined,
    content: row.content,
    keywords: row.keywords ?? undefined,
    metadata: parseJsonObject(row.metadata_json),
    updatedAt: row.updated_at,
  };
}

function parseRepoKnowledgeGraphEdgeRow(row: RepoKnowledgeGraphEdgeRow): RepoKnowledgeGraphEdge {
  const edgeKind: RepoKnowledgeGraphEdgeKind =
    row.edge_kind === 'imports' ||
    row.edge_kind === 'imported_by' ||
    row.edge_kind === 'depends_on' ||
    row.edge_kind === 'exports' ||
    row.edge_kind === 'documents' ||
    row.edge_kind === 'references'
      ? row.edge_kind
      : 'references';
  return {
    id: row.id,
    repoId: row.repo_id,
    userId: row.user_id,
    fromPath: row.from_path,
    toPath: row.to_path ?? undefined,
    edgeKind,
    symbol: row.symbol ?? undefined,
    packageName: row.package_name ?? undefined,
    source: row.source,
    metadata: parseJsonObject(row.metadata_json),
    updatedAt: row.updated_at,
  };
}

export function getRepoKnowledgeIndex(
  repoId: string,
  userId: string,
): RepoKnowledgeIndex | undefined {
  const row = db
    .prepare('SELECT * FROM repo_knowledge_indexes WHERE repo_id = ? AND user_id = ?')
    .get(repoId, userId) as RepoKnowledgeIndexRow | undefined;
  return row ? parseRepoKnowledgeIndexRow(row) : undefined;
}

export function listRepoKnowledgeIndexesByUser(userId: string): RepoKnowledgeIndex[] {
  const rows = db
    .prepare('SELECT * FROM repo_knowledge_indexes WHERE user_id = ? ORDER BY updated_at DESC')
    .all(userId) as RepoKnowledgeIndexRow[];
  return rows.map(parseRepoKnowledgeIndexRow);
}

export function createRepoKnowledgeRun(input: {
  id: string;
  repoId: string;
  userId: string;
  status?: RepoKnowledgeRunStatus;
  sourceKind?: string;
  executionDeviceLinkId?: string;
  agentClientId?: string;
  uploadTokenHash?: string;
  enabledSkills?: string[];
  timeline?: RepoKnowledgeRunMilestone[];
  stats?: Record<string, unknown>;
  error?: string;
  queuedAt?: string;
  startedAt?: string;
}): RepoKnowledgeRun {
  const now = new Date().toISOString();
  const queuedAt = input.queuedAt ?? now;
  db.prepare(
    `INSERT INTO repo_knowledge_runs (
      id, repo_id, user_id, status, source_kind, execution_device_link_id, agent_client_id,
      upload_token_hash, enabled_skills_json, timeline_json,
      stats_json, error, queued_at, started_at, completed_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
  ).run(
    input.id,
    input.repoId,
    input.userId,
    input.status ?? 'queued',
    input.sourceKind ?? null,
    input.executionDeviceLinkId ?? null,
    input.agentClientId ?? null,
    input.uploadTokenHash ?? null,
    JSON.stringify(input.enabledSkills ?? []),
    JSON.stringify(input.timeline ?? []),
    JSON.stringify(input.stats ?? {}),
    input.error ?? null,
    queuedAt,
    input.startedAt ?? null,
    now,
  );
  return getRepoKnowledgeRun(input.id, input.userId)!;
}

export function getRepoKnowledgeRun(id: string, userId: string): RepoKnowledgeRun | undefined {
  const row = db
    .prepare('SELECT * FROM repo_knowledge_runs WHERE id = ? AND user_id = ?')
    .get(id, userId) as RepoKnowledgeRunRow | undefined;
  return row ? parseRepoKnowledgeRunRow(row) : undefined;
}

/** 通过一次性 upload token 查询（不校验 userId，用于上传端点；调用方自己校验 token） */
export function getRepoKnowledgeRunByUploadTokenHash(hash: string): RepoKnowledgeRun | undefined {
  if (!hash) return undefined;
  const row = db
    .prepare('SELECT * FROM repo_knowledge_runs WHERE upload_token_hash = ?')
    .get(hash) as RepoKnowledgeRunRow | undefined;
  return row ? parseRepoKnowledgeRunRow(row) : undefined;
}

export function appendRepoKnowledgeRunTimeline(
  id: string,
  userId: string,
  item: Omit<RepoKnowledgeRunMilestone, 't'> & { t?: string },
  limit = 500,
): RepoKnowledgeRun | undefined {
  const current = getRepoKnowledgeRun(id, userId);
  if (!current) return undefined;
  const milestone: RepoKnowledgeRunMilestone = {
    t: item.t ?? new Date().toISOString(),
    kind: item.kind,
    label: item.label,
    detail: item.detail,
  };
  const timeline = [...(current.timeline ?? []), milestone].slice(-limit);
  db.prepare(
    `UPDATE repo_knowledge_runs SET timeline_json = ?, updated_at = ? WHERE id = ? AND user_id = ?`,
  ).run(JSON.stringify(timeline), milestone.t, id, userId);
  return getRepoKnowledgeRun(id, userId);
}

export function updateRepoKnowledgeRun(
  id: string,
  userId: string,
  patch: {
    status?: RepoKnowledgeRunStatus;
    stats?: Record<string, unknown>;
    error?: string | null;
    startedAt?: string | null;
    completedAt?: string | null;
    filesUploadedAt?: string | null;
    uploadTokenHash?: string | null;
    agentClientId?: string | null;
    executionDeviceLinkId?: string | null;
    enabledSkills?: string[];
    updatedAt?: string;
  },
): RepoKnowledgeRun | undefined {
  const current = getRepoKnowledgeRun(id, userId);
  if (!current) return undefined;
  const updatedAt = patch.updatedAt ?? new Date().toISOString();
  db.prepare(
    `UPDATE repo_knowledge_runs SET
      status = ?, stats_json = ?, error = ?, started_at = ?, completed_at = ?,
      files_uploaded_at = ?, upload_token_hash = ?, agent_client_id = ?,
      execution_device_link_id = ?, enabled_skills_json = ?, updated_at = ?
     WHERE id = ? AND user_id = ?`,
  ).run(
    patch.status ?? current.status,
    JSON.stringify(patch.stats ?? current.stats ?? {}),
    patch.error === undefined ? current.error ?? null : patch.error,
    patch.startedAt === undefined ? current.startedAt ?? null : patch.startedAt,
    patch.completedAt === undefined ? current.completedAt ?? null : patch.completedAt,
    patch.filesUploadedAt === undefined ? current.filesUploadedAt ?? null : patch.filesUploadedAt,
    patch.uploadTokenHash === undefined ? current.uploadTokenHash ?? null : patch.uploadTokenHash,
    patch.agentClientId === undefined ? current.agentClientId ?? null : patch.agentClientId,
    patch.executionDeviceLinkId === undefined ? current.executionDeviceLinkId ?? null : patch.executionDeviceLinkId,
    JSON.stringify(patch.enabledSkills ?? current.enabledSkills ?? []),
    updatedAt,
    id,
    userId,
  );
  return getRepoKnowledgeRun(id, userId);
}

export function listRepoKnowledgeRuns(input: {
  repoId: string;
  userId: string;
  limit?: number;
}): RepoKnowledgeRun[] {
  const limit = Math.max(1, Math.min(input.limit ?? 20, 100));
  const rows = db
    .prepare('SELECT * FROM repo_knowledge_runs WHERE repo_id = ? AND user_id = ? ORDER BY queued_at DESC LIMIT ?')
    .all(input.repoId, input.userId, limit) as RepoKnowledgeRunRow[];
  return rows.map(parseRepoKnowledgeRunRow);
}

export function upsertRepoKnowledgeIndex(input: {
  repoId: string;
  userId: string;
  status: RepoKnowledgeStatus;
  sourceRevision?: string;
  summary?: string;
  stats?: Record<string, unknown>;
  error?: string;
  generatedAt?: string;
  updatedAt?: string;
}): RepoKnowledgeIndex {
  const updatedAt = input.updatedAt ?? new Date().toISOString();
  db.prepare(
    `INSERT INTO repo_knowledge_indexes (
      repo_id, user_id, status, source_revision, summary, stats_json, error, generated_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(repo_id) DO UPDATE SET
      user_id = excluded.user_id,
      status = excluded.status,
      source_revision = excluded.source_revision,
      summary = excluded.summary,
      stats_json = excluded.stats_json,
      error = excluded.error,
      generated_at = excluded.generated_at,
      updated_at = excluded.updated_at
    WHERE repo_knowledge_indexes.user_id = excluded.user_id`,
  ).run(
    input.repoId,
    input.userId,
    input.status,
    input.sourceRevision ?? null,
    input.summary ?? null,
    JSON.stringify(input.stats ?? {}),
    input.error ?? null,
    input.generatedAt ?? null,
    updatedAt,
  );
  return getRepoKnowledgeIndex(input.repoId, input.userId)!;
}

export function replaceRepoKnowledgeChunks(input: {
  repoId: string;
  userId: string;
  chunks: Array<Omit<RepoKnowledgeChunk, 'updatedAt' | 'repoId' | 'userId'>>;
  edges?: Array<Omit<RepoKnowledgeGraphEdge, 'updatedAt' | 'repoId' | 'userId'>>;
}): void {
  const now = new Date().toISOString();
  const transaction = db.transaction(() => {
    db.prepare('DELETE FROM repo_knowledge_chunks WHERE repo_id = ? AND user_id = ?').run(input.repoId, input.userId);
    db.prepare('DELETE FROM repo_knowledge_graph_edges WHERE repo_id = ? AND user_id = ?').run(input.repoId, input.userId);
    if (repoKnowledgeFtsAvailable) {
      db.prepare('DELETE FROM repo_knowledge_chunks_fts WHERE repo_id = ? AND user_id = ?').run(input.repoId, input.userId);
    }
    const insert = db.prepare(
      `INSERT OR REPLACE INTO repo_knowledge_chunks (
        id, repo_id, user_id, path, kind, name, language, start_line, end_line, content, keywords, metadata_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const chunk of input.chunks) {
      insert.run(
        chunk.id,
        input.repoId,
        input.userId,
        chunk.path,
        chunk.kind,
        chunk.name ?? null,
        chunk.language ?? null,
        chunk.startLine ?? null,
        chunk.endLine ?? null,
        chunk.content,
        chunk.keywords ?? null,
        JSON.stringify(chunk.metadata ?? {}),
        now,
      );
    }
    if (repoKnowledgeFtsAvailable) {
      const insertFts = db.prepare(
        `INSERT OR REPLACE INTO repo_knowledge_chunks_fts (
          chunk_id, repo_id, user_id, path, kind, name, language, keywords, content
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const chunk of input.chunks) {
        insertFts.run(
          chunk.id,
          input.repoId,
          input.userId,
          chunk.path,
          chunk.kind,
          chunk.name ?? '',
          chunk.language ?? '',
          chunk.keywords ?? '',
          chunk.content,
        );
      }
    }
    const insertEdge = db.prepare(
      `INSERT OR IGNORE INTO repo_knowledge_graph_edges (
        id, repo_id, user_id, from_path, to_path, edge_kind, symbol, package_name, source, metadata_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const edge of input.edges ?? []) {
      insertEdge.run(
        edge.id,
        input.repoId,
        input.userId,
        edge.fromPath,
        edge.toPath ?? null,
        edge.edgeKind,
        edge.symbol ?? null,
        edge.packageName ?? null,
        edge.source,
        JSON.stringify(edge.metadata ?? {}),
        now,
      );
    }
  });
  transaction();
}

export function getRepoKnowledgeChunk(
  chunkId: string,
  userId: string,
): RepoKnowledgeChunk | undefined {
  const row = db
    .prepare('SELECT * FROM repo_knowledge_chunks WHERE id = ? AND user_id = ?')
    .get(chunkId, userId) as RepoKnowledgeChunkRow | undefined;
  return row ? parseRepoKnowledgeChunkRow(row) : undefined;
}

export function listRepoKnowledgeChunks(input: {
  repoId: string;
  userId: string;
  path?: string;
  kind?: RepoKnowledgeChunkKind;
  language?: string;
  pathPrefix?: string;
  limit?: number;
}): RepoKnowledgeChunk[] {
  const limit = Math.max(1, Math.min(input.limit ?? 100, 500));
  const where = ['repo_id = ?', 'user_id = ?'];
  const args: unknown[] = [input.repoId, input.userId];
  if (input.path) {
    where.push('path = ?');
    args.push(input.path);
  }
  if (input.kind) {
    where.push('kind = ?');
    args.push(input.kind);
  }
  if (input.language) {
    where.push('language = ?');
    args.push(input.language);
  }
  if (input.pathPrefix) {
    where.push('path LIKE ?');
    args.push(`${input.pathPrefix.replace(/[%_]/g, '\\$&')}%`);
  }
  args.push(limit);
  const rows = db
    .prepare(
      `SELECT * FROM repo_knowledge_chunks
       WHERE ${where.join(' AND ')}
       ORDER BY kind ASC, path ASC, start_line IS NULL, start_line ASC
       LIMIT ?`,
    )
    .all(...args) as RepoKnowledgeChunkRow[];
  return rows.map(parseRepoKnowledgeChunkRow);
}

export function listRepoKnowledgeGraphEdges(input: {
  repoId: string;
  userId: string;
  path?: string;
  edgeKind?: RepoKnowledgeGraphEdgeKind;
  packageName?: string;
  limit?: number;
}): RepoKnowledgeGraphEdge[] {
  const limit = Math.max(1, Math.min(input.limit ?? 100, 500));
  const where = ['repo_id = ?', 'user_id = ?'];
  const args: unknown[] = [input.repoId, input.userId];
  if (input.path) {
    where.push('(from_path = ? OR to_path = ?)');
    args.push(input.path, input.path);
  }
  if (input.edgeKind) {
    where.push('edge_kind = ?');
    args.push(input.edgeKind);
  }
  if (input.packageName) {
    where.push('package_name = ?');
    args.push(input.packageName);
  }
  args.push(limit);
  const rows = db
    .prepare(
      `SELECT * FROM repo_knowledge_graph_edges
       WHERE ${where.join(' AND ')}
       ORDER BY edge_kind ASC, from_path ASC, to_path ASC
       LIMIT ?`,
    )
    .all(...args) as RepoKnowledgeGraphEdgeRow[];
  return rows.map(parseRepoKnowledgeGraphEdgeRow);
}

export function listRelatedRepoKnowledge(input: {
  repoId: string;
  userId: string;
  path?: string;
  chunkId?: string;
  limit?: number;
}): { edges: RepoKnowledgeGraphEdge[]; chunks: RepoKnowledgeChunk[] } {
  const chunk = input.chunkId ? getRepoKnowledgeChunk(input.chunkId, input.userId) : undefined;
  const pathRef = input.path ?? chunk?.path;
  if (!pathRef) return { edges: [], chunks: [] };
  const edges = listRepoKnowledgeGraphEdges({
    repoId: input.repoId,
    userId: input.userId,
    path: pathRef,
    limit: input.limit,
  });
  const relatedPaths = Array.from(new Set(edges.flatMap((edge) => [edge.fromPath, edge.toPath].filter(Boolean) as string[]))).filter((p) => p !== pathRef);
  const chunks = relatedPaths.slice(0, Math.max(1, Math.min(input.limit ?? 20, 50))).flatMap((pathName) =>
    listRepoKnowledgeChunks({ repoId: input.repoId, userId: input.userId, path: pathName, limit: 3 }),
  );
  return { edges, chunks };
}

export function getRepoKnowledgeContext(input: {
  repoId: string;
  userId: string;
  chunkId?: string;
  path?: string;
  query?: string;
  limit?: number;
}): {
  anchor?: RepoKnowledgeChunk;
  sameFileChunks: RepoKnowledgeChunk[];
  relatedChunks: RepoKnowledgeChunk[];
  edges: RepoKnowledgeGraphEdge[];
  dependencies: RepoKnowledgeChunk[];
  docs: RepoKnowledgeChunk[];
} {
  const limit = Math.max(1, Math.min(input.limit ?? 20, 80));
  const anchor = input.chunkId
    ? getRepoKnowledgeChunk(input.chunkId, input.userId)
    : input.query
      ? searchRepoKnowledge({ repoId: input.repoId, userId: input.userId, query: input.query, limit: 1 })[0]
      : input.path
        ? listRepoKnowledgeChunks({ repoId: input.repoId, userId: input.userId, path: input.path, limit: 1 })[0]
        : undefined;
  const pathRef = input.path ?? anchor?.path;
  if (!pathRef) {
    return { anchor, sameFileChunks: [], relatedChunks: [], edges: [], dependencies: [], docs: [] };
  }
  const sameFileChunks = listRepoKnowledgeChunks({
    repoId: input.repoId,
    userId: input.userId,
    path: pathRef,
    limit,
  });
  const related = listRelatedRepoKnowledge({
    repoId: input.repoId,
    userId: input.userId,
    path: pathRef,
    limit,
  });
  const dependencies = [
    ...sameFileChunks.filter((chunk) => chunk.kind === 'dependency'),
    ...related.chunks.filter((chunk) => chunk.kind === 'dependency'),
  ].slice(0, Math.min(limit, 20));
  const docs = [
    ...sameFileChunks.filter((chunk) => chunk.kind === 'doc'),
    ...related.chunks.filter((chunk) => chunk.kind === 'doc'),
  ].slice(0, Math.min(limit, 20));
  return {
    anchor,
    sameFileChunks,
    relatedChunks: related.chunks.slice(0, limit),
    edges: related.edges.slice(0, limit),
    dependencies,
    docs,
  };
}

function scoreKnowledgeChunk(chunk: RepoKnowledgeChunk, terms: string[]): number {
  const haystack = [chunk.name, chunk.path, chunk.language, chunk.keywords, chunk.content]
    .filter(Boolean)
    .join('\n')
    .toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (!term) continue;
    const occurrences = haystack.split(term).length - 1;
    score += occurrences;
    if (chunk.path.toLowerCase().includes(term)) score += 3;
    if (chunk.name?.toLowerCase().includes(term)) score += 4;
    if (chunk.keywords?.toLowerCase().includes(term)) score += 2;
  }
  if (chunk.kind === 'overview') score += 1;
  return score;
}

function buildKnowledgeSnippet(content: string, terms: string[], maxLength = 700): string {
  const lower = content.toLowerCase();
  const firstHit = terms
    .map((term) => lower.indexOf(term))
    .filter((idx) => idx >= 0)
    .sort((a, b) => a - b)[0];
  const start = firstHit == null ? 0 : Math.max(0, firstHit - 180);
  const snippet = content.slice(start, start + maxLength).trim();
  return `${start > 0 ? '…' : ''}${snippet}${start + maxLength < content.length ? '…' : ''}`;
}

function escapeFtsTerm(term: string): string {
  return term.replace(/"/g, '""');
}

function buildRepoKnowledgeFtsQuery(terms: string[]): string {
  return terms.map((term) => `"${escapeFtsTerm(term)}"*`).join(' OR ');
}

export function isRepoKnowledgeFtsAvailable(): boolean {
  return repoKnowledgeFtsAvailable;
}

export function searchRepoKnowledge(input: {
  repoId?: string;
  userId: string;
  query: string;
  limit?: number;
  kind?: RepoKnowledgeChunkKind;
  language?: string;
  pathPrefix?: string;
  includeRelated?: boolean;
}): RepoKnowledgeSearchHit[] {
  const terms = input.query
    .toLowerCase()
    .split(/[^\p{L}\p{N}_./:-]+/u)
    .map((term) => term.trim())
    .filter((term) => term.length >= 2)
    .slice(0, 12);
  if (terms.length === 0) return [];
  const limit = Math.max(1, Math.min(input.limit ?? 20, 100));
  if (repoKnowledgeFtsAvailable) {
    try {
      const where = ['repo_knowledge_chunks_fts.user_id = ?'];
      const args: unknown[] = [input.userId];
      if (input.repoId) {
        where.push('repo_knowledge_chunks_fts.repo_id = ?');
        args.push(input.repoId);
      }
      if (input.kind) {
        where.push('c.kind = ?');
        args.push(input.kind);
      }
      if (input.language) {
        where.push('c.language = ?');
        args.push(input.language);
      }
      if (input.pathPrefix) {
        where.push('c.path LIKE ?');
        args.push(`${input.pathPrefix.replace(/[%_]/g, '\\$&')}%`);
      }
      args.push(buildRepoKnowledgeFtsQuery(terms), Math.max(limit * 8, 80));
      const rows = db
        .prepare(
          `SELECT c.*
           FROM repo_knowledge_chunks_fts
           JOIN repo_knowledge_chunks c ON c.id = repo_knowledge_chunks_fts.chunk_id
           WHERE ${where.join(' AND ')} AND repo_knowledge_chunks_fts MATCH ?
           ORDER BY bm25(repo_knowledge_chunks_fts) ASC
           LIMIT ?`,
        )
        .all(...args) as RepoKnowledgeChunkRow[];
      return rows
        .map(parseRepoKnowledgeChunkRow)
        .map((chunk) => ({
          ...chunk,
          score: scoreKnowledgeChunk(chunk, terms) + 5,
          snippet: buildKnowledgeSnippet(chunk.content, terms),
          related: input.includeRelated && input.repoId
            ? listRepoKnowledgeGraphEdges({ repoId: input.repoId, userId: input.userId, path: chunk.path, limit: 10 })
            : undefined,
        }))
        .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
        .slice(0, limit);
    } catch (err) {
      logger.warn({ err }, 'Repo knowledge FTS query failed; falling back to LIKE search');
    }
  }
  const where = ['user_id = ?'];
  const args: unknown[] = [input.userId];
  if (input.repoId) {
    where.push('repo_id = ?');
    args.push(input.repoId);
  }
  if (input.kind) {
    where.push('kind = ?');
    args.push(input.kind);
  }
  if (input.language) {
    where.push('language = ?');
    args.push(input.language);
  }
  if (input.pathPrefix) {
    where.push('path LIKE ?');
    args.push(`${input.pathPrefix.replace(/[%_]/g, '\\$&')}%`);
  }
  const like = `%${terms[0].replace(/[%_]/g, '\\$&')}%`;
  where.push('(path LIKE ? OR name LIKE ? OR keywords LIKE ? OR content LIKE ?)');
  args.push(like, like, like, like);
  const rows = db
    .prepare(`SELECT * FROM repo_knowledge_chunks WHERE ${where.join(' AND ')} LIMIT 1000`)
    .all(...args) as RepoKnowledgeChunkRow[];
  return rows
    .map(parseRepoKnowledgeChunkRow)
    .map((chunk) => ({
      ...chunk,
      score: scoreKnowledgeChunk(chunk, terms),
      snippet: buildKnowledgeSnippet(chunk.content, terms),
      related: input.includeRelated && input.repoId
        ? listRepoKnowledgeGraphEdges({ repoId: input.repoId, userId: input.userId, path: chunk.path, limit: 10 })
        : undefined,
    }))
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, limit);
}

/**
 * Find groups owned by `userId` whose sender_allowlist is the empty array `[]` —
 * the "owner-locked trap" state where no one (not even the owner) can trigger
 * the bot. Created by buildOnNewChat when a Feishu group is auto-registered
 * before the owner has DM'd the bot. Used by Feishu owner backfill.
 */
export function findEmptyAllowlistFeishuGroupsForUser(
  userId: string,
): string[] {
  const rows = db
    .prepare(
      "SELECT jid FROM registered_groups WHERE created_by = ? AND jid LIKE 'feishu:%' AND sender_allowlist = '[]'",
    )
    .all(userId) as Array<{ jid: string }>;
  return rows.map((r) => r.jid);
}

/**
 * Replace empty `sender_allowlist=[]` with `[ownerOpenId]` for the user's
 * Feishu groups. Returns the JIDs that were updated. Run once when the
 * Feishu owner is first identified via P2P DM, to unstick groups that were
 * registered before the owner was known.
 */
export function backfillEmptyAllowlistsForUser(
  userId: string,
  ownerOpenId: string,
): string[] {
  const jids = findEmptyAllowlistFeishuGroupsForUser(userId);
  if (jids.length === 0) return [];
  const allowlistJson = JSON.stringify([ownerOpenId]);
  const stmt = db.prepare(
    'UPDATE registered_groups SET sender_allowlist = ? WHERE jid = ?',
  );
  const tx = db.transaction((targets: string[]) => {
    for (const jid of targets) stmt.run(allowlistJson, jid);
  });
  tx(jids);
  return jids;
}

/**
 * Clear `sender_allowlist` for a single group (set to NULL = unrestricted).
 * Used as a manual escape hatch from the owner-locked trap.
 */
export function clearSenderAllowlist(jid: string): void {
  db.prepare(
    'UPDATE registered_groups SET sender_allowlist = NULL WHERE jid = ?',
  ).run(jid);
}

/** Get all JIDs that share the same folder (e.g., all JIDs with folder='main'). */
export function getJidsByFolder(folder: string): string[] {
  const rows = db
    .prepare('SELECT jid FROM registered_groups WHERE folder = ?')
    .all(folder) as Array<{ jid: string }>;
  return rows.map((r) => r.jid);
}

/** Check if any registered group uses container execution mode (efficient targeted query). */
export function hasContainerModeGroups(): boolean {
  const row = db
    .prepare(
      "SELECT 1 FROM registered_groups WHERE execution_mode = 'container' OR execution_mode IS NULL LIMIT 1",
    )
    .get();
  return row !== undefined;
}

export function getAllRegisteredGroups(): Record<string, RegisteredGroup> {
  const rows = db
    .prepare('SELECT * FROM registered_groups')
    .all() as RegisteredGroupRow[];
  const result: Record<string, RegisteredGroup> = {};
  for (const row of rows) {
    result[row.jid] = parseGroupRow(row);
  }
  return result;
}

/**
 * Get all registered groups that route to a specific conversation agent.
 * Returns array of { jid, group } for each IM group targeting the given agentId.
 */
export function getGroupsByTargetAgent(
  agentId: string,
): Array<{ jid: string; group: RegisteredGroup }> {
  const rows = db
    .prepare('SELECT * FROM registered_groups WHERE target_agent_id = ?')
    .all(agentId) as RegisteredGroupRow[];
  return rows.map((row) => ({ jid: row.jid, group: parseGroupRow(row) }));
}

/**
 * Get all registered groups that route to a specific workspace's main conversation.
 */
export function getGroupsByTargetMainJid(
  webJid: string,
): Array<{ jid: string; group: RegisteredGroup }> {
  const rows = db
    .prepare('SELECT * FROM registered_groups WHERE target_main_jid = ?')
    .all(webJid) as RegisteredGroupRow[];
  return rows.map((row) => ({ jid: row.jid, group: parseGroupRow(row) }));
}

function mapImContextBindingRow(
  row: Record<string, unknown>,
): ImContextBinding {
  return {
    source_jid: String(row.source_jid),
    context_type: 'thread',
    context_id: String(row.context_id),
    workspace_jid: String(row.workspace_jid),
    agent_id: String(row.agent_id),
    root_message_id:
      typeof row.root_message_id === 'string' ? row.root_message_id : null,
    title: typeof row.title === 'string' ? row.title : null,
    last_active_at: String(row.last_active_at),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

export function getImContextBinding(
  sourceJid: string,
  contextType: 'thread',
  contextId: string,
): ImContextBinding | undefined {
  const row = db
    .prepare(
      'SELECT * FROM im_context_bindings WHERE source_jid = ? AND context_type = ? AND context_id = ?',
    )
    .get(sourceJid, contextType, contextId) as
    | Record<string, unknown>
    | undefined;
  return row ? mapImContextBindingRow(row) : undefined;
}

export function upsertImContextBinding(binding: ImContextBinding): void {
  db.prepare(
    `INSERT INTO im_context_bindings (
      source_jid, context_type, context_id, workspace_jid, agent_id,
      root_message_id, title, last_active_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source_jid, context_type, context_id) DO UPDATE SET
      workspace_jid = excluded.workspace_jid,
      agent_id = excluded.agent_id,
      -- COALESCE: 首条消息设定 root_message_id/title 后，后续消息传 null 不会覆盖
      root_message_id = COALESCE(excluded.root_message_id, im_context_bindings.root_message_id),
      title = COALESCE(excluded.title, im_context_bindings.title),
      last_active_at = excluded.last_active_at,
      updated_at = excluded.updated_at`,
  ).run(
    binding.source_jid,
    binding.context_type,
    binding.context_id,
    binding.workspace_jid,
    binding.agent_id,
    binding.root_message_id,
    binding.title,
    binding.last_active_at,
    binding.created_at,
    binding.updated_at,
  );
}

export function listImContextBindingsByWorkspace(
  workspaceJid: string,
): ImContextBinding[] {
  const rows = db
    .prepare(
      'SELECT * FROM im_context_bindings WHERE workspace_jid = ? ORDER BY last_active_at DESC, created_at DESC',
    )
    .all(workspaceJid) as Record<string, unknown>[];
  return rows.map(mapImContextBindingRow);
}

export function deleteImContextBindingsByWorkspace(workspaceJid: string): void {
  db.prepare('DELETE FROM im_context_bindings WHERE workspace_jid = ?').run(
    workspaceJid,
  );
}

export function deleteImContextBindingsByAgent(agentId: string): void {
  db.prepare('DELETE FROM im_context_bindings WHERE agent_id = ?').run(agentId);
}

/** Lightweight update: only touch last_active_at + updated_at on an existing binding. */
export function touchImContextBindingActivity(
  sourceJid: string,
  contextType: 'thread',
  contextId: string,
  lastActiveAt: string,
): void {
  db.prepare(
    'UPDATE im_context_bindings SET last_active_at = ?, updated_at = ? WHERE source_jid = ? AND context_type = ? AND context_id = ?',
  ).run(lastActiveAt, lastActiveAt, sourceJid, contextType, contextId);
}

/** List feishu_thread agent IDs for a workspace JID (for cleanup on unbind). */
export function listFeishuThreadAgentIds(workspaceJid: string): string[] {
  const rows = db
    .prepare(
      "SELECT id FROM agents WHERE chat_jid = ? AND source_kind = 'feishu_thread'",
    )
    .all(workspaceJid) as { id: string }[];
  return rows.map((r) => r.id);
}

/**
 * Find a user's home group (is_home=1 + created_by=userId).
 * For admin users, also matches web:main even if created_by differs
 * (all admins share folder=main).
 */
export function getUserHomeGroup(
  userId: string,
): (RegisteredGroup & { jid: string }) | undefined {
  // First try exact match: is_home=1 AND created_by=userId
  let row = db
    .prepare(
      'SELECT * FROM registered_groups WHERE is_home = 1 AND created_by = ?',
    )
    .get(userId) as RegisteredGroupRow | undefined;

  // Fallback for admin users: all admins share web:main (folder=main).
  // If no exact match, check if the user is an admin and web:main exists.
  if (!row) {
    const user = db
      .prepare("SELECT role FROM users WHERE id = ? AND status = 'active'")
      .get(userId) as { role: string } | undefined;
    if (user?.role === 'admin') {
      row = db
        .prepare(
          "SELECT * FROM registered_groups WHERE jid = 'web:main' AND is_home = 1",
        )
        .get() as RegisteredGroupRow | undefined;
    }
  }

  if (!row) return undefined;
  return parseGroupRow(row);
}

/**
 * Ensure a user has a home group. If not, create one.
 * Admin gets folder='main' with executionMode='host'.
 * Member gets folder='home-{userId}' with executionMode='container'.
 * Returns the JID of the home group.
 */
export function ensureUserHomeGroup(
  userId: string,
  role: 'admin' | 'member',
  username?: string,
): string {
  const existing = getUserHomeGroup(userId);
  if (existing) return existing.jid;

  const now = new Date().toISOString();
  const isAdmin = role === 'admin';
  const jid = isAdmin ? 'web:main' : `web:home-${userId}`;
  const folder = isAdmin ? 'main' : `home-${userId}`;

  // For admin: check if web:main already exists (created by another admin)
  // In that case, reuse it rather than overwriting created_by
  if (isAdmin) {
    const existingMain = getRegisteredGroup(jid);
    if (existingMain) {
      // web:main already exists.
      // Ensure is_home, created_by, and executionMode are correct for owner-based routing.
      const patched = { ...existingMain };
      let changed = false;
      if (!patched.is_home) {
        patched.is_home = true;
        changed = true;
      }
      if (!patched.created_by) {
        patched.created_by = userId;
        changed = true;
      }
      // Admin home container must use host mode
      if (patched.executionMode !== 'host') {
        patched.executionMode = 'host';
        changed = true;
      }
      if (changed) {
        setRegisteredGroup(jid, patched);
      }
      ensureChatExists(jid);
      return jid;
    }
  }

  const name = username ? `${username} Home` : isAdmin ? 'Main' : 'Home';

  const group: RegisteredGroup = {
    name,
    folder,
    added_at: now,
    executionMode: isAdmin ? 'host' : 'container',
    created_by: userId,
    is_home: true,
  };

  setRegisteredGroup(jid, group);

  // Ensure chat row exists
  ensureChatExists(jid);

  // Create user-global memory directory and initialize CLAUDE.md from template
  const userGlobalDir = path.join(GROUPS_DIR, 'user-global', userId);
  fs.mkdirSync(userGlobalDir, { recursive: true });
  const userClaudeMd = path.join(userGlobalDir, 'CLAUDE.md');
  if (!fs.existsSync(userClaudeMd)) {
    const templatePath = path.resolve(
      process.cwd(),
      'config',
      'global-claude-md.template.md',
    );
    if (fs.existsSync(templatePath)) {
      try {
        fs.writeFileSync(userClaudeMd, fs.readFileSync(templatePath, 'utf-8'), {
          flag: 'wx',
        });
      } catch {
        // EEXIST race or read error — ignore
      }
    }
  }

  return jid;
}

export function deleteChatHistory(chatJid: string): void {
  const tx = db.transaction((jid: string) => {
    archiveChatRecord(jid, 'chat_history_deleted');
    db.prepare('DELETE FROM messages WHERE chat_jid = ?').run(jid);
  });
  tx(chatJid);
}

/**
 * Delete an IM group's registered_groups entry and all jid-scoped data
 * (messages, chat record, pinned references). Does NOT touch folder-scoped
 * data (sessions, scheduled_tasks, group_members) because IM groups typically
 * share their folder with the owner's home workspace.
 *
 * Used when an IM group is detected as dead (bot removed, group disbanded,
 * health-check unreachable, or repeated send failures) and for the manual
 * "delete this IM binding" UI button.
 */
export function deleteImGroupRecord(jid: string): void {
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM registered_groups WHERE jid = ?').run(jid);
    archiveChatRecord(jid, 'im_group_deleted');
    db.prepare('DELETE FROM messages WHERE chat_jid = ?').run(jid);
    db.prepare('DELETE FROM user_pinned_groups WHERE jid = ?').run(jid);
    // Feishu thread agents (source_kind='feishu_thread') and other chat-scoped
    // agents reference this jid via agents.chat_jid — without this, deleting
    // an IM group leaves orphan agent rows visible in the agents list.
    db.prepare('DELETE FROM agents WHERE chat_jid = ?').run(jid);
    db.prepare(
      'UPDATE scheduled_tasks SET workspace_jid = NULL, workspace_folder = NULL WHERE workspace_jid = ?',
    ).run(jid);
  });
  tx();
}

export function deleteGroupData(jid: string, folder: string): void {
  const tx = db.transaction(() => {
    // 1. 删除定时任务运行日志 + 定时任务
    db.prepare(
      'DELETE FROM task_run_logs WHERE task_id IN (SELECT id FROM scheduled_tasks WHERE group_folder = ?)',
    ).run(folder);
    db.prepare('DELETE FROM scheduled_tasks WHERE group_folder = ?').run(
      folder,
    );
    // 2. 删除成员记录
    db.prepare('DELETE FROM group_members WHERE group_folder = ?').run(folder);
    // 3. 删除注册信息
    db.prepare('DELETE FROM registered_groups WHERE jid = ?').run(jid);
    // 4. 删除会话
    db.prepare('DELETE FROM sessions WHERE group_folder = ?').run(folder);
    // 5. 删除聊天记录（归档 + 真删消息行）
    archiveChatRecord(jid, 'group_deleted');
    db.prepare('DELETE FROM messages WHERE chat_jid = ?').run(jid);
    // 6. 删除 pin 记录
    db.prepare('DELETE FROM user_pinned_groups WHERE jid = ?').run(jid);
    // 7. 清除定时任务的工作区关联（任务本身不删，只断开绑定）
    db.prepare(
      'UPDATE scheduled_tasks SET workspace_jid = NULL, workspace_folder = NULL WHERE workspace_jid = ?',
    ).run(jid);
  });
  tx();
}

// --- User pinned groups ---

export function getUserPinnedGroups(userId: string): Record<string, string> {
  const rows = db
    .prepare('SELECT jid, pinned_at FROM user_pinned_groups WHERE user_id = ?')
    .all(userId) as Array<{ jid: string; pinned_at: string }>;
  const result: Record<string, string> = {};
  for (const row of rows) result[row.jid] = row.pinned_at;
  return result;
}

export function pinGroup(userId: string, jid: string): string {
  const pinned_at = new Date().toISOString();
  db.prepare(
    'INSERT OR REPLACE INTO user_pinned_groups (user_id, jid, pinned_at) VALUES (?, ?, ?)',
  ).run(userId, jid, pinned_at);
  return pinned_at;
}

export function unpinGroup(userId: string, jid: string): void {
  db.prepare(
    'DELETE FROM user_pinned_groups WHERE user_id = ? AND jid = ?',
  ).run(userId, jid);
}

// --- Web API accessors ---

/**
 * Get paginated messages for a chat, cursor-based pagination.
 * Returns messages in descending timestamp order (newest first).
 */
export function getMessagesPage(
  chatJid: string,
  before?: string,
  limit = 50,
  sessionId?: string,
): Array<NewMessage & { is_from_me: boolean }> {
  const sessionFilter = typeof sessionId === 'string' && sessionId.trim() ? sessionId.trim() : null;
  const sql = sessionFilter
    ? before
      ? `
      SELECT id, chat_jid, source_jid, sender, sender_name, role, content, timestamp, is_from_me, attachments, token_usage,
             turn_id, session_id, sdk_message_uuid, source_kind, finalization_reason
      FROM messages
      WHERE chat_jid = ? AND timestamp < ? AND session_id = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `
      : `
      SELECT id, chat_jid, source_jid, sender, sender_name, role, content, timestamp, is_from_me, attachments, token_usage,
             turn_id, session_id, sdk_message_uuid, source_kind, finalization_reason
      FROM messages
      WHERE chat_jid = ? AND session_id = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `
    : before
      ? `
      SELECT id, chat_jid, source_jid, sender, sender_name, role, content, timestamp, is_from_me, attachments, token_usage,
             turn_id, session_id, sdk_message_uuid, source_kind, finalization_reason
      FROM messages
      WHERE chat_jid = ? AND timestamp < ?
      ORDER BY timestamp DESC
      LIMIT ?
    `
      : `
      SELECT id, chat_jid, source_jid, sender, sender_name, role, content, timestamp, is_from_me, attachments, token_usage,
             turn_id, session_id, sdk_message_uuid, source_kind, finalization_reason
      FROM messages
      WHERE chat_jid = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `;

  const params = sessionFilter
    ? before
      ? [chatJid, before, sessionFilter, limit]
      : [chatJid, sessionFilter, limit]
    : before
      ? [chatJid, before, limit]
      : [chatJid, limit];
  const rows = db.prepare(sql).all(...params) as Array<
    NewMessage & { is_from_me: number }
  >;

  return rows.map((row) => normalizeMessageRow(row));
}

/**
 * Get messages after a given timestamp (for polling new messages).
 * Returns in ASC order (oldest first).
 */
export function getMessagesAfter(
  chatJid: string,
  after: string,
  limit = 50,
  sessionId?: string,
): Array<NewMessage & { is_from_me: boolean }> {
  const sessionFilter = typeof sessionId === 'string' && sessionId.trim() ? sessionId.trim() : null;
  const rows = db
    .prepare(
      sessionFilter
        ? `SELECT id, chat_jid, source_jid, sender, sender_name, role, content, timestamp, is_from_me, attachments, token_usage,
              turn_id, session_id, sdk_message_uuid, source_kind, finalization_reason
       FROM messages
       WHERE chat_jid = ? AND timestamp > ? AND session_id = ?
       ORDER BY timestamp ASC
       LIMIT ?`
        : `SELECT id, chat_jid, source_jid, sender, sender_name, role, content, timestamp, is_from_me, attachments, token_usage,
              turn_id, session_id, sdk_message_uuid, source_kind, finalization_reason
       FROM messages
       WHERE chat_jid = ? AND timestamp > ?
       ORDER BY timestamp ASC
       LIMIT ?`,
    )
    .all(...(sessionFilter ? [chatJid, after, sessionFilter, limit] : [chatJid, after, limit])) as Array<NewMessage & { is_from_me: number }>;

  return rows.map((row) => normalizeMessageRow(row));
}

/**
 * 多 JID 分页查询（用于主容器合并 web:main + feishu:xxx 消息）。
 */
export function getMessagesPageMulti(
  chatJids: string[],
  before?: string,
  limit = 50,
  sessionId?: string,
): Array<NewMessage & { is_from_me: boolean }> {
  if (chatJids.length === 0) return [];
  if (chatJids.length === 1) return getMessagesPage(chatJids[0], before, limit, sessionId);

  const placeholders = chatJids.map(() => '?').join(',');
  const sessionFilter = typeof sessionId === 'string' && sessionId.trim() ? sessionId.trim() : null;
  const sql = sessionFilter
    ? before
      ? `SELECT id, chat_jid, source_jid, sender, sender_name, role, content, timestamp, is_from_me, attachments, token_usage,
              turn_id, session_id, sdk_message_uuid, source_kind, finalization_reason
       FROM messages
       WHERE chat_jid IN (${placeholders}) AND timestamp < ? AND session_id = ?
       ORDER BY timestamp DESC
       LIMIT ?`
      : `SELECT id, chat_jid, source_jid, sender, sender_name, role, content, timestamp, is_from_me, attachments, token_usage,
              turn_id, session_id, sdk_message_uuid, source_kind, finalization_reason
       FROM messages
       WHERE chat_jid IN (${placeholders}) AND session_id = ?
       ORDER BY timestamp DESC
       LIMIT ?`
    : before
      ? `SELECT id, chat_jid, source_jid, sender, sender_name, role, content, timestamp, is_from_me, attachments, token_usage,
              turn_id, session_id, sdk_message_uuid, source_kind, finalization_reason
       FROM messages
       WHERE chat_jid IN (${placeholders}) AND timestamp < ?
       ORDER BY timestamp DESC
       LIMIT ?`
      : `SELECT id, chat_jid, source_jid, sender, sender_name, role, content, timestamp, is_from_me, attachments, token_usage,
              turn_id, session_id, sdk_message_uuid, source_kind, finalization_reason
       FROM messages
       WHERE chat_jid IN (${placeholders})
       ORDER BY timestamp DESC
       LIMIT ?`;

  const params = sessionFilter
    ? before
      ? [...chatJids, before, sessionFilter, limit]
      : [...chatJids, sessionFilter, limit]
    : before
      ? [...chatJids, before, limit]
      : [...chatJids, limit];
  const rows = db.prepare(sql).all(...params) as Array<
    NewMessage & { is_from_me: number }
  >;

  return rows.map((row) => normalizeMessageRow(row));
}

/**
 * 多 JID 增量查询（用于主容器轮询合并消息）。
 */
export function getMessagesAfterMulti(
  chatJids: string[],
  after: string,
  limit = 50,
  sessionId?: string,
): Array<NewMessage & { is_from_me: boolean }> {
  if (chatJids.length === 0) return [];
  if (chatJids.length === 1) return getMessagesAfter(chatJids[0], after, limit, sessionId);

  const placeholders = chatJids.map(() => '?').join(',');
  const sessionFilter = typeof sessionId === 'string' && sessionId.trim() ? sessionId.trim() : null;
  const rows = db
    .prepare(
      sessionFilter
        ? `SELECT id, chat_jid, source_jid, sender, sender_name, role, content, timestamp, is_from_me, attachments, token_usage,
              turn_id, session_id, sdk_message_uuid, source_kind, finalization_reason
       FROM messages
       WHERE chat_jid IN (${placeholders}) AND timestamp > ? AND session_id = ?
       ORDER BY timestamp ASC
       LIMIT ?`
        : `SELECT id, chat_jid, source_jid, sender, sender_name, role, content, timestamp, is_from_me, attachments, token_usage,
              turn_id, session_id, sdk_message_uuid, source_kind, finalization_reason
       FROM messages
       WHERE chat_jid IN (${placeholders}) AND timestamp > ?
       ORDER BY timestamp ASC
       LIMIT ?`,
    )
    .all(...(sessionFilter ? [...chatJids, after, sessionFilter, limit] : [...chatJids, after, limit])) as Array<
    NewMessage & { is_from_me: number }
  >;

  return rows.map((row) => normalizeMessageRow(row));
}

/**
 * Get task run logs for a specific task, ordered by most recent first.
 */
export function getTaskRunLogs(taskId: string, limit = 20): TaskRunLog[] {
  return db
    .prepare(
      `
    SELECT id, task_id, run_at, duration_ms, status, result, error
    FROM task_run_logs
    WHERE task_id = ?
    ORDER BY run_at DESC
    LIMIT ?
  `,
    )
    .all(taskId, limit) as TaskRunLog[];
}

export interface SystemHistoryFilters {
  type?: 'task' | 'issue' | 'team' | 'message' | 'all';
  query?: string;
  limit?: number;
  offset?: number;
  userId?: string;
  includeAllUsers?: boolean;
  accessibleWorkspaceJids?: string[];
  accessibleGroupFolders?: string[];
}

export interface SystemHistoryItem {
  id: string;
  type: 'task' | 'issue' | 'team' | 'message';
  title: string;
  status?: string | null;
  actor?: string | null;
  workspace?: string | null;
  summary?: string | null;
  detail?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  createdAt: string;
  targetUrl?: string | null;
  payload?: Record<string, unknown> | null;
}

export interface SystemHistoryFlowStage {
  id: string;
  type: string;
  title: string;
  status?: string | null;
  at: string;
  summary?: string | null;
  detail?: string | null;
  payload?: Record<string, unknown> | null;
}

export interface SystemHistoryFlow {
  id: string;
  type: 'task' | 'issue' | 'team' | 'conversation';
  title: string;
  status?: string | null;
  archivedAt?: string | null;
  actor?: string | null;
  workspace?: string | null;
  startedAt: string;
  updatedAt: string;
  summary?: string | null;
  targetUrl?: string | null;
  metrics: { stages: number; messages?: number; durationMs?: number | null };
  stages: SystemHistoryFlowStage[];
}

export function listSystemHistory(filters: SystemHistoryFilters = {}): SystemHistoryItem[] {
  const limit = Math.max(1, Math.min(200, filters.limit ?? 100));
  const offset = Math.max(0, filters.offset ?? 0);
  const type = filters.type ?? 'all';
  const query = filters.query?.trim().toLowerCase();
  const items: SystemHistoryItem[] = [];

  if (type === 'all' || type === 'task') {
    const rows = db
      .prepare(
        `SELECT l.id, l.task_id, l.run_at, l.duration_ms, l.status, l.result, l.error,
                t.prompt, t.group_folder, t.chat_jid, t.execution_type
         FROM task_run_logs l
         LEFT JOIN scheduled_tasks t ON t.id = l.task_id
         ORDER BY l.run_at DESC
         LIMIT ?`,
      )
      .all(limit * 2) as Array<Record<string, unknown>>;
    for (const row of rows) {
      items.push({
        id: `task:${row.id}`,
        type: 'task',
        title: String(row.prompt || row.task_id || 'Scheduled task'),
        status: String(row.status || ''),
        actor: String(row.execution_type || 'task'),
        workspace: String(row.group_folder || row.chat_jid || ''),
        summary: typeof row.result === 'string' ? row.result.slice(0, 240) : null,
        detail: typeof row.error === 'string' && row.error ? row.error : typeof row.result === 'string' ? row.result : null,
        startedAt: String(row.run_at || ''),
        completedAt: row.duration_ms ? new Date(new Date(String(row.run_at)).getTime() + Number(row.duration_ms)).toISOString() : null,
        createdAt: String(row.run_at || ''),
        targetUrl: '/tasks',
        payload: { taskId: row.task_id, durationMs: row.duration_ms },
      });
    }
  }

  if (type === 'all' || type === 'issue') {
    const rows = db
      .prepare(
        `SELECT r.*, i.title AS issue_title, i.priority AS issue_priority
         FROM issue_agent_runs r
         LEFT JOIN issues i ON i.id = r.issue_id
         ORDER BY r.created_at DESC
         LIMIT ?`,
      )
      .all(limit * 2) as Array<Record<string, unknown>>;
    for (const row of rows) {
      items.push({
        id: `issue:${row.id}`,
        type: 'issue',
        title: String(row.issue_title || row.issue_id || 'Issue run'),
        status: String(row.status || ''),
        actor: String(row.backend || row.agent_client_id || row.execution_node || 'issue-agent'),
        workspace: String(row.workspace_folder || row.workspace_jid || ''),
        summary: typeof row.result === 'string' ? row.result.slice(0, 240) : null,
        detail: typeof row.error === 'string' && row.error ? row.error : typeof row.result === 'string' ? row.result : null,
        startedAt: typeof row.run_started_at === 'string' ? row.run_started_at : null,
        completedAt: typeof row.run_completed_at === 'string' ? row.run_completed_at : null,
        createdAt: String(row.created_at || ''),
        targetUrl: '/issues',
        payload: { issueId: row.issue_id, runId: row.id, priority: row.issue_priority },
      });
    }
  }

  if (type === 'all' || type === 'team') {
    const rows = db
      .prepare(
        `SELECT * FROM agent_team_runs ORDER BY created_at DESC LIMIT ?`,
      )
      .all(limit * 2) as Array<Record<string, unknown>>;
    for (const row of rows) {
      items.push({
        id: `team:${row.id}`,
        type: 'team',
        title: String(row.prompt || row.team_id || 'Agent team run'),
        status: String(row.status || ''),
        actor: String(row.team_id || 'agent-team'),
        workspace: null,
        summary: typeof row.final_result === 'string' ? row.final_result.slice(0, 240) : null,
        detail: typeof row.error === 'string' && row.error ? row.error : typeof row.final_result === 'string' ? row.final_result : null,
        startedAt: typeof row.started_at === 'string' ? row.started_at : null,
        completedAt: typeof row.completed_at === 'string' ? row.completed_at : null,
        createdAt: String(row.created_at || ''),
        targetUrl: '/agents',
        payload: { teamId: row.team_id, runId: row.id, traceId: row.trace_id },
      });
    }
  }

  if (type === 'all' || type === 'message') {
    const rows = db
      .prepare(
        `SELECT m.id, m.chat_jid, m.source_jid, m.sender, m.sender_name, m.role, m.content, m.timestamp,
                m.is_from_me, m.session_id, m.turn_id, m.source_kind, c.name AS chat_name,
                c.archived_at AS chat_archived_at, c.archive_reason AS chat_archive_reason, c.jid AS chat_exists
         FROM messages m
         LEFT JOIN chats c ON c.jid = m.chat_jid
         ORDER BY m.timestamp DESC
         LIMIT ?`,
      )
      .all(limit * 2) as Array<Record<string, unknown>>;
    for (const row of rows) {
      items.push({
        id: `message:${row.chat_jid}:${row.id}`,
        type: 'message',
        title: String(row.chat_name || row.chat_jid || 'Conversation message'),
        status: String(row.role || (row.is_from_me ? 'agent' : 'user')),
        actor: String(row.sender_name || row.sender || ''),
        workspace: String(row.chat_jid || ''),
        summary: typeof row.content === 'string' ? row.content.slice(0, 240) : null,
        detail: typeof row.content === 'string' ? row.content : null,
        startedAt: String(row.timestamp || ''),
        completedAt: null,
        createdAt: String(row.timestamp || ''),
        targetUrl: '/chat',
        payload: { chatJid: row.chat_jid, messageId: row.id, sessionId: row.session_id, turnId: row.turn_id, sourceKind: row.source_kind, role: row.role },
      });
    }
  }

  const filtered = query
    ? items.filter((item) =>
        [item.title, item.status, item.actor, item.workspace, item.summary, item.detail]
          .filter(Boolean)
          .join('\n')
          .toLowerCase()
          .includes(query),
      )
    : items;
  return filtered
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(offset, offset + limit);
}

function parseHistoryPayload(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'string' || !value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : { value: parsed };
  } catch {
    return { raw: value };
  }
}

function shortHistorySession(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const trimmed = value.trim();
  return trimmed.length > 18 ? `${trimmed.slice(0, 8)}…${trimmed.slice(-6)}` : trimmed;
}

function compactHistoryJson(value: unknown, max = 4000): string | null {
  if (value === undefined || value === null) return null;
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function nestedHistoryValue(source: Record<string, unknown> | null | undefined, keys: string[]): unknown {
  if (!source) return undefined;
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  const rawEvent = source.rawEvent && typeof source.rawEvent === 'object'
    ? (source.rawEvent as Record<string, unknown>)
    : null;
  if (rawEvent) {
    for (const key of keys) {
      const value = rawEvent[key];
      if (value !== undefined && value !== null && value !== '') return value;
    }
    const message = rawEvent.message && typeof rawEvent.message === 'object'
      ? (rawEvent.message as Record<string, unknown>)
      : null;
    const blocks = message?.content;
    if (Array.isArray(blocks)) {
      for (const block of blocks) {
        if (!block || typeof block !== 'object') continue;
        const record = block as Record<string, unknown>;
        for (const key of keys) {
          const value = record[key];
          if (value !== undefined && value !== null && value !== '') return value;
        }
      }
    }
  }
  return undefined;
}

function historyToolPayload(streamEvent: Record<string, unknown> | null, toolNames: Map<string, string>): Record<string, unknown> | null {
  if (!streamEvent) return null;
  const eventType = String(streamEvent.eventType || '');
  if (!eventType.includes('tool_') && !eventType.includes('permission_denied')) return null;
  const toolUseId = typeof streamEvent.toolUseId === 'string' ? streamEvent.toolUseId : null;
  const toolName = typeof streamEvent.toolName === 'string'
    ? streamEvent.toolName
    : toolUseId
      ? toolNames.get(toolUseId) ?? null
      : null;
  const input = streamEvent.toolInput ?? nestedHistoryValue(streamEvent, ['input', 'arguments', 'params']);
  const response = streamEvent.detail ?? nestedHistoryValue(streamEvent, ['content', 'result', 'output', 'text', 'error']);
  return {
    toolName,
    toolUseId,
    parentToolUseId: streamEvent.parentToolUseId ?? null,
    input,
    response,
    status: streamEvent.statusText ?? null,
    rawEvent: streamEvent.rawEvent ?? null,
  };
}

function historyToolTitle(eventType: string, streamEvent: Record<string, unknown> | null, toolNames: Map<string, string>): string | null {
  if (!streamEvent) return null;
  const toolUseId = typeof streamEvent.toolUseId === 'string' ? streamEvent.toolUseId : null;
  const toolName = typeof streamEvent.toolName === 'string' ? streamEvent.toolName : toolUseId ? toolNames.get(toolUseId) : null;
  const label = toolName || (toolUseId ? `#${toolUseId.slice(0, 8)}` : 'Tool');
  if (eventType.includes('tool_use_start')) return `工具调用 · ${label}`;
  if (eventType.includes('tool_use_end')) return `工具响应 · ${label}`;
  if (eventType.includes('tool_progress')) return `工具进度 · ${label}`;
  if (eventType.includes('permission_denied')) return `工具权限拒绝 · ${label}`;
  return null;
}

function chatHistoryTargetUrl(chatJid: unknown, sessionId?: unknown, groupFolder?: unknown): string {
  const jid = typeof chatJid === 'string' ? chatJid : '';
  const agentMarker = '#agent:';
  const agentIndex = jid.indexOf(agentMarker);
  const baseJid = agentIndex >= 0 ? jid.slice(0, agentIndex) : jid;
  const agentId = agentIndex >= 0 ? jid.slice(agentIndex + agentMarker.length) : '';
  const folder = typeof groupFolder === 'string' && groupFolder
    ? groupFolder
    : baseJid.startsWith('web:')
      ? baseJid.slice(4)
      : '';
  const base = folder ? `/chat/${encodeURIComponent(folder)}` : '/chat';
  const params = new URLSearchParams();
  if (agentId) params.set('agent', agentId);
  const session = typeof sessionId === 'string' && sessionId.trim() ? sessionId.trim() : '';
  if (session) params.set('session', session);
  const query = params.toString();
  return query ? `${base}?${query}` : base;
}

function archiveChatRecord(chatJid: string, reason: string): void {
  const now = new Date().toISOString();
  const existing = db
    .prepare('SELECT jid FROM chats WHERE jid = ?')
    .get(chatJid) as { jid: string } | undefined;
  if (existing) {
    db.prepare(
      `UPDATE chats
       SET archived_at = COALESCE(archived_at, ?), archive_reason = ?
       WHERE jid = ?`,
    ).run(now, reason, chatJid);
    return;
  }
  db.prepare(
    `INSERT INTO chats (jid, name, last_message_time, archived_at, archive_reason)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(chatJid, chatJid, now, now, reason);
}

export function listSystemHistoryFlows(filters: SystemHistoryFilters = {}): SystemHistoryFlow[] {
  const limit = Math.max(1, Math.min(100, filters.limit ?? 50));
  const offset = Math.max(0, filters.offset ?? 0);
  const type = filters.type ?? 'all';
  const query = filters.query?.trim().toLowerCase();
  const flows: SystemHistoryFlow[] = [];
  const includeAllUsers = !!filters.includeAllUsers;
  const scopedUserId = filters.userId;
  const accessibleWorkspaceJids = Array.from(
    new Set(filters.accessibleWorkspaceJids ?? []),
  ).filter(Boolean);
  const accessibleGroupFolders = Array.from(
    new Set(filters.accessibleGroupFolders ?? []),
  ).filter(Boolean);
  const placeholders = (values: unknown[]) => values.map(() => '?').join(',');

  if (type === 'all' || type === 'task') {
    const taskAccess: string[] = [];
    const taskValues: unknown[] = [];
    if (!includeAllUsers) {
      if (scopedUserId) {
        taskAccess.push('t.created_by = ?');
        taskValues.push(scopedUserId);
      }
      if (accessibleWorkspaceJids.length > 0) {
        taskAccess.push(`t.chat_jid IN (${placeholders(accessibleWorkspaceJids)})`);
        taskValues.push(...accessibleWorkspaceJids);
      }
      if (accessibleGroupFolders.length > 0) {
        taskAccess.push(`t.group_folder IN (${placeholders(accessibleGroupFolders)})`);
        taskValues.push(...accessibleGroupFolders);
      }
    }
    const taskWhere = includeAllUsers
      ? ''
      : taskAccess.length > 0
        ? `WHERE (${taskAccess.join(' OR ')})`
        : 'WHERE 1 = 0';
    const rows = db
      .prepare(
        `SELECT l.id, l.task_id, l.run_at, l.duration_ms, l.status, l.result, l.error,
                t.prompt, t.group_folder, t.chat_jid, t.execution_type
         FROM task_run_logs l
         LEFT JOIN scheduled_tasks t ON t.id = l.task_id
         ${taskWhere}
         ORDER BY l.run_at DESC
         LIMIT ?`,
      )
      .all(...taskValues, limit * 2) as Array<Record<string, unknown>>;
    for (const row of rows) {
      const title = String(row.prompt || row.task_id || 'Scheduled task');
      const at = String(row.run_at || '');
      flows.push({
        id: `task:${row.id}`,
        type: 'task',
        title,
        status: String(row.status || ''),
        actor: String(row.execution_type || 'task'),
        workspace: String(row.group_folder || row.chat_jid || ''),
        startedAt: at,
        updatedAt: row.duration_ms ? new Date(new Date(at).getTime() + Number(row.duration_ms)).toISOString() : at,
        summary: typeof row.error === 'string' && row.error ? row.error : typeof row.result === 'string' ? row.result.slice(0, 240) : null,
        targetUrl: row.group_folder ? `/tasks?workspace=${encodeURIComponent(String(row.group_folder))}&task=${encodeURIComponent(String(row.task_id || ''))}` : '/tasks',
        metrics: { stages: 1, durationMs: Number(row.duration_ms || 0) },
        stages: [
          {
            id: `task-stage:${row.id}`,
            type: 'task_run',
            title: `Task ${row.status || 'run'}`,
            status: String(row.status || ''),
            at,
            summary: typeof row.result === 'string' ? row.result.slice(0, 240) : null,
            detail: typeof row.error === 'string' && row.error ? row.error : typeof row.result === 'string' ? row.result : null,
            payload: { taskId: row.task_id, durationMs: row.duration_ms },
          },
        ],
      });
    }
  }

  if (type === 'all' || type === 'issue') {
    const issueAccess: string[] = [];
    const issueValues: unknown[] = [];
    if (!includeAllUsers) {
      if (scopedUserId) {
        issueAccess.push('r.created_by = ?');
        issueValues.push(scopedUserId);
      }
      if (accessibleWorkspaceJids.length > 0) {
        issueAccess.push(`r.workspace_jid IN (${placeholders(accessibleWorkspaceJids)})`);
        issueValues.push(...accessibleWorkspaceJids);
      }
      if (accessibleGroupFolders.length > 0) {
        issueAccess.push(`r.workspace_folder IN (${placeholders(accessibleGroupFolders)})`);
        issueValues.push(...accessibleGroupFolders);
      }
    }
    const issueWhere = includeAllUsers
      ? ''
      : issueAccess.length > 0
        ? `WHERE (${issueAccess.join(' OR ')})`
        : 'WHERE 1 = 0';
    const rows = db
      .prepare(
        `SELECT r.*, i.title AS issue_title, i.priority AS issue_priority
         FROM issue_agent_runs r
         LEFT JOIN issues i ON i.id = r.issue_id
         ${issueWhere}
         ORDER BY r.created_at DESC
         LIMIT ?`,
      )
      .all(...issueValues, limit * 2) as Array<Record<string, unknown>>;
    for (const row of rows) {
      const sessionLabel = shortHistorySession(row.session_id) || String(row.id || '').slice(0, 12);
      const eventRows = db
        .prepare('SELECT * FROM issue_agent_run_events WHERE run_id = ? ORDER BY created_at ASC LIMIT 500')
        .all(row.id) as Array<Record<string, unknown>>;
      const toolNames = new Map<string, string>();
      for (const event of eventRows) {
        const payload = parseHistoryPayload(event.payload);
        const streamEvent = payload?.streamEvent && typeof payload.streamEvent === 'object'
          ? (payload.streamEvent as Record<string, unknown>)
          : null;
        if (typeof streamEvent?.toolUseId === 'string' && typeof streamEvent.toolName === 'string') {
          toolNames.set(streamEvent.toolUseId, streamEvent.toolName);
        }
      }
      const stages = eventRows.map((event) => {
        const payload = parseHistoryPayload(event.payload);
        const streamEvent = payload?.streamEvent && typeof payload.streamEvent === 'object'
          ? (payload.streamEvent as Record<string, unknown>)
          : null;
        const eventType = String(event.event_type || 'event');
        const toolName = typeof streamEvent?.toolName === 'string' ? streamEvent.toolName : null;
        const toolSummary = typeof streamEvent?.toolInputSummary === 'string' ? streamEvent.toolInputSummary : null;
        const toolPayload = historyToolPayload(streamEvent, toolNames);
        const toolResponse = toolPayload?.response;
        const title = historyToolTitle(eventType, streamEvent, toolNames)
          ?? (eventType.includes('tool_')
            ? `${toolName || 'Tool'} · ${eventType.replace('stream:', '')}`
            : String(event.title || event.event_type || 'Event'));
        return {
          id: String(event.id),
          type: eventType,
          title,
          status: null,
          at: String(event.created_at || row.created_at || ''),
          summary: toolSummary || (typeof event.summary === 'string' ? event.summary : null) || (toolResponse ? compactHistoryJson(toolResponse, 240) : null),
          detail: typeof event.detail === 'string' ? event.detail : toolResponse ? compactHistoryJson(toolResponse) : null,
          payload: toolPayload ? { ...payload, toolAudit: toolPayload } : payload,
        };
      });
      flows.push({
        id: `issue:${row.id}`,
        type: 'issue',
        title: `${String(row.issue_title || row.issue_id || 'Issue run')} · ${sessionLabel}`,
        status: String(row.status || ''),
        actor: String(row.backend || row.agent_client_id || row.execution_node || 'issue-agent'),
        workspace: String(row.workspace_folder || row.workspace_jid || ''),
        startedAt: String(row.run_started_at || row.created_at || ''),
        updatedAt: String(row.run_completed_at || row.run_started_at || row.created_at || ''),
        summary: typeof row.error === 'string' && row.error ? row.error : typeof row.result === 'string' ? row.result.slice(0, 240) : null,
        targetUrl: `/issues/${encodeURIComponent(String(row.workspace_folder || ''))}?issue=${encodeURIComponent(String(row.issue_id || ''))}&run=${encodeURIComponent(String(row.id || ''))}`,
        metrics: { stages: stages.length, durationMs: row.run_started_at && row.run_completed_at ? new Date(String(row.run_completed_at)).getTime() - new Date(String(row.run_started_at)).getTime() : null },
        stages: stages.length
          ? stages
          : [
              {
                id: `issue-stage:${row.id}`,
                type: 'run',
                title: `Issue run ${row.status || ''}`,
                status: String(row.status || ''),
                at: String(row.created_at || ''),
                summary: typeof row.result === 'string' ? row.result.slice(0, 240) : typeof row.error === 'string' ? row.error : null,
                detail: typeof row.error === 'string' && row.error ? row.error : typeof row.result === 'string' ? row.result : null,
                payload: { issueId: row.issue_id, runId: row.id, sessionId: row.session_id, priority: row.issue_priority },
              },
            ],
      });
    }
  }

  if (type === 'all' || type === 'team') {
    const teamWhere = includeAllUsers ? '' : scopedUserId ? 'WHERE user_id = ?' : 'WHERE 1 = 0';
    const teamValues = includeAllUsers || !scopedUserId ? [] : [scopedUserId];
    const rows = db.prepare(`SELECT * FROM agent_team_runs ${teamWhere} ORDER BY created_at DESC LIMIT ?`).all(...teamValues, limit * 2) as Array<Record<string, unknown>>;
    for (const row of rows) {
      const eventRows = db
        .prepare('SELECT * FROM agent_team_events WHERE run_id = ? ORDER BY timestamp ASC LIMIT 80')
        .all(row.id) as Array<Record<string, unknown>>;
      const sessionIds = [
        ...new Set(
          eventRows
            .map((event) => (typeof event.session_id === 'string' ? event.session_id : null))
            .filter((value): value is string => !!value),
        ),
      ];
      const sessionLabel = sessionIds.length ? sessionIds.map(shortHistorySession).filter(Boolean).join(', ') : String(row.trace_id || row.id || '').slice(0, 12);
      const stages = eventRows.map((event) => ({
        id: `team-event:${event.id}`,
        type: String(event.type || 'event'),
        title: String(event.type || 'Team event'),
        status: null,
        at: String(event.timestamp || row.created_at || ''),
        summary: String(event.actor || ''),
        detail: typeof event.payload === 'string' ? event.payload : null,
        payload: parseHistoryPayload(event.payload),
      }));
      flows.push({
        id: `team:${row.id}`,
        type: 'team',
        title: `${String(row.prompt || row.team_id || 'Agent team run')} · ${sessionLabel}`,
        status: String(row.status || ''),
        actor: String(row.team_id || 'agent-team'),
        workspace: null,
        startedAt: String(row.started_at || row.created_at || ''),
        updatedAt: String(row.completed_at || row.updated_at || row.created_at || ''),
        summary: typeof row.error === 'string' && row.error ? row.error : typeof row.final_result === 'string' ? row.final_result.slice(0, 240) : null,
        targetUrl: `/agents?run=${encodeURIComponent(String(row.id || ''))}&team=${encodeURIComponent(String(row.team_id || ''))}`,
        metrics: { stages: stages.length, durationMs: row.started_at && row.completed_at ? new Date(String(row.completed_at)).getTime() - new Date(String(row.started_at)).getTime() : null },
        stages,
      });
    }
  }

  if (type === 'all' || type === 'message') {
    const baseChatJidExpr = `CASE
           WHEN instr(m.chat_jid, '#agent:') > 0 THEN substr(m.chat_jid, 1, instr(m.chat_jid, '#agent:') - 1)
           ELSE m.chat_jid
         END`;
    const hasAccessFilters =
      accessibleWorkspaceJids.length > 0 ||
      accessibleGroupFolders.length > 0 ||
      Boolean(scopedUserId);
    const messageWhere = includeAllUsers
      ? ''
      : accessibleWorkspaceJids.length > 0
        ? `WHERE ${baseChatJidExpr} IN (${placeholders(accessibleWorkspaceJids)})`
        : hasAccessFilters
          ? 'WHERE 1 = 0'
          : '';
    const messageValues = includeAllUsers ? [] : accessibleWorkspaceJids;
    const rows = db
      .prepare(
        `SELECT m.id, m.chat_jid, m.source_jid, m.sender, m.sender_name, m.role, m.content, m.timestamp,
                m.is_from_me, m.session_id, m.turn_id, m.source_kind,
                c.name AS chat_name, c.archived_at AS chat_archived_at, c.archive_reason AS chat_archive_reason,
                CASE WHEN c.jid IS NULL THEN 0 ELSE 1 END AS chat_exists,
                g.name AS group_name, g.folder AS group_folder
         FROM messages m
         LEFT JOIN chats c ON c.jid = m.chat_jid
         LEFT JOIN registered_groups g ON g.jid = ${baseChatJidExpr}
         ${messageWhere}
         ORDER BY m.timestamp DESC
         LIMIT ?`, 
      )
      .all(...messageValues, limit * 8) as Array<Record<string, unknown>>;
    const byChat = new Map<string, Array<Record<string, unknown>>>();
    for (const row of rows) {
      const key = String(row.chat_jid || 'unknown');
      const arr = byChat.get(key) ?? [];
      arr.push(row);
      byChat.set(key, arr);
    }
    const grouped: Array<{ key: string; chatJid: string; sessionId: string | null; messages: Array<Record<string, unknown>> }> = [];
    for (const [chatJid, chatMessages] of byChat) {
      chatMessages.sort((a, b) => String(a.timestamp || '').localeCompare(String(b.timestamp || '')));
      const bySession = new Map<string, Array<Record<string, unknown>>>();
      const sessionOrder: string[] = [];
      let pendingNoSession: Array<Record<string, unknown>> = [];
      let index = 0;
      for (const message of chatMessages) {
        const sessionId = typeof message.session_id === 'string' && message.session_id.trim() ? message.session_id.trim() : null;
        if (!sessionId) {
          pendingNoSession.push(message);
          continue;
        }
        if (!bySession.has(sessionId)) {
          bySession.set(sessionId, []);
          sessionOrder.push(sessionId);
        }
        const bucket = bySession.get(sessionId)!;
        if (pendingNoSession.length > 0) {
          bucket.push(...pendingNoSession);
          pendingNoSession = [];
        }
        bucket.push(message);
      }
      if (pendingNoSession.length > 0) {
        grouped.push({ key: `${chatJid}:local:${index++}`, chatJid, sessionId: null, messages: pendingNoSession });
      }
      for (const sessionId of sessionOrder) {
        grouped.push({ key: `${chatJid}:session:${sessionId}`, chatJid, sessionId, messages: bySession.get(sessionId) ?? [] });
      }
    }
    for (const { key, sessionId, messages } of grouped) {
      if (messages.length === 0) continue;
      const first = messages[0];
      const last = messages[messages.length - 1];
      const userCount = messages.filter((message) => String(message.role || (Number(message.is_from_me || 0) === 1 ? 'assistant' : 'user')) === 'user').length;
      const toolCount = messages.filter((message) => String(message.role || '') === 'tool').length;
      const agentCount = messages.length - userCount - toolCount;
      const sessionLabel = shortHistorySession(sessionId) || 'local';
      const workspaceLabel = String(last.group_name || last.chat_name || last.group_folder || last.chat_jid || 'Workspace');
      const archivedAt = typeof last.chat_archived_at === 'string' && last.chat_archived_at
        ? last.chat_archived_at
        : null;
      flows.push({
        id: `conversation:${key}`,
        type: 'conversation',
        title: `${workspaceLabel} · ${sessionLabel}`,
        status: `${userCount} user / ${agentCount} agent / ${toolCount} tool`,
        archivedAt,
        actor: String(last.sender_name || last.sender || ''),
        workspace: String(last.chat_jid || ''),
        startedAt: String(first.timestamp || ''),
        updatedAt: String(last.timestamp || ''),
        summary: typeof last.content === 'string' ? last.content.slice(0, 240) : null,
        targetUrl: chatHistoryTargetUrl(last.chat_jid, sessionId, last.group_folder),
        metrics: { stages: messages.length, messages: messages.length },
        stages: messages.map((message) => {
          const role = String(message.role || (Number(message.is_from_me || 0) === 1 ? 'assistant' : 'user'));
          return {
            id: `message:${message.chat_jid}:${message.id}`,
            type: role === 'tool' ? 'tool_message' : message.is_from_me ? 'agent_message' : 'user_message',
            title: role === 'tool' ? 'Tool' : message.is_from_me ? 'Agent output' : 'User input',
            status: role,
            at: String(message.timestamp || ''),
            summary: typeof message.content === 'string' ? message.content.slice(0, 240) : null,
            detail: typeof message.content === 'string' ? message.content : null,
            payload: { chatJid: message.chat_jid, messageId: message.id, sessionId: message.session_id, turnId: message.turn_id, sourceKind: message.source_kind, role, archivedAt, archiveReason: last.chat_archive_reason },
          };
        }),
      });
    }
  }

  const filtered = query
    ? flows.filter((flow) =>
        [flow.title, flow.status, flow.actor, flow.workspace, flow.summary, ...flow.stages.flatMap((stage) => [stage.title, stage.summary, stage.detail])]
          .filter(Boolean)
          .join('\n')
          .toLowerCase()
          .includes(query),
      )
    : flows;
  return filtered.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(offset, offset + limit);
}

// ===================== Daily Summary Queries =====================

/**
 * Get messages for a chat within a time range, ordered by timestamp ASC.
 */
export function getMessagesByTimeRange(
  chatJid: string,
  startTs: number,
  endTs: number,
  limit = 500,
): Array<NewMessage & { is_from_me: boolean }> {
  const startIso = new Date(startTs).toISOString();
  const endIso = new Date(endTs).toISOString();
  const rows = db
    .prepare(
      `SELECT id, chat_jid, source_jid, sender, sender_name, role, content, timestamp, is_from_me, attachments,
              turn_id, session_id, sdk_message_uuid, source_kind, finalization_reason
       FROM messages
       WHERE chat_jid = ? AND timestamp >= ? AND timestamp < ?
       ORDER BY timestamp ASC
       LIMIT ?`,
    )
    .all(chatJid, startIso, endIso, limit) as Array<
    NewMessage & { is_from_me: number }
  >;

  return rows.map((row) => normalizeMessageRow(row));
}

/**
 * Get all registered groups owned by a specific user.
 */
export function getGroupsByOwner(
  userId: string,
): Array<RegisteredGroup & { jid: string }> {
  const rows = db
    .prepare('SELECT * FROM registered_groups WHERE created_by = ?')
    .all(userId) as Array<{
    jid: string;
    name: string;
    folder: string;
    added_at: string;
    container_config: string | null;
    execution_mode: string | null;
    custom_cwd: string | null;
    repo_id: string | null;
    repo_git_url: string | null;
    repo_main_branch: string | null;
    repo_device_path: string | null;
    init_source_path: string | null;
    init_git_url: string | null;
    created_by: string | null;
    is_home: number;
    selected_skills: string | null;
    target_main_jid: string | null;
    target_agent_id: string | null;
  }>;

  return rows.map((row) => ({
    jid: row.jid,
    name: row.name,
    folder: row.folder,
    added_at: row.added_at,
    containerConfig: row.container_config
      ? JSON.parse(row.container_config)
      : undefined,
    executionMode: parseExecutionMode(row.execution_mode, `group ${row.jid}`),
    customCwd: row.custom_cwd ?? undefined,
    repoId: row.repo_id ?? undefined,
    repoGitUrl: row.repo_git_url ?? undefined,
    repoMainBranch: row.repo_main_branch ?? undefined,
    repoDevicePath: row.repo_device_path ?? undefined,
    initSourcePath: row.init_source_path ?? undefined,
    initGitUrl: row.init_git_url ?? undefined,
    created_by: row.created_by ?? undefined,
    is_home: row.is_home === 1,
    target_main_jid: row.target_main_jid ?? undefined,
    target_agent_id: row.target_agent_id ?? undefined,
  }));
}

// ===================== Auth CRUD =====================

function parseUserRole(value: unknown): UserRole {
  return value === 'admin' ? 'admin' : 'member';
}

function parseUserStatus(value: unknown): UserStatus {
  if (value === 'deleted') return 'deleted';
  if (value === 'disabled') return 'disabled';
  return 'active';
}

function parsePermissionsFromDb(raw: unknown, role: UserRole): Permission[] {
  if (typeof raw === 'string') {
    try {
      const parsed = normalizePermissions(JSON.parse(raw));
      if (parsed.length > 0) return parsed;
    } catch {
      // ignore and fall back to role defaults
    }
  }
  return getDefaultPermissions(role);
}

function parseJsonDetails(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function mapUserRow(row: Record<string, unknown>): User {
  const role = parseUserRole(row.role);
  const status = parseUserStatus(row.status);
  return {
    id: String(row.id),
    username: String(row.username),
    password_hash: String(row.password_hash),
    display_name: String(row.display_name ?? ''),
    role,
    status,
    permissions: parsePermissionsFromDb(row.permissions, role),
    must_change_password: !!row.must_change_password,
    disable_reason:
      typeof row.disable_reason === 'string' ? row.disable_reason : null,
    notes: typeof row.notes === 'string' ? row.notes : null,
    avatar_emoji:
      typeof row.avatar_emoji === 'string' ? row.avatar_emoji : null,
    avatar_color:
      typeof row.avatar_color === 'string' ? row.avatar_color : null,
    avatar_url: typeof row.avatar_url === 'string' ? row.avatar_url : null,
    ai_name: typeof row.ai_name === 'string' ? row.ai_name : null,
    ai_avatar_emoji:
      typeof row.ai_avatar_emoji === 'string' ? row.ai_avatar_emoji : null,
    ai_avatar_color:
      typeof row.ai_avatar_color === 'string' ? row.ai_avatar_color : null,
    ai_avatar_url:
      typeof row.ai_avatar_url === 'string' ? row.ai_avatar_url : null,
    default_require_mention: !!row.default_require_mention,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    last_login_at:
      typeof row.last_login_at === 'string' ? row.last_login_at : null,
    deleted_at: typeof row.deleted_at === 'string' ? row.deleted_at : null,
  };
}

function toUserPublic(user: User, lastActiveAt: string | null): UserPublic {
  return {
    id: user.id,
    username: user.username,
    display_name: user.display_name,
    role: user.role,
    status: user.status,
    permissions: user.permissions,
    must_change_password: user.must_change_password,
    disable_reason: user.disable_reason,
    notes: user.notes,
    avatar_emoji: user.avatar_emoji,
    avatar_color: user.avatar_color,
    avatar_url: user.avatar_url,
    ai_name: user.ai_name,
    ai_avatar_emoji: user.ai_avatar_emoji,
    ai_avatar_color: user.ai_avatar_color,
    ai_avatar_url: user.ai_avatar_url,
    default_require_mention: user.default_require_mention,
    created_at: user.created_at,
    last_login_at: user.last_login_at,
    last_active_at: lastActiveAt,
    deleted_at: user.deleted_at,
  };
}

// --- Users ---

export interface CreateUserInput {
  id: string;
  username: string;
  password_hash: string;
  display_name: string;
  role: UserRole;
  status: UserStatus;
  created_at: string;
  updated_at: string;
  permissions?: Permission[];
  must_change_password?: boolean;
  disable_reason?: string | null;
  notes?: string | null;
  last_login_at?: string | null;
  deleted_at?: string | null;
}

function initializeBillingForUser(
  userId: string,
  role: UserRole,
  createdAt: string,
): void {
  const now = createdAt || new Date().toISOString();
  db.prepare(
    'INSERT OR IGNORE INTO user_balances (user_id, balance_usd, total_deposited_usd, total_consumed_usd, updated_at) VALUES (?, 0, 0, 0, ?)',
  ).run(userId, now);

  if (role === 'admin') return;

  const defaultPlan = getDefaultBillingPlan();
  if (!defaultPlan) return;

  const activeSubscription = db
    .prepare(
      "SELECT id FROM user_subscriptions WHERE user_id = ? AND status = 'active'",
    )
    .get(userId) as { id: string } | undefined;
  if (activeSubscription) return;

  const subId = `sub_${userId}_${Date.now()}`;
  db.prepare(
    `INSERT INTO user_subscriptions (id, user_id, plan_id, status, started_at, created_at)
     VALUES (?, ?, ?, 'active', ?, ?)`,
  ).run(subId, userId, defaultPlan.id, now, now);
  db.prepare('UPDATE users SET subscription_plan_id = ? WHERE id = ?').run(
    defaultPlan.id,
    userId,
  );

  const hasOpening = db
    .prepare(
      "SELECT 1 FROM balance_transactions WHERE user_id = ? AND source = 'migration_opening' LIMIT 1",
    )
    .get(userId);
  if (!hasOpening) {
    db.prepare(
      `INSERT INTO balance_transactions (
        user_id, type, amount_usd, balance_after, description, reference_type,
        reference_id, actor_id, source, operator_type, notes, idempotency_key, created_at
      ) VALUES (?, 'adjustment', 0, 0, ?, NULL, NULL, NULL, 'migration_opening', 'system', ?, NULL, ?)`,
    ).run(
      userId,
      '用户钱包初始化',
      '新用户默认余额为 0，需管理员充值或兑换后方可消费',
      now,
    );
  }
}

export function createUser(user: CreateUserInput): void {
  const permissions = normalizePermissions(
    user.permissions ?? getDefaultPermissions(user.role),
  );
  db.prepare(
    `INSERT INTO users (
      id, username, password_hash, display_name, role, status, permissions, must_change_password,
      disable_reason, notes, created_at, updated_at, last_login_at, deleted_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    user.id,
    user.username,
    user.password_hash,
    user.display_name,
    user.role,
    user.status,
    JSON.stringify(permissions),
    user.must_change_password ? 1 : 0,
    user.disable_reason ?? null,
    user.notes ?? null,
    user.created_at,
    user.updated_at,
    user.last_login_at ?? null,
    user.deleted_at ?? null,
  );
  initializeBillingForUser(user.id, user.role, user.created_at);
}

export type CreateInitialAdminResult =
  | { ok: true }
  | { ok: false; reason: 'already_initialized' | 'username_taken' };

export function createInitialAdminUser(
  user: CreateUserInput,
): CreateInitialAdminResult {
  const tx = db.transaction(
    (input: CreateUserInput): CreateInitialAdminResult => {
      const row = db.prepare('SELECT COUNT(*) as count FROM users').get() as {
        count: number;
      };
      if (row.count > 0) return { ok: false, reason: 'already_initialized' };
      createUser(input);
      return { ok: true };
    },
  );

  try {
    return tx(user);
  } catch (err) {
    if (
      err instanceof Error &&
      err.message.includes('UNIQUE constraint failed: users.username')
    ) {
      return { ok: false, reason: 'username_taken' };
    }
    throw err;
  }
}

export function getUserById(id: string): User | undefined {
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? mapUserRow(row) : undefined;
}

export function getUserByUsername(username: string): User | undefined {
  const row = db
    .prepare('SELECT * FROM users WHERE username = ?')
    .get(username) as Record<string, unknown> | undefined;
  return row ? mapUserRow(row) : undefined;
}

export interface ListUsersOptions {
  query?: string;
  role?: UserRole | 'all';
  status?: UserStatus | 'all';
  page?: number;
  pageSize?: number;
}

export interface ListUsersResult {
  users: UserPublic[];
  total: number;
  page: number;
  pageSize: number;
}

export function listUsers(options: ListUsersOptions = {}): ListUsersResult {
  const role = options.role && options.role !== 'all' ? options.role : null;
  const status =
    options.status && options.status !== 'all' ? options.status : null;
  const query = options.query?.trim() || '';
  const page = Math.max(1, Math.floor(options.page || 1));
  const pageSize = Math.min(
    200,
    Math.max(1, Math.floor(options.pageSize || 50)),
  );
  const offset = (page - 1) * pageSize;

  const whereParts: string[] = [];
  const params: unknown[] = [];
  if (role) {
    whereParts.push('u.role = ?');
    params.push(role);
  }
  if (status) {
    whereParts.push('u.status = ?');
    params.push(status);
  } else {
    whereParts.push("u.status != 'deleted'");
  }
  if (query) {
    whereParts.push(
      "(u.username LIKE ? OR u.display_name LIKE ? OR COALESCE(u.notes, '') LIKE ?)",
    );
    const like = `%${query}%`;
    params.push(like, like, like);
  }

  const whereClause =
    whereParts.length > 0 ? `WHERE ${whereParts.join(' AND ')}` : '';

  const totalRow = db
    .prepare(`SELECT COUNT(*) as count FROM users u ${whereClause}`)
    .get(...params) as { count: number };

  const rows = db
    .prepare(
      `
      SELECT u.*, MAX(s.last_active_at) AS last_active_at
      FROM users u
      LEFT JOIN user_sessions s ON s.user_id = u.id
      ${whereClause}
      GROUP BY u.id
      ORDER BY
        CASE u.status
          WHEN 'active' THEN 0
          WHEN 'disabled' THEN 1
          ELSE 2
        END,
        u.created_at DESC
      LIMIT ? OFFSET ?
      `,
    )
    .all(...params, pageSize, offset) as Array<Record<string, unknown>>;

  return {
    users: rows.map((row) => {
      const user = mapUserRow(row);
      const lastActiveAt =
        typeof row.last_active_at === 'string' ? row.last_active_at : null;
      return toUserPublic(user, lastActiveAt);
    }),
    total: totalRow.count,
    page,
    pageSize,
  };
}

export function getAllUsers(): UserPublic[] {
  return listUsers({ role: 'all', status: 'all', page: 1, pageSize: 1000 })
    .users;
}

export function getUserCount(includeDeleted = false): number {
  const row = includeDeleted
    ? (db.prepare('SELECT COUNT(*) as count FROM users').get() as {
        count: number;
      })
    : (db
        .prepare('SELECT COUNT(*) as count FROM users WHERE status != ?')
        .get('deleted') as { count: number });
  return row.count;
}

export function getActiveAdminCount(): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) as count
       FROM users
       WHERE role = 'admin' AND status = 'active'`,
    )
    .get() as { count: number };
  return row.count;
}

export function updateUserFields(
  id: string,
  updates: Partial<
    Pick<
      User,
      | 'username'
      | 'display_name'
      | 'role'
      | 'status'
      | 'password_hash'
      | 'last_login_at'
      | 'permissions'
      | 'must_change_password'
      | 'disable_reason'
      | 'notes'
      | 'avatar_emoji'
      | 'avatar_color'
      | 'avatar_url'
      | 'ai_name'
      | 'ai_avatar_emoji'
      | 'ai_avatar_color'
      | 'ai_avatar_url'
      | 'default_require_mention'
      | 'deleted_at'
    >
  >,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.username !== undefined) {
    fields.push('username = ?');
    values.push(updates.username);
  }
  if (updates.display_name !== undefined) {
    fields.push('display_name = ?');
    values.push(updates.display_name);
  }
  if (updates.role !== undefined) {
    fields.push('role = ?');
    values.push(updates.role);
  }
  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }
  if (updates.password_hash !== undefined) {
    fields.push('password_hash = ?');
    values.push(updates.password_hash);
  }
  if (updates.last_login_at !== undefined) {
    fields.push('last_login_at = ?');
    values.push(updates.last_login_at);
  }
  if (updates.permissions !== undefined) {
    fields.push('permissions = ?');
    values.push(JSON.stringify(normalizePermissions(updates.permissions)));
  }
  if (updates.must_change_password !== undefined) {
    fields.push('must_change_password = ?');
    values.push(updates.must_change_password ? 1 : 0);
  }
  if (updates.disable_reason !== undefined) {
    fields.push('disable_reason = ?');
    values.push(updates.disable_reason);
  }
  if (updates.notes !== undefined) {
    fields.push('notes = ?');
    values.push(updates.notes);
  }
  if (updates.avatar_emoji !== undefined) {
    fields.push('avatar_emoji = ?');
    values.push(updates.avatar_emoji);
  }
  if (updates.avatar_color !== undefined) {
    fields.push('avatar_color = ?');
    values.push(updates.avatar_color);
  }
  if (updates.avatar_url !== undefined) {
    fields.push('avatar_url = ?');
    values.push(updates.avatar_url);
  }
  if (updates.ai_name !== undefined) {
    fields.push('ai_name = ?');
    values.push(updates.ai_name);
  }
  if (updates.ai_avatar_emoji !== undefined) {
    fields.push('ai_avatar_emoji = ?');
    values.push(updates.ai_avatar_emoji);
  }
  if (updates.ai_avatar_color !== undefined) {
    fields.push('ai_avatar_color = ?');
    values.push(updates.ai_avatar_color);
  }
  if (updates.ai_avatar_url !== undefined) {
    fields.push('ai_avatar_url = ?');
    values.push(updates.ai_avatar_url);
  }
  if (updates.default_require_mention !== undefined) {
    fields.push('default_require_mention = ?');
    values.push(updates.default_require_mention ? 1 : 0);
  }
  if (updates.deleted_at !== undefined) {
    fields.push('deleted_at = ?');
    values.push(updates.deleted_at);
  }

  if (fields.length === 0) return;

  fields.push('updated_at = ?');
  values.push(new Date().toISOString());
  values.push(id);

  db.prepare(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`).run(
    ...values,
  );
}

export function deleteUser(id: string): void {
  const now = new Date().toISOString();
  const tx = db.transaction((userId: string) => {
    db.prepare('DELETE FROM user_sessions WHERE user_id = ?').run(userId);
    db.prepare(
      `UPDATE users
       SET status = 'deleted', deleted_at = ?, disable_reason = COALESCE(disable_reason, 'deleted_by_admin'), updated_at = ?
       WHERE id = ?`,
    ).run(now, now, userId);
  });
  tx(id);
}

export function restoreUser(id: string): void {
  db.prepare(
    `UPDATE users
     SET status = 'disabled', deleted_at = NULL, disable_reason = NULL, updated_at = ?
     WHERE id = ?`,
  ).run(new Date().toISOString(), id);
}

// --- User Sessions ---

export function createUserSession(session: UserSession): void {
  db.prepare(
    `INSERT INTO user_sessions (id, user_id, ip_address, user_agent, created_at, expires_at, last_active_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    session.id,
    session.user_id,
    session.ip_address,
    session.user_agent,
    session.created_at,
    session.expires_at,
    session.last_active_at,
  );
}

export function getSessionWithUser(
  sessionId: string,
): UserSessionWithUser | undefined {
  const row = stmts().getSessionWithUser.get(sessionId) as
    | Record<string, unknown>
    | undefined;
  if (!row) return undefined;
  const role = parseUserRole(row.role);
  return {
    id: String(row.id),
    user_id: String(row.user_id),
    ip_address: typeof row.ip_address === 'string' ? row.ip_address : null,
    user_agent: typeof row.user_agent === 'string' ? row.user_agent : null,
    created_at: String(row.created_at),
    expires_at: String(row.expires_at),
    last_active_at: String(row.last_active_at),
    username: String(row.username),
    role,
    status: parseUserStatus(row.status),
    display_name: String(row.display_name ?? ''),
    permissions: parsePermissionsFromDb(row.permissions, role),
    must_change_password: !!row.must_change_password,
  };
}

export function getUserSessions(userId: string): UserSession[] {
  return db
    .prepare(
      `SELECT * FROM user_sessions WHERE user_id = ? ORDER BY last_active_at DESC`,
    )
    .all(userId) as UserSession[];
}

export function deleteUserSession(sessionId: string): void {
  stmts().deleteSession.run(sessionId);
}

export function deleteUserSessionsByUserId(userId: string): void {
  db.prepare('DELETE FROM user_sessions WHERE user_id = ?').run(userId);
}

export function updateSessionLastActive(sessionId: string): void {
  stmts().updateSessionLastActive.run(new Date().toISOString(), sessionId);
}

export function getExpiredSessionIds(): string[] {
  const now = new Date().toISOString();
  return (stmts().getExpiredSessionIds.all(now) as { id: string }[]).map(
    (r) => r.id,
  );
}

export function deleteExpiredSessions(): number {
  const now = new Date().toISOString();
  const result = db
    .prepare('DELETE FROM user_sessions WHERE expires_at < ?')
    .run(now);
  return result.changes;
}

// --- Invite Codes ---

export function createInviteCode(invite: InviteCode): void {
  const permissions = normalizePermissions(invite.permissions);
  db.prepare(
    `INSERT INTO invite_codes (code, created_by, role, permission_template, permissions, max_uses, used_count, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    invite.code,
    invite.created_by,
    invite.role,
    invite.permission_template ?? null,
    JSON.stringify(permissions),
    invite.max_uses,
    invite.used_count,
    invite.expires_at,
    invite.created_at,
  );
}

export function getInviteCode(code: string): InviteCode | undefined {
  const row = db
    .prepare('SELECT * FROM invite_codes WHERE code = ?')
    .get(code) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  const role = parseUserRole(row.role);
  return {
    code: String(row.code),
    created_by: String(row.created_by),
    role,
    permission_template:
      typeof row.permission_template === 'string'
        ? (row.permission_template as PermissionTemplateKey)
        : null,
    permissions: parsePermissionsFromDb(row.permissions, role),
    max_uses: Number(row.max_uses),
    used_count: Number(row.used_count),
    expires_at: typeof row.expires_at === 'string' ? row.expires_at : null,
    created_at: String(row.created_at),
  };
}

export type RegisterUserWithInviteResult =
  | { ok: true; role: UserRole; permissions: Permission[] }
  | {
      ok: false;
      reason:
        | 'invalid_or_expired_invite'
        | 'invite_exhausted'
        | 'username_taken';
    };

export function registerUserWithInvite(input: {
  id: string;
  username: string;
  password_hash: string;
  display_name: string;
  invite_code: string;
  created_at: string;
  updated_at: string;
}): RegisterUserWithInviteResult {
  const tx = db.transaction(
    (params: typeof input): RegisterUserWithInviteResult => {
      const inviteRow = db
        .prepare(
          `SELECT code, role, permissions, max_uses, expires_at
         FROM invite_codes
         WHERE code = ?`,
        )
        .get(params.invite_code) as Record<string, unknown> | undefined;

      if (!inviteRow) return { ok: false, reason: 'invalid_or_expired_invite' };
      const inviteRole = parseUserRole(inviteRow.role);
      const invitePermissions = parsePermissionsFromDb(
        inviteRow.permissions,
        inviteRole,
      );
      const inviteExpiresAt =
        typeof inviteRow.expires_at === 'string' ? inviteRow.expires_at : null;

      if (inviteExpiresAt) {
        const expiresAt = Date.parse(inviteExpiresAt);
        if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) {
          return { ok: false, reason: 'invalid_or_expired_invite' };
        }
      }

      const existing = db
        .prepare('SELECT id FROM users WHERE username = ?')
        .get(params.username) as { id: string } | undefined;
      if (existing) return { ok: false, reason: 'username_taken' };

      const inviteUsage = db
        .prepare(
          `UPDATE invite_codes
         SET used_count = used_count + 1
         WHERE code = ?
           AND (max_uses = 0 OR used_count < max_uses)`,
        )
        .run(params.invite_code);
      if (inviteUsage.changes === 0) {
        return { ok: false, reason: 'invite_exhausted' };
      }

      const permissions = normalizePermissions(invitePermissions);
      db.prepare(
        `INSERT INTO users (
        id, username, password_hash, display_name, role, status, permissions, must_change_password,
        disable_reason, notes, created_at, updated_at, last_login_at, deleted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        params.id,
        params.username,
        params.password_hash,
        params.display_name,
        inviteRole,
        'active',
        JSON.stringify(permissions),
        0,
        null,
        null,
        params.created_at,
        params.updated_at,
        null,
        null,
      );
      initializeBillingForUser(params.id, inviteRole, params.created_at);

      return { ok: true, role: inviteRole, permissions };
    },
  );

  try {
    return tx(input);
  } catch (err) {
    if (
      err instanceof Error &&
      err.message.includes('UNIQUE constraint failed: users.username')
    ) {
      return { ok: false, reason: 'username_taken' };
    }
    throw err;
  }
}

export type RegisterUserWithoutInviteResult =
  | { ok: true; role: UserRole; permissions: Permission[] }
  | { ok: false; reason: 'username_taken' };

export function registerUserWithoutInvite(input: {
  id: string;
  username: string;
  password_hash: string;
  display_name: string;
  created_at: string;
  updated_at: string;
}): RegisterUserWithoutInviteResult {
  const role: UserRole = 'member';
  const permissions: Permission[] = [];

  try {
    db.prepare(
      `INSERT INTO users (
        id, username, password_hash, display_name, role, status, permissions, must_change_password,
        disable_reason, notes, created_at, updated_at, last_login_at, deleted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.id,
      input.username,
      input.password_hash,
      input.display_name,
      role,
      'active',
      JSON.stringify(permissions),
      0,
      null,
      null,
      input.created_at,
      input.updated_at,
      null,
      null,
    );
    initializeBillingForUser(input.id, role, input.created_at);
    return { ok: true, role, permissions };
  } catch (err) {
    if (
      err instanceof Error &&
      err.message.includes('UNIQUE constraint failed: users.username')
    ) {
      return { ok: false, reason: 'username_taken' };
    }
    throw err;
  }
}

export function getAllInviteCodes(): InviteCodeWithCreator[] {
  const rows = db
    .prepare(
      `SELECT i.*, u.username as creator_username
       FROM invite_codes i
       JOIN users u ON i.created_by = u.id
       ORDER BY i.created_at DESC`,
    )
    .all() as Array<Record<string, unknown>>;
  return rows.map((row) => {
    const role = parseUserRole(row.role);
    return {
      code: String(row.code),
      created_by: String(row.created_by),
      creator_username: String(row.creator_username),
      role,
      permission_template:
        typeof row.permission_template === 'string'
          ? (row.permission_template as PermissionTemplateKey)
          : null,
      permissions: parsePermissionsFromDb(row.permissions, role),
      max_uses: Number(row.max_uses),
      used_count: Number(row.used_count),
      expires_at: typeof row.expires_at === 'string' ? row.expires_at : null,
      created_at: String(row.created_at),
    };
  });
}

export function deleteInviteCode(code: string): void {
  db.prepare('DELETE FROM invite_codes WHERE code = ?').run(code);
}

// --- Auth Audit Log ---

export function logAuthEvent(event: {
  event_type: AuthEventType;
  username: string;
  actor_username?: string | null;
  ip_address?: string | null;
  user_agent?: string | null;
  details?: Record<string, unknown> | null;
}): void {
  db.prepare(
    `INSERT INTO auth_audit_log (event_type, username, actor_username, ip_address, user_agent, details, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    event.event_type,
    event.username,
    event.actor_username ?? null,
    event.ip_address ?? null,
    event.user_agent ?? null,
    event.details ? JSON.stringify(event.details) : null,
    new Date().toISOString(),
  );
}

export interface AuthAuditLogQuery {
  limit?: number;
  offset?: number;
  event_type?: AuthEventType | 'all';
  username?: string;
  actor_username?: string;
  from?: string;
  to?: string;
}

export interface AuthAuditLogPage {
  logs: AuthAuditLog[];
  total: number;
  limit: number;
  offset: number;
}

export function queryAuthAuditLogs(
  query: AuthAuditLogQuery = {},
): AuthAuditLogPage {
  const limit = Math.min(500, Math.max(1, Math.floor(query.limit || 100)));
  const offset = Math.max(0, Math.floor(query.offset || 0));

  const whereParts: string[] = [];
  const params: unknown[] = [];
  if (query.event_type && query.event_type !== 'all') {
    whereParts.push('event_type = ?');
    params.push(query.event_type);
  }
  if (query.username?.trim()) {
    whereParts.push('username LIKE ?');
    params.push(`%${query.username.trim()}%`);
  }
  if (query.actor_username?.trim()) {
    whereParts.push('actor_username LIKE ?');
    params.push(`%${query.actor_username.trim()}%`);
  }
  if (query.from) {
    whereParts.push('created_at >= ?');
    params.push(query.from);
  }
  if (query.to) {
    whereParts.push('created_at <= ?');
    params.push(query.to);
  }
  const whereClause =
    whereParts.length > 0 ? `WHERE ${whereParts.join(' AND ')}` : '';

  const total = (
    db
      .prepare(`SELECT COUNT(*) as count FROM auth_audit_log ${whereClause}`)
      .get(...params) as {
      count: number;
    }
  ).count;

  const rows = db
    .prepare(
      `SELECT * FROM auth_audit_log ${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset) as Array<Record<string, unknown>>;

  const logs = rows.map((row) => ({
    id: Number(row.id),
    event_type: row.event_type as AuthEventType,
    username: String(row.username),
    actor_username:
      typeof row.actor_username === 'string' ? row.actor_username : null,
    ip_address: typeof row.ip_address === 'string' ? row.ip_address : null,
    user_agent: typeof row.user_agent === 'string' ? row.user_agent : null,
    details: parseJsonDetails(row.details),
    created_at: String(row.created_at),
  }));

  return { logs, total, limit, offset };
}

export function getAuthAuditLogs(limit = 100, offset = 0): AuthAuditLog[] {
  return queryAuthAuditLogs({ limit, offset }).logs;
}

export function checkLoginRateLimitFromAudit(
  username: string,
  ip: string,
  maxAttempts: number,
  lockoutMinutes: number,
): { allowed: boolean; retryAfterSeconds?: number; attempts: number } {
  if (maxAttempts <= 0) return { allowed: true, attempts: 0 };
  const windowStart = new Date(
    Date.now() - lockoutMinutes * 60 * 1000,
  ).toISOString();
  const rows = db
    .prepare(
      `
      SELECT created_at
      FROM auth_audit_log
      WHERE event_type = 'login_failed'
        AND username = ?
        AND ip_address = ?
        AND created_at >= ?
        AND (details IS NULL OR details NOT LIKE '%"reason":"rate_limited"%')
      ORDER BY created_at ASC
      `,
    )
    .all(username, ip, windowStart) as Array<{ created_at: string }>;

  const attempts = rows.length;
  if (attempts < maxAttempts) return { allowed: true, attempts };

  const oldest = rows[0]?.created_at;
  const oldestTs = oldest ? Date.parse(oldest) : Date.now();
  const retryAt = oldestTs + lockoutMinutes * 60 * 1000;
  const retryAfterSeconds = Math.max(
    1,
    Math.ceil((retryAt - Date.now()) / 1000),
  );
  return { allowed: false, retryAfterSeconds, attempts };
}

// ===================== Group Members =====================

export function addGroupMember(
  groupFolder: string,
  userId: string,
  role: 'owner' | 'member',
  addedBy?: string,
): void {
  db.prepare(
    `INSERT INTO group_members (group_folder, user_id, role, added_at, added_by)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(group_folder, user_id) DO UPDATE SET
       role = CASE WHEN excluded.role = 'owner' THEN 'owner'
                   WHEN group_members.role = 'owner' THEN 'owner'
                   ELSE excluded.role END,
       added_by = COALESCE(excluded.added_by, group_members.added_by)`,
  ).run(groupFolder, userId, role, new Date().toISOString(), addedBy ?? null);
}

export function removeGroupMember(groupFolder: string, userId: string): void {
  db.prepare(
    'DELETE FROM group_members WHERE group_folder = ? AND user_id = ?',
  ).run(groupFolder, userId);
}

export function getGroupMembers(groupFolder: string): GroupMember[] {
  const rows = db
    .prepare(
      `SELECT gm.user_id, gm.role, gm.added_at, gm.added_by,
              u.username, COALESCE(u.display_name, '') as display_name
       FROM group_members gm
       JOIN users u ON gm.user_id = u.id
       WHERE gm.group_folder = ?
       ORDER BY gm.role DESC, gm.added_at ASC`,
    )
    .all(groupFolder) as Array<{
    user_id: string;
    role: string;
    added_at: string;
    added_by: string | null;
    username: string;
    display_name: string;
  }>;
  return rows.map((r) => ({
    user_id: r.user_id,
    role: r.role as 'owner' | 'member',
    added_at: r.added_at,
    added_by: r.added_by ?? undefined,
    username: r.username,
    display_name: r.display_name,
  }));
}

export function getGroupMemberRole(
  groupFolder: string,
  userId: string,
): 'owner' | 'member' | null {
  const row = db
    .prepare(
      'SELECT role FROM group_members WHERE group_folder = ? AND user_id = ?',
    )
    .get(groupFolder, userId) as { role: string } | undefined;
  if (!row) return null;
  return row.role as 'owner' | 'member';
}

export function getUserMemberFolders(
  userId: string,
): Array<{ group_folder: string; role: 'owner' | 'member' }> {
  const rows = db
    .prepare('SELECT group_folder, role FROM group_members WHERE user_id = ?')
    .all(userId) as Array<{ group_folder: string; role: string }>;
  return rows.map((r) => ({
    group_folder: r.group_folder,
    role: r.role as 'owner' | 'member',
  }));
}

// ===================== Sub-Agent CRUD =====================

export function createAgent(agent: SubAgent): void {
  db.prepare(
    `INSERT INTO agents (id, group_folder, chat_jid, name, prompt, status, kind, created_by, created_at, completed_at, result_summary, spawned_from_jid, source_kind, thread_id, root_message_id, title_source, last_active_at, last_im_jid)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    agent.id,
    agent.group_folder,
    agent.chat_jid,
    agent.name,
    agent.prompt,
    agent.status,
    agent.kind || 'task',
    agent.created_by ?? null,
    agent.created_at,
    agent.completed_at ?? null,
    agent.result_summary ?? null,
    agent.spawned_from_jid ?? null,
    agent.source_kind ?? null,
    agent.thread_id ?? null,
    agent.root_message_id ?? null,
    agent.title_source ?? null,
    agent.last_active_at ?? null,
    agent.last_im_jid ?? null,
  );
}

export function getAgent(id: string): SubAgent | undefined {
  const row = db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;
  if (!row) return undefined;
  return mapAgentRow(row);
}

export function listAgentsByFolder(folder: string): SubAgent[] {
  const rows = db
    .prepare(
      'SELECT * FROM agents WHERE group_folder = ? ORDER BY created_at DESC',
    )
    .all(folder) as Array<Record<string, unknown>>;
  return rows.map(mapAgentRow);
}

export function listAgentsByJid(chatJid: string): SubAgent[] {
  const rows = db
    .prepare('SELECT * FROM agents WHERE chat_jid = ? ORDER BY created_at DESC')
    .all(chatJid) as Array<Record<string, unknown>>;
  return rows.map(mapAgentRow);
}

export function updateAgentStatus(
  id: string,
  status: AgentStatus,
  resultSummary?: string,
): void {
  const completedAt =
    status !== 'running' && status !== 'idle' ? new Date().toISOString() : null;
  db.prepare(
    'UPDATE agents SET status = ?, completed_at = ?, result_summary = ? WHERE id = ?',
  ).run(status, completedAt, resultSummary ?? null, id);
}

export function updateAgentLastImJid(
  id: string,
  lastImJid: string | null,
): void {
  db.prepare('UPDATE agents SET last_im_jid = ? WHERE id = ?').run(
    lastImJid,
    id,
  );
}

export function updateAgentInfo(
  id: string,
  name: string,
  prompt: string,
): void {
  db.prepare('UPDATE agents SET name = ?, prompt = ? WHERE id = ?').run(
    name,
    prompt,
    id,
  );
}

export function updateAgentContextInfo(
  id: string,
  updates: Partial<
    Pick<
      SubAgent,
      | 'name'
      | 'source_kind'
      | 'thread_id'
      | 'root_message_id'
      | 'title_source'
      | 'last_active_at'
    >
  >,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];
  if (updates.name !== undefined) {
    fields.push('name = ?');
    values.push(updates.name);
  }
  if (updates.source_kind !== undefined) {
    fields.push('source_kind = ?');
    values.push(updates.source_kind);
  }
  if (updates.thread_id !== undefined) {
    fields.push('thread_id = ?');
    values.push(updates.thread_id);
  }
  if (updates.root_message_id !== undefined) {
    fields.push('root_message_id = ?');
    values.push(updates.root_message_id);
  }
  if (updates.title_source !== undefined) {
    fields.push('title_source = ?');
    values.push(updates.title_source);
  }
  if (updates.last_active_at !== undefined) {
    fields.push('last_active_at = ?');
    values.push(updates.last_active_at);
  }
  if (fields.length === 0) return;
  values.push(id);
  db.prepare(`UPDATE agents SET ${fields.join(', ')} WHERE id = ?`).run(
    ...values,
  );
}

export function deleteCompletedAgents(beforeTimestamp: string): number {
  const result = db
    .prepare(
      "DELETE FROM agents WHERE kind IN ('task', 'spawn') AND status IN ('completed', 'error') AND completed_at IS NOT NULL AND completed_at < ?",
    )
    .run(beforeTimestamp);
  return result.changes;
}

export function getRunningTaskAgentsByChat(chatJid: string): SubAgent[] {
  const rows = db
    .prepare(
      "SELECT * FROM agents WHERE chat_jid = ? AND kind = 'task' AND status = 'running'",
    )
    .all(chatJid) as Array<Record<string, unknown>>;
  return rows.map(mapAgentRow);
}

export function markRunningTaskAgentsAsError(chatJid: string): number {
  const now = new Date().toISOString();
  const result = db
    .prepare(
      "UPDATE agents SET status = 'error', completed_at = ? WHERE chat_jid = ? AND kind = 'task' AND status = 'running'",
    )
    .run(now, chatJid);
  return result.changes;
}

export function markAllRunningTaskAgentsAsError(
  summary = '进程重启，任务中断',
): number {
  const now = new Date().toISOString();
  const result = db
    .prepare(
      "UPDATE agents SET status = 'error', completed_at = ?, result_summary = COALESCE(result_summary, ?) WHERE kind = 'task' AND status = 'running'",
    )
    .run(now, summary);
  return result.changes;
}

/**
 * Mark stale spawn agents (idle/running) as error at startup.
 * After a process restart, spawn agents that were idle or running can never
 * resume — their in-memory task callbacks are lost. Mark them as error so
 * they don't render as "正在思考..." in the frontend.
 */
export function markStaleSpawnAgentsAsError(
  summary = '进程重启，并行任务中断',
): number {
  const now = new Date().toISOString();
  const result = db
    .prepare(
      "UPDATE agents SET status = 'error', completed_at = ?, result_summary = COALESCE(result_summary, ?) WHERE kind = 'spawn' AND status IN ('idle', 'running')",
    )
    .run(now, summary);
  return result.changes;
}

export function listActiveConversationAgents(): SubAgent[] {
  return (
    db
      .prepare(
        "SELECT * FROM agents WHERE kind IN ('conversation', 'spawn') AND status IN ('running', 'idle')",
      )
      .all() as Record<string, unknown>[]
  ).map(mapAgentRow);
}

export function deleteAgent(id: string): void {
  // Delete associated session
  db.prepare('DELETE FROM sessions WHERE agent_id = ?').run(id);
  deleteImContextBindingsByAgent(id);
  db.prepare('DELETE FROM agents WHERE id = ?').run(id);
}

function mapAgentRow(row: Record<string, unknown>): SubAgent {
  return {
    id: String(row.id),
    group_folder: String(row.group_folder),
    chat_jid: String(row.chat_jid),
    name: String(row.name),
    prompt: String(row.prompt),
    status: (row.status as AgentStatus) || 'running',
    kind: (row.kind as AgentKind) || 'task',
    created_by: typeof row.created_by === 'string' ? row.created_by : null,
    created_at: String(row.created_at),
    completed_at:
      typeof row.completed_at === 'string' ? row.completed_at : null,
    result_summary:
      typeof row.result_summary === 'string' ? row.result_summary : null,
    last_im_jid: typeof row.last_im_jid === 'string' ? row.last_im_jid : null,
    spawned_from_jid:
      typeof row.spawned_from_jid === 'string' ? row.spawned_from_jid : null,
    source_kind:
      typeof row.source_kind === 'string'
        ? (row.source_kind as 'manual' | 'feishu_thread' | 'auto_im')
        : null,
    thread_id: typeof row.thread_id === 'string' ? row.thread_id : null,
    root_message_id:
      typeof row.root_message_id === 'string' ? row.root_message_id : null,
    title_source:
      typeof row.title_source === 'string'
        ? (row.title_source as
            | 'manual'
            | 'feishu_root'
            | 'auto'
            | 'auto_pending')
        : null,
    last_active_at:
      typeof row.last_active_at === 'string' ? row.last_active_at : null,
  };
}

export function deleteMessagesForChatJid(chatJid: string): void {
  archiveChatRecord(chatJid, 'chat_messages_deleted');
  db.prepare('DELETE FROM messages WHERE chat_jid = ?').run(chatJid);
}

export function getMessage(
  chatJid: string,
  messageId: string,
): {
  id: string;
  chat_jid: string;
  sender: string | null;
  is_from_me: number;
} | null {
  const row = db
    .prepare(
      'SELECT id, chat_jid, sender, is_from_me FROM messages WHERE id = ? AND chat_jid = ?',
    )
    .get(messageId, chatJid) as
    | {
        id: string;
        chat_jid: string;
        sender: string | null;
        is_from_me: number;
      }
    | undefined;
  return row ?? null;
}

export function deleteMessage(chatJid: string, messageId: string): boolean {
  const result = db
    .prepare('DELETE FROM messages WHERE id = ? AND chat_jid = ?')
    .run(messageId, chatJid);
  return result.changes > 0;
}

export function isGroupShared(groupFolder: string): boolean {
  const row = db
    .prepare('SELECT COUNT(*) as cnt FROM group_members WHERE group_folder = ?')
    .get(groupFolder) as { cnt: number };
  return row.cnt > 1;
}

// --- Billing CRUD functions ---

export function getBillingPlan(id: string): BillingPlan | undefined {
  const row = db.prepare('SELECT * FROM billing_plans WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? mapBillingPlanRow(row) : undefined;
}

export function getActiveBillingPlans(): BillingPlan[] {
  return (
    db
      .prepare(
        'SELECT * FROM billing_plans WHERE is_active = 1 ORDER BY tier ASC, name ASC',
      )
      .all() as Record<string, unknown>[]
  ).map(mapBillingPlanRow);
}

export function getAllBillingPlans(): BillingPlan[] {
  return (
    db
      .prepare('SELECT * FROM billing_plans ORDER BY tier ASC, name ASC')
      .all() as Record<string, unknown>[]
  ).map(mapBillingPlanRow);
}

export function getDefaultBillingPlan(): BillingPlan | undefined {
  const row = db
    .prepare('SELECT * FROM billing_plans WHERE is_default = 1')
    .get() as Record<string, unknown> | undefined;
  return row ? mapBillingPlanRow(row) : undefined;
}

export function createBillingPlan(plan: BillingPlan): void {
  db.transaction(() => {
    // Clear old default BEFORE inserting the new plan to avoid brief dual-default
    if (plan.is_default) {
      db.prepare(
        'UPDATE billing_plans SET is_default = 0 WHERE is_default = 1',
      ).run();
    }
    db.prepare(
      `INSERT INTO billing_plans (id, name, description, tier, monthly_cost_usd, monthly_token_quota, monthly_cost_quota,
       daily_cost_quota, weekly_cost_quota, daily_token_quota, weekly_token_quota,
       rate_multiplier, trial_days, sort_order, display_price, highlight,
       max_groups, max_concurrent_containers, max_im_channels, max_mcp_servers, max_storage_mb,
       allow_overage, features, is_default, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      plan.id,
      plan.name,
      plan.description,
      plan.tier,
      plan.monthly_cost_usd,
      plan.monthly_token_quota,
      plan.monthly_cost_quota,
      plan.daily_cost_quota,
      plan.weekly_cost_quota,
      plan.daily_token_quota,
      plan.weekly_token_quota,
      plan.rate_multiplier,
      plan.trial_days,
      plan.sort_order,
      plan.display_price,
      plan.highlight ? 1 : 0,
      plan.max_groups,
      plan.max_concurrent_containers,
      plan.max_im_channels,
      plan.max_mcp_servers,
      plan.max_storage_mb,
      plan.allow_overage ? 1 : 0,
      JSON.stringify(plan.features),
      plan.is_default ? 1 : 0,
      plan.is_active ? 1 : 0,
      plan.created_at,
      plan.updated_at,
    );
  })();
}

export function updateBillingPlan(
  id: string,
  updates: Partial<Omit<BillingPlan, 'id' | 'created_at'>>,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.name !== undefined) {
    fields.push('name = ?');
    values.push(updates.name);
  }
  if (updates.description !== undefined) {
    fields.push('description = ?');
    values.push(updates.description);
  }
  if (updates.tier !== undefined) {
    fields.push('tier = ?');
    values.push(updates.tier);
  }
  if (updates.monthly_cost_usd !== undefined) {
    fields.push('monthly_cost_usd = ?');
    values.push(updates.monthly_cost_usd);
  }
  if (updates.monthly_token_quota !== undefined) {
    fields.push('monthly_token_quota = ?');
    values.push(updates.monthly_token_quota);
  }
  if (updates.monthly_cost_quota !== undefined) {
    fields.push('monthly_cost_quota = ?');
    values.push(updates.monthly_cost_quota);
  }
  if (updates.daily_cost_quota !== undefined) {
    fields.push('daily_cost_quota = ?');
    values.push(updates.daily_cost_quota);
  }
  if (updates.weekly_cost_quota !== undefined) {
    fields.push('weekly_cost_quota = ?');
    values.push(updates.weekly_cost_quota);
  }
  if (updates.daily_token_quota !== undefined) {
    fields.push('daily_token_quota = ?');
    values.push(updates.daily_token_quota);
  }
  if (updates.weekly_token_quota !== undefined) {
    fields.push('weekly_token_quota = ?');
    values.push(updates.weekly_token_quota);
  }
  if (updates.rate_multiplier !== undefined) {
    fields.push('rate_multiplier = ?');
    values.push(updates.rate_multiplier);
  }
  if (updates.trial_days !== undefined) {
    fields.push('trial_days = ?');
    values.push(updates.trial_days);
  }
  if (updates.sort_order !== undefined) {
    fields.push('sort_order = ?');
    values.push(updates.sort_order);
  }
  if (updates.display_price !== undefined) {
    fields.push('display_price = ?');
    values.push(updates.display_price);
  }
  if (updates.highlight !== undefined) {
    fields.push('highlight = ?');
    values.push(updates.highlight ? 1 : 0);
  }
  if (updates.max_groups !== undefined) {
    fields.push('max_groups = ?');
    values.push(updates.max_groups);
  }
  if (updates.max_concurrent_containers !== undefined) {
    fields.push('max_concurrent_containers = ?');
    values.push(updates.max_concurrent_containers);
  }
  if (updates.max_im_channels !== undefined) {
    fields.push('max_im_channels = ?');
    values.push(updates.max_im_channels);
  }
  if (updates.max_mcp_servers !== undefined) {
    fields.push('max_mcp_servers = ?');
    values.push(updates.max_mcp_servers);
  }
  if (updates.max_storage_mb !== undefined) {
    fields.push('max_storage_mb = ?');
    values.push(updates.max_storage_mb);
  }
  if (updates.allow_overage !== undefined) {
    fields.push('allow_overage = ?');
    values.push(updates.allow_overage ? 1 : 0);
  }
  if (updates.features !== undefined) {
    fields.push('features = ?');
    values.push(JSON.stringify(updates.features));
  }
  if (updates.is_default !== undefined) {
    fields.push('is_default = ?');
    values.push(updates.is_default ? 1 : 0);
  }
  if (updates.is_active !== undefined) {
    fields.push('is_active = ?');
    values.push(updates.is_active ? 1 : 0);
  }

  if (fields.length === 0) return;

  fields.push('updated_at = ?');
  values.push(new Date().toISOString());
  values.push(id);

  db.transaction(() => {
    // Clear old default BEFORE setting new one to avoid brief dual-default state
    if (updates.is_default) {
      db.prepare('UPDATE billing_plans SET is_default = 0 WHERE id != ?').run(
        id,
      );
    }
    db.prepare(
      `UPDATE billing_plans SET ${fields.join(', ')} WHERE id = ?`,
    ).run(...values);
  })();
}

export function deleteBillingPlan(id: string): boolean {
  // Don't delete if users are subscribed
  const hasSubscribers = db
    .prepare(
      "SELECT COUNT(*) as cnt FROM user_subscriptions WHERE plan_id = ? AND status = 'active'",
    )
    .get(id) as { cnt: number };
  if (hasSubscribers.cnt > 0) return false;
  const result = db.prepare('DELETE FROM billing_plans WHERE id = ?').run(id);
  return result.changes > 0;
}

function mapBillingPlanRow(row: Record<string, unknown>): BillingPlan {
  return {
    id: String(row.id),
    name: String(row.name),
    description: typeof row.description === 'string' ? row.description : null,
    tier: Number(row.tier) || 0,
    monthly_cost_usd: Number(row.monthly_cost_usd) || 0,
    monthly_token_quota:
      row.monthly_token_quota != null ? Number(row.monthly_token_quota) : null,
    monthly_cost_quota:
      row.monthly_cost_quota != null ? Number(row.monthly_cost_quota) : null,
    daily_cost_quota:
      row.daily_cost_quota != null ? Number(row.daily_cost_quota) : null,
    weekly_cost_quota:
      row.weekly_cost_quota != null ? Number(row.weekly_cost_quota) : null,
    daily_token_quota:
      row.daily_token_quota != null ? Number(row.daily_token_quota) : null,
    weekly_token_quota:
      row.weekly_token_quota != null ? Number(row.weekly_token_quota) : null,
    rate_multiplier: Number(row.rate_multiplier) || 1.0,
    trial_days: row.trial_days != null ? Number(row.trial_days) : null,
    sort_order: Number(row.sort_order) || 0,
    display_price:
      typeof row.display_price === 'string' ? row.display_price : null,
    highlight: !!(row.highlight as number),
    max_groups: row.max_groups != null ? Number(row.max_groups) : null,
    max_concurrent_containers:
      row.max_concurrent_containers != null
        ? Number(row.max_concurrent_containers)
        : null,
    max_im_channels:
      row.max_im_channels != null ? Number(row.max_im_channels) : null,
    max_mcp_servers:
      row.max_mcp_servers != null ? Number(row.max_mcp_servers) : null,
    max_storage_mb:
      row.max_storage_mb != null ? Number(row.max_storage_mb) : null,
    allow_overage: !!(row.allow_overage as number),
    features: safeParseJsonArray(row.features),
    is_default: !!(row.is_default as number),
    is_active: !!(row.is_active as number),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

function safeParseJsonArray(val: unknown): string[] {
  if (typeof val !== 'string') return [];
  try {
    const parsed = JSON.parse(val);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// --- User Subscriptions ---

export function getUserActiveSubscription(
  userId: string,
): (UserSubscription & { plan: BillingPlan }) | undefined {
  const row = db
    .prepare(
      `SELECT s.*, p.name as plan_name FROM user_subscriptions s
       JOIN billing_plans p ON s.plan_id = p.id
       WHERE s.user_id = ? AND s.status = 'active'
       ORDER BY s.created_at DESC LIMIT 1`,
    )
    .get(userId) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  const plan = getBillingPlan(String(row.plan_id));
  if (!plan) return undefined;
  return { ...mapSubscriptionRow(row), plan };
}

export function createUserSubscription(sub: UserSubscription): void {
  // Cancel existing active subscriptions
  db.prepare(
    "UPDATE user_subscriptions SET status = 'cancelled', cancelled_at = ? WHERE user_id = ? AND status = 'active'",
  ).run(new Date().toISOString(), sub.user_id);

  db.prepare(
    `INSERT INTO user_subscriptions (id, user_id, plan_id, status, started_at, expires_at, cancelled_at, trial_ends_at, notes, auto_renew, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    sub.id,
    sub.user_id,
    sub.plan_id,
    sub.status,
    sub.started_at,
    sub.expires_at,
    sub.cancelled_at,
    sub.trial_ends_at,
    sub.notes,
    sub.auto_renew ? 1 : 0,
    sub.created_at,
  );

  // Update user's subscription_plan_id
  db.prepare('UPDATE users SET subscription_plan_id = ? WHERE id = ?').run(
    sub.plan_id,
    sub.user_id,
  );
}

export function cancelUserSubscription(userId: string): void {
  const now = new Date().toISOString();
  db.prepare(
    "UPDATE user_subscriptions SET status = 'cancelled', cancelled_at = ? WHERE user_id = ? AND status = 'active'",
  ).run(now, userId);
  db.prepare('UPDATE users SET subscription_plan_id = NULL WHERE id = ?').run(
    userId,
  );
}

export function expireSubscriptions(): number {
  const now = new Date().toISOString();

  // Phase 1: Handle auto_renew=1 subscriptions — renew them instead of expiring
  const renewableRows = db
    .prepare(
      "SELECT * FROM user_subscriptions WHERE status = 'active' AND auto_renew = 1 AND expires_at IS NOT NULL AND expires_at <= ?",
    )
    .all(now) as Record<string, unknown>[];

  let renewed = 0;
  for (const row of renewableRows) {
    const userId = String(row.user_id);
    const planId = String(row.plan_id);
    const oldId = String(row.id);
    const oldStarted = String(row.started_at);
    const oldExpires = String(row.expires_at);

    // Calculate same duration as original subscription
    const startMs = new Date(oldStarted).getTime();
    const expiresMs = new Date(oldExpires).getTime();
    const durationMs = expiresMs - startMs;
    if (durationMs <= 0) continue;

    const plan = getBillingPlan(planId);
    if (!plan || !plan.is_active) {
      // Plan no longer active, expire instead
      continue;
    }

    // Check if user has sufficient balance for paid plans
    if (plan.monthly_cost_usd > 0) {
      const balance = getUserBalance(userId);
      if (balance.balance_usd < plan.monthly_cost_usd) {
        // Insufficient balance, expire instead
        logBillingAudit('subscription_expired', userId, null, {
          planId,
          planName: plan.name,
          reason: 'insufficient_balance_for_renewal',
          balance: balance.balance_usd,
          required: plan.monthly_cost_usd,
        });
        continue;
      }
    }

    // Wrap the entire renewal in a transaction for atomicity
    const renewTx = db.transaction(() => {
      // Deduct subscription cost (if paid plan)
      if (plan.monthly_cost_usd > 0) {
        adjustUserBalance(
          userId,
          -plan.monthly_cost_usd,
          'deduction',
          `自动续费: ${plan.name}`,
          'subscription',
          oldId,
          null,
          null,
          {
            source: 'subscription_renewal',
            operatorType: 'system',
            notes: `自动续费扣款: ${plan.name}`,
          },
        );
      }

      // Expire old subscription
      db.prepare(
        "UPDATE user_subscriptions SET status = 'expired' WHERE id = ?",
      ).run(oldId);

      // Create new subscription with same duration
      const newNow = new Date();
      const newExpires = new Date(newNow.getTime() + durationMs).toISOString();
      const newSub = {
        id: `sub_${userId}_${Date.now()}_renew`,
        user_id: userId,
        plan_id: planId,
        status: 'active',
        started_at: newNow.toISOString(),
        expires_at: newExpires,
        cancelled_at: null,
        trial_ends_at: null,
        notes: '自动续费',
        auto_renew: 1,
        created_at: newNow.toISOString(),
      };

      db.prepare(
        `INSERT INTO user_subscriptions (id, user_id, plan_id, status, started_at, expires_at, cancelled_at, trial_ends_at, notes, auto_renew, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        newSub.id,
        newSub.user_id,
        newSub.plan_id,
        newSub.status,
        newSub.started_at,
        newSub.expires_at,
        newSub.cancelled_at,
        newSub.trial_ends_at,
        newSub.notes,
        newSub.auto_renew,
        newSub.created_at,
      );

      logBillingAudit('subscription_assigned', userId, null, {
        planId,
        planName: plan.name,
        autoRenew: true,
        renewedFrom: oldId,
      });
    });

    try {
      renewTx();
      renewed++;
    } catch (err) {
      logBillingAudit('subscription_expired', userId, null, {
        planId,
        planName: plan.name,
        reason: 'renewal_transaction_failed',
        error: String(err),
      });
    }
  }

  // Phase 2: Expire remaining (non-auto-renew or failed renewal)
  const result = db
    .prepare(
      "UPDATE user_subscriptions SET status = 'expired' WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at <= ?",
    )
    .run(now);
  return result.changes + renewed;
}

export function updateSubscriptionAutoRenew(
  userId: string,
  autoRenew: boolean,
): boolean {
  const result = db
    .prepare(
      "UPDATE user_subscriptions SET auto_renew = ? WHERE user_id = ? AND status = 'active'",
    )
    .run(autoRenew ? 1 : 0, userId);
  return result.changes > 0;
}

function mapSubscriptionRow(row: Record<string, unknown>): UserSubscription {
  return {
    id: String(row.id),
    user_id: String(row.user_id),
    plan_id: String(row.plan_id),
    status: String(row.status) as UserSubscription['status'],
    started_at: String(row.started_at),
    expires_at: typeof row.expires_at === 'string' ? row.expires_at : null,
    cancelled_at:
      typeof row.cancelled_at === 'string' ? row.cancelled_at : null,
    trial_ends_at:
      typeof row.trial_ends_at === 'string' ? row.trial_ends_at : null,
    notes: typeof row.notes === 'string' ? row.notes : null,
    auto_renew: !!(row.auto_renew as number),
    created_at: String(row.created_at),
  };
}

// --- User Balances ---

export function getUserBalance(userId: string): UserBalance {
  const row = db
    .prepare('SELECT * FROM user_balances WHERE user_id = ?')
    .get(userId) as Record<string, unknown> | undefined;
  if (!row) {
    // Auto-init balance
    const now = new Date().toISOString();
    db.prepare(
      'INSERT OR IGNORE INTO user_balances (user_id, balance_usd, total_deposited_usd, total_consumed_usd, updated_at) VALUES (?, 0, 0, 0, ?)',
    ).run(userId, now);
    return {
      user_id: userId,
      balance_usd: 0,
      total_deposited_usd: 0,
      total_consumed_usd: 0,
      updated_at: now,
    };
  }
  return {
    user_id: String(row.user_id),
    balance_usd: Number(row.balance_usd) || 0,
    total_deposited_usd: Number(row.total_deposited_usd) || 0,
    total_consumed_usd: Number(row.total_consumed_usd) || 0,
    updated_at: String(row.updated_at),
  };
}

export function adjustUserBalance(
  userId: string,
  amount: number,
  type: BalanceTransactionType,
  description: string | null,
  referenceType: BalanceReferenceType | null,
  referenceId: string | null,
  actorId: string | null,
  idempotencyKey?: string | null,
  options?: {
    source?: BalanceTransactionSource;
    operatorType?: BalanceOperatorType;
    notes?: string | null;
    allowNegative?: boolean;
  },
): BalanceTransaction {
  const source = options?.source ?? 'system_adjustment';
  const operatorType = options?.operatorType ?? 'system';
  const notes = options?.notes ?? description ?? null;
  const allowNegative = options?.allowNegative ?? false;

  // Idempotency check: if key already used, return the existing transaction
  if (idempotencyKey) {
    const existing = db
      .prepare('SELECT * FROM balance_transactions WHERE idempotency_key = ?')
      .get(idempotencyKey) as Record<string, unknown> | undefined;
    if (existing) {
      return {
        id: Number(existing.id),
        user_id: String(existing.user_id),
        type: String(existing.type) as BalanceTransactionType,
        amount_usd: Number(existing.amount_usd),
        balance_after: Number(existing.balance_after),
        description:
          typeof existing.description === 'string'
            ? existing.description
            : null,
        reference_type:
          typeof existing.reference_type === 'string'
            ? (existing.reference_type as BalanceReferenceType)
            : null,
        reference_id:
          typeof existing.reference_id === 'string'
            ? existing.reference_id
            : null,
        actor_id:
          typeof existing.actor_id === 'string' ? existing.actor_id : null,
        source:
          typeof existing.source === 'string'
            ? (existing.source as BalanceTransactionSource)
            : 'system_adjustment',
        operator_type:
          typeof existing.operator_type === 'string'
            ? (existing.operator_type as BalanceOperatorType)
            : 'system',
        notes: typeof existing.notes === 'string' ? existing.notes : null,
        idempotency_key:
          typeof existing.idempotency_key === 'string'
            ? existing.idempotency_key
            : null,
        created_at: String(existing.created_at),
      };
    }
  }

  const now = new Date().toISOString();

  // Wrap read-check-update-record in a transaction for atomicity
  const txFn = db.transaction(() => {
    // Ensure balance row exists
    db.prepare(
      'INSERT OR IGNORE INTO user_balances (user_id, balance_usd, total_deposited_usd, total_consumed_usd, updated_at) VALUES (?, 0, 0, 0, ?)',
    ).run(userId, now);

    const currentRow = db
      .prepare('SELECT balance_usd FROM user_balances WHERE user_id = ?')
      .get(userId) as { balance_usd: number };
    const currentBalance = Number(currentRow.balance_usd);
    const nextBalance = currentBalance + amount;
    if (!allowNegative && nextBalance < 0) {
      throw new Error(
        `Balance cannot be negative: current=${currentBalance.toFixed(2)} next=${nextBalance.toFixed(2)}`,
      );
    }

    // Update balance
    if (amount > 0) {
      db.prepare(
        'UPDATE user_balances SET balance_usd = balance_usd + ?, total_deposited_usd = total_deposited_usd + ?, updated_at = ? WHERE user_id = ?',
      ).run(amount, amount, now, userId);
    } else {
      db.prepare(
        'UPDATE user_balances SET balance_usd = balance_usd + ?, total_consumed_usd = total_consumed_usd + ?, updated_at = ? WHERE user_id = ?',
      ).run(amount, Math.abs(amount), now, userId);
    }

    // Read new balance within the same transaction
    const newRow = db
      .prepare('SELECT balance_usd FROM user_balances WHERE user_id = ?')
      .get(userId) as { balance_usd: number };
    const balanceAfter = Number(newRow.balance_usd);

    // Record transaction
    const result = db
      .prepare(
        `INSERT INTO balance_transactions (
        user_id, type, amount_usd, balance_after, description, reference_type,
        reference_id, actor_id, source, operator_type, notes, created_at, idempotency_key
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        userId,
        type,
        amount,
        balanceAfter,
        description,
        referenceType,
        referenceId,
        actorId,
        source,
        operatorType,
        notes,
        now,
        idempotencyKey ?? null,
      );

    return {
      id: Number(result.lastInsertRowid),
      balanceAfter,
    };
  });

  const { id: txId, balanceAfter } = txFn();

  return {
    id: txId,
    user_id: userId,
    type,
    amount_usd: amount,
    balance_after: balanceAfter,
    description,
    reference_type: referenceType,
    reference_id: referenceId,
    actor_id: actorId,
    source,
    operator_type: operatorType,
    notes,
    idempotency_key: idempotencyKey ?? null,
    created_at: now,
  };
}

export function getBalanceTransactions(
  userId: string,
  limit = 50,
  offset = 0,
): { transactions: BalanceTransaction[]; total: number } {
  const total = (
    db
      .prepare(
        'SELECT COUNT(*) as cnt FROM balance_transactions WHERE user_id = ?',
      )
      .get(userId) as { cnt: number }
  ).cnt;

  const rows = db
    .prepare(
      'SELECT * FROM balance_transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?',
    )
    .all(userId, limit, offset) as Record<string, unknown>[];

  return {
    transactions: rows.map((r) => ({
      id: Number(r.id),
      user_id: String(r.user_id),
      type: String(r.type) as BalanceTransactionType,
      amount_usd: Number(r.amount_usd),
      balance_after: Number(r.balance_after),
      description: typeof r.description === 'string' ? r.description : null,
      reference_type:
        typeof r.reference_type === 'string'
          ? (r.reference_type as BalanceReferenceType)
          : null,
      reference_id: typeof r.reference_id === 'string' ? r.reference_id : null,
      actor_id: typeof r.actor_id === 'string' ? r.actor_id : null,
      source:
        typeof r.source === 'string'
          ? (r.source as BalanceTransactionSource)
          : 'system_adjustment',
      operator_type:
        typeof r.operator_type === 'string'
          ? (r.operator_type as BalanceOperatorType)
          : 'system',
      notes: typeof r.notes === 'string' ? r.notes : null,
      idempotency_key:
        typeof r.idempotency_key === 'string' ? r.idempotency_key : null,
      created_at: String(r.created_at),
    })),
    total,
  };
}

// --- Monthly Usage ---

function mapMonthlyUsageRow(row: Record<string, unknown>): MonthlyUsage {
  return {
    user_id: String(row.user_id),
    month: String(row.month),
    total_input_tokens: Number(row.total_input_tokens) || 0,
    total_output_tokens: Number(row.total_output_tokens) || 0,
    total_cost_usd: Number(row.total_cost_usd) || 0,
    message_count: Number(row.message_count) || 0,
    updated_at: String(row.updated_at),
  };
}

export function getMonthlyUsage(
  userId: string,
  month: string,
): MonthlyUsage | undefined {
  const row = db
    .prepare('SELECT * FROM monthly_usage WHERE user_id = ? AND month = ?')
    .get(userId, month) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return mapMonthlyUsageRow(row);
}

export function incrementMonthlyUsage(
  userId: string,
  month: string,
  inputTokens: number,
  outputTokens: number,
  costUsd: number,
): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO monthly_usage (user_id, month, total_input_tokens, total_output_tokens, total_cost_usd, message_count, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, ?)
     ON CONFLICT(user_id, month) DO UPDATE SET
       total_input_tokens = total_input_tokens + excluded.total_input_tokens,
       total_output_tokens = total_output_tokens + excluded.total_output_tokens,
       total_cost_usd = total_cost_usd + excluded.total_cost_usd,
       message_count = message_count + 1,
       updated_at = excluded.updated_at`,
  ).run(userId, month, inputTokens, outputTokens, costUsd, now);
}

export function getUserMonthlyUsageHistory(
  userId: string,
  months = 6,
): MonthlyUsage[] {
  return (
    db
      .prepare(
        'SELECT * FROM monthly_usage WHERE user_id = ? ORDER BY month DESC LIMIT ?',
      )
      .all(userId, months) as Record<string, unknown>[]
  ).map(mapMonthlyUsageRow);
}

// --- Redeem Codes ---

export function getRedeemCode(code: string): RedeemCode | undefined {
  const row = db
    .prepare('SELECT * FROM redeem_codes WHERE code = ?')
    .get(code) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return mapRedeemCodeRow(row);
}

export function getAllRedeemCodes(): RedeemCode[] {
  return (
    db
      .prepare('SELECT * FROM redeem_codes ORDER BY created_at DESC')
      .all() as Record<string, unknown>[]
  ).map(mapRedeemCodeRow);
}

export function createRedeemCode(code: RedeemCode): void {
  db.prepare(
    `INSERT INTO redeem_codes (code, type, value_usd, plan_id, duration_days, max_uses, used_count, expires_at, created_by, notes, batch_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    code.code,
    code.type,
    code.value_usd,
    code.plan_id,
    code.duration_days,
    code.max_uses,
    code.used_count,
    code.expires_at,
    code.created_by,
    code.notes,
    code.batch_id,
    code.created_at,
  );
}

export function incrementRedeemCodeUsage(code: string, userId: string): void {
  const now = new Date().toISOString();
  db.prepare(
    'UPDATE redeem_codes SET used_count = used_count + 1 WHERE code = ?',
  ).run(code);
  db.prepare(
    'INSERT INTO redeem_code_usage (code, user_id, redeemed_at) VALUES (?, ?, ?)',
  ).run(code, userId, now);
}

export function deleteRedeemCode(code: string): boolean {
  const result = db
    .prepare('DELETE FROM redeem_codes WHERE code = ?')
    .run(code);
  return result.changes > 0;
}

export function hasUserRedeemedCode(userId: string, code: string): boolean {
  const row = db
    .prepare(
      'SELECT COUNT(*) as cnt FROM redeem_code_usage WHERE user_id = ? AND code = ?',
    )
    .get(userId, code) as { cnt: number };
  return row.cnt > 0;
}

function mapRedeemCodeRow(row: Record<string, unknown>): RedeemCode {
  return {
    code: String(row.code),
    type: String(row.type) as RedeemCode['type'],
    value_usd: row.value_usd != null ? Number(row.value_usd) : null,
    plan_id: typeof row.plan_id === 'string' ? row.plan_id : null,
    duration_days: row.duration_days != null ? Number(row.duration_days) : null,
    max_uses: Number(row.max_uses) || 1,
    used_count: Number(row.used_count) || 0,
    expires_at: typeof row.expires_at === 'string' ? row.expires_at : null,
    created_by: String(row.created_by),
    notes: typeof row.notes === 'string' ? row.notes : null,
    batch_id: typeof row.batch_id === 'string' ? row.batch_id : null,
    created_at: String(row.created_at),
  };
}

// --- Billing Audit Log ---

export function logBillingAudit(
  eventType: BillingAuditEventType,
  userId: string,
  actorId: string | null,
  details: Record<string, unknown> | null,
): void {
  db.prepare(
    'INSERT INTO billing_audit_log (event_type, user_id, actor_id, details, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(
    eventType,
    userId,
    actorId,
    details ? JSON.stringify(details) : null,
    new Date().toISOString(),
  );
}

export function getBillingAuditLog(
  limit = 50,
  offset = 0,
  userId?: string,
  eventType?: string,
): { logs: BillingAuditLog[]; total: number } {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (userId) {
    conditions.push('user_id = ?');
    params.push(userId);
  }
  if (eventType) {
    conditions.push('event_type = ?');
    params.push(eventType);
  }
  const where =
    conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const total = (
    db
      .prepare(`SELECT COUNT(*) as cnt FROM billing_audit_log ${where}`)
      .get(...params) as { cnt: number }
  ).cnt;

  const rows = db
    .prepare(
      `SELECT * FROM billing_audit_log ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset) as Record<string, unknown>[];

  return {
    logs: rows.map((r) => ({
      id: Number(r.id),
      event_type: String(r.event_type) as BillingAuditEventType,
      user_id: String(r.user_id),
      actor_id: typeof r.actor_id === 'string' ? r.actor_id : null,
      details:
        typeof r.details === 'string'
          ? (JSON.parse(r.details) as Record<string, unknown>)
          : null,
      created_at: String(r.created_at),
    })),
    total,
  };
}

// --- Billing summary helpers ---

export function getUserGroupCount(userId: string): number {
  const row = db
    .prepare(
      "SELECT COUNT(DISTINCT rg.folder) as cnt FROM registered_groups rg WHERE rg.created_by = ? AND rg.jid LIKE 'web:%'",
    )
    .get(userId) as { cnt: number };
  return row.cnt;
}

export function getAllUserBillingOverview(): Array<{
  user_id: string;
  username: string;
  display_name: string;
  role: string;
  plan_id: string | null;
  plan_name: string | null;
  balance_usd: number;
  current_month_cost: number;
}> {
  const month = new Date().toISOString().slice(0, 7);
  return db
    .prepare(
      `SELECT u.id as user_id, u.username, u.display_name, u.role,
              s.plan_id, p.name as plan_name,
              COALESCE(b.balance_usd, 0) as balance_usd,
              COALESCE(mu.total_cost_usd, 0) as current_month_cost
       FROM users u
       LEFT JOIN user_subscriptions s ON s.user_id = u.id AND s.status = 'active'
       LEFT JOIN billing_plans p ON p.id = s.plan_id
       LEFT JOIN user_balances b ON b.user_id = u.id
       LEFT JOIN monthly_usage mu ON mu.user_id = u.id AND mu.month = ?
       WHERE u.status != 'deleted'
       ORDER BY u.created_at ASC`,
    )
    .all(month) as Array<{
    user_id: string;
    username: string;
    display_name: string;
    role: string;
    plan_id: string | null;
    plan_name: string | null;
    balance_usd: number;
    current_month_cost: number;
  }>;
}

export function getRevenueStats(): {
  totalDeposited: number;
  totalConsumed: number;
  activeSubscriptions: number;
  currentMonthRevenue: number;
} {
  const month = new Date().toISOString().slice(0, 7);
  const deposited = (
    db
      .prepare(
        'SELECT COALESCE(SUM(total_deposited_usd), 0) as total FROM user_balances',
      )
      .get() as { total: number }
  ).total;
  const consumed = (
    db
      .prepare(
        'SELECT COALESCE(SUM(total_consumed_usd), 0) as total FROM user_balances',
      )
      .get() as { total: number }
  ).total;
  const activeSubs = (
    db
      .prepare(
        "SELECT COUNT(*) as cnt FROM user_subscriptions WHERE status = 'active'",
      )
      .get() as { cnt: number }
  ).cnt;
  const monthRevenue = (
    db
      .prepare(
        'SELECT COALESCE(SUM(total_cost_usd), 0) as total FROM monthly_usage WHERE month = ?',
      )
      .get(month) as { total: number }
  ).total;
  return {
    totalDeposited: deposited,
    totalConsumed: consumed,
    activeSubscriptions: activeSubs,
    currentMonthRevenue: monthRevenue,
  };
}

// --- Daily Usage ---

function mapDailyUsageRow(row: Record<string, unknown>): DailyUsage {
  return {
    user_id: String(row.user_id),
    date: String(row.date),
    total_input_tokens: Number(row.total_input_tokens) || 0,
    total_output_tokens: Number(row.total_output_tokens) || 0,
    total_cost_usd: Number(row.total_cost_usd) || 0,
    message_count: Number(row.message_count) || 0,
  };
}

export function incrementDailyUsage(
  userId: string,
  date: string,
  inputTokens: number,
  outputTokens: number,
  costUsd: number,
): void {
  db.prepare(
    `INSERT INTO daily_usage (user_id, date, total_input_tokens, total_output_tokens, total_cost_usd, message_count)
     VALUES (?, ?, ?, ?, ?, 1)
     ON CONFLICT(user_id, date) DO UPDATE SET
       total_input_tokens = total_input_tokens + excluded.total_input_tokens,
       total_output_tokens = total_output_tokens + excluded.total_output_tokens,
       total_cost_usd = total_cost_usd + excluded.total_cost_usd,
       message_count = message_count + 1`,
  ).run(userId, date, inputTokens, outputTokens, costUsd);
}

export function getDailyUsage(
  userId: string,
  date: string,
): DailyUsage | undefined {
  const row = db
    .prepare('SELECT * FROM daily_usage WHERE user_id = ? AND date = ?')
    .get(userId, date) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return mapDailyUsageRow(row);
}

export function getWeeklyUsageSummary(userId: string): {
  totalCost: number;
  totalTokens: number;
} {
  // Align to calendar week (Monday–Sunday) to match checkQuota() reset logic
  const now = new Date();
  const dayOfWeek = now.getDay(); // 0=Sun, 1=Mon, ...
  const daysSinceMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  const monday = new Date(now);
  monday.setDate(now.getDate() - daysSinceMonday);
  const startDate = monday.toISOString().slice(0, 10);

  const row = db
    .prepare(
      `SELECT COALESCE(SUM(total_cost_usd), 0) as totalCost,
              COALESCE(SUM(total_input_tokens + total_output_tokens), 0) as totalTokens
       FROM daily_usage WHERE user_id = ? AND date >= ?`,
    )
    .get(userId, startDate) as { totalCost: number; totalTokens: number };
  return { totalCost: row.totalCost, totalTokens: row.totalTokens };
}

export function getUserDailyUsageHistory(
  userId: string,
  days = 14,
): DailyUsage[] {
  return (
    db
      .prepare(
        'SELECT * FROM daily_usage WHERE user_id = ? ORDER BY date DESC LIMIT ?',
      )
      .all(userId, days) as Record<string, unknown>[]
  ).map(mapDailyUsageRow);
}

export function getDailyUsageSumForMonth(
  userId: string,
  month: string,
): {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCost: number;
  messageCount: number;
} {
  const startDate = `${month}-01`;
  // End date: first day of next month
  const [y, m] = month.split('-').map(Number);
  const nextMonth =
    m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  const endDate = `${nextMonth}-01`;

  const row = db
    .prepare(
      `SELECT COALESCE(SUM(total_input_tokens), 0) as totalInputTokens,
              COALESCE(SUM(total_output_tokens), 0) as totalOutputTokens,
              COALESCE(SUM(total_cost_usd), 0) as totalCost,
              COALESCE(SUM(message_count), 0) as messageCount
       FROM daily_usage WHERE user_id = ? AND date >= ? AND date < ?`,
    )
    .get(userId, startDate, endDate) as {
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCost: number;
    messageCount: number;
  };
  return row;
}

export function correctMonthlyUsage(
  userId: string,
  month: string,
  inputTokens: number,
  outputTokens: number,
  costUsd: number,
  messageCount: number,
): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO monthly_usage (user_id, month, total_input_tokens, total_output_tokens, total_cost_usd, message_count, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, month) DO UPDATE SET
       total_input_tokens = excluded.total_input_tokens,
       total_output_tokens = excluded.total_output_tokens,
       total_cost_usd = excluded.total_cost_usd,
       message_count = excluded.message_count,
       updated_at = excluded.updated_at`,
  ).run(userId, month, inputTokens, outputTokens, costUsd, messageCount, now);
}

export function getSubscriptionHistory(
  userId: string,
): (UserSubscription & { plan_name: string })[] {
  return (
    db
      .prepare(
        `SELECT s.*, p.name as plan_name FROM user_subscriptions s
         JOIN billing_plans p ON s.plan_id = p.id
         WHERE s.user_id = ?
         ORDER BY s.created_at DESC`,
      )
      .all(userId) as Record<string, unknown>[]
  ).map((row) => ({
    ...mapSubscriptionRow(row),
    plan_name: String(row.plan_name),
  }));
}

export function getRedeemCodeUsageDetails(
  code: string,
): Array<{ user_id: string; username: string; redeemed_at: string }> {
  return db
    .prepare(
      `SELECT rcu.user_id, u.username, rcu.redeemed_at
       FROM redeem_code_usage rcu
       LEFT JOIN users u ON u.id = rcu.user_id
       WHERE rcu.code = ?
       ORDER BY rcu.redeemed_at DESC`,
    )
    .all(code) as Array<{
    user_id: string;
    username: string;
    redeemed_at: string;
  }>;
}

export function getDashboardStats(): {
  activeUsers: number;
  totalUsers: number;
  planDistribution: Array<{ plan_name: string; count: number }>;
  todayCost: number;
  monthCost: number;
  activeSubscriptions: number;
} {
  const today = new Date().toISOString().slice(0, 10);
  const month = new Date().toISOString().slice(0, 7);

  const totalUsers = (
    db
      .prepare("SELECT COUNT(*) as cnt FROM users WHERE status != 'deleted'")
      .get() as { cnt: number }
  ).cnt;

  const activeUsers = (
    db
      .prepare(
        'SELECT COUNT(DISTINCT user_id) as cnt FROM daily_usage WHERE date = ?',
      )
      .get(today) as { cnt: number }
  ).cnt;

  const planDistribution = db
    .prepare(
      `SELECT COALESCE(p.name, '无套餐') as plan_name, COUNT(*) as count
       FROM users u
       LEFT JOIN user_subscriptions s ON s.user_id = u.id AND s.status = 'active'
       LEFT JOIN billing_plans p ON p.id = s.plan_id
       WHERE u.status != 'deleted'
       GROUP BY p.name
       ORDER BY count DESC`,
    )
    .all() as Array<{ plan_name: string; count: number }>;

  const todayCost = (
    db
      .prepare(
        'SELECT COALESCE(SUM(total_cost_usd), 0) as total FROM daily_usage WHERE date = ?',
      )
      .get(today) as { total: number }
  ).total;

  const monthCost = (
    db
      .prepare(
        'SELECT COALESCE(SUM(total_cost_usd), 0) as total FROM monthly_usage WHERE month = ?',
      )
      .get(month) as { total: number }
  ).total;

  const activeSubscriptions = (
    db
      .prepare(
        "SELECT COUNT(*) as cnt FROM user_subscriptions WHERE status = 'active'",
      )
      .get() as { cnt: number }
  ).cnt;

  return {
    activeUsers,
    totalUsers,
    planDistribution,
    todayCost,
    monthCost,
    activeSubscriptions,
  };
}

export function getRevenueTrend(
  months = 6,
): Array<{ month: string; revenue: number; users: number }> {
  return db
    .prepare(
      `SELECT month, SUM(total_cost_usd) as revenue, COUNT(DISTINCT user_id) as users
       FROM monthly_usage
       GROUP BY month
       ORDER BY month DESC
       LIMIT ?`,
    )
    .all(months) as Array<{ month: string; revenue: number; users: number }>;
}

export function batchAssignPlan(
  userIds: string[],
  planId: string,
  actorId: string,
  durationDays?: number,
): number {
  const plan = getBillingPlan(planId);
  if (!plan) throw new Error(`Plan not found: ${planId}`);

  const now = new Date();
  const expiresAt = durationDays
    ? new Date(now.getTime() + durationDays * 24 * 60 * 60 * 1000).toISOString()
    : null;

  let count = 0;
  const txn = db.transaction(() => {
    for (const userId of userIds) {
      // Cancel existing
      db.prepare(
        "UPDATE user_subscriptions SET status = 'cancelled', cancelled_at = ? WHERE user_id = ? AND status = 'active'",
      ).run(now.toISOString(), userId);

      const subId = `sub_${userId}_${Date.now()}_${count}`;
      db.prepare(
        `INSERT INTO user_subscriptions (id, user_id, plan_id, status, started_at, expires_at, auto_renew, created_at)
         VALUES (?, ?, ?, 'active', ?, ?, 0, ?)`,
      ).run(
        subId,
        userId,
        planId,
        now.toISOString(),
        expiresAt,
        now.toISOString(),
      );

      db.prepare('UPDATE users SET subscription_plan_id = ? WHERE id = ?').run(
        planId,
        userId,
      );

      logBillingAudit('subscription_assigned', userId, actorId, {
        planId,
        planName: plan.name,
        durationDays: durationDays ?? null,
        batch: true,
      });
      count++;
    }
  });
  txn();
  return count;
}

export function getPlanSubscriberCount(planId: string): number {
  const row = db
    .prepare(
      "SELECT COUNT(*) as cnt FROM user_subscriptions WHERE plan_id = ? AND status = 'active'",
    )
    .get(planId) as { cnt: number };
  return row.cnt;
}

export function getAllPlanSubscriberCounts(): Record<string, number> {
  const rows = db
    .prepare(
      "SELECT plan_id, COUNT(*) as cnt FROM user_subscriptions WHERE status = 'active' GROUP BY plan_id",
    )
    .all() as Array<{ plan_id: string; cnt: number }>;
  const result: Record<string, number> = {};
  for (const row of rows) {
    result[row.plan_id] = row.cnt;
  }
  return result;
}

/**
 * Atomically increment redeem code usage with optimistic locking.
 * Returns true if the increment succeeded (used_count < max_uses).
 */
export function tryIncrementRedeemCodeUsage(
  code: string,
  userId: string,
): boolean {
  const now = new Date().toISOString();
  return db.transaction(() => {
    const result = db
      .prepare(
        'UPDATE redeem_codes SET used_count = used_count + 1 WHERE code = ? AND used_count < max_uses',
      )
      .run(code);
    if (result.changes === 0) return false;
    db.prepare(
      'INSERT INTO redeem_code_usage (code, user_id, redeemed_at) VALUES (?, ?, ?)',
    ).run(code, userId, now);
    return true;
  })();
}

/**
 * Close the database connection.
 * Should be called during graceful shutdown.
 */
export async function closeDatabase(): Promise<void> {
  await persistenceController.close();
  _stmts = null;
  _newMsgStmtCache.clear();
  if (db) {
    db.close();
  }
}

// ───────────────────────── Agent Links (Phase 5.1) ─────────────────────────

type AgentLinkRow = {
  id: string;
  user_id: string;
  display_name: string;
  token_hash: string;
  capabilities: string;
  agent_clients: string;
  resources: string;
  os: string | null;
  arch: string | null;
  hostname: string | null;
  client_version: string | null;
  last_connected_at: string | null;
  last_seen_at: string | null;
  created_at: string;
  revoked_at: string | null;
};

function parseAgentLinkRow(row: AgentLinkRow): AgentLink {
  let caps: string[] = [];
  let agentClients: AgentLink['agentClients'] = [];
  let resources: AgentLink['resources'] | undefined;
  try {
    const parsed = JSON.parse(row.capabilities);
    if (Array.isArray(parsed))
      caps = parsed.filter((c) => typeof c === 'string');
  } catch {
    /* ignore malformed */
  }
  try {
    const parsed = JSON.parse(row.agent_clients || '[]');
    if (Array.isArray(parsed)) {
      agentClients = parsed
        .filter(
          (c) => c && typeof c.id === 'string' && typeof c.binary === 'string',
        )
        .map((c) => ({
          id: c.id,
          displayName: typeof c.displayName === 'string' ? c.displayName : c.id,
          binary: c.binary,
          ...(typeof c.version === 'string' ? { version: c.version } : {}),
          ...(Array.isArray(c.permissionModes)
            ? {
                permissionModes: c.permissionModes.filter(
                  (m: unknown) => typeof m === 'string',
                ),
              }
            : {}),
          ...(Array.isArray(c.capabilities)
            ? {
                capabilities: c.capabilities.filter(
                  (m: unknown) => typeof m === 'string',
                ),
              }
            : {}),
        }));
    }
  } catch {
    /* ignore malformed */
  }
  try {
    const parsed = JSON.parse(row.resources || '{}');
    if (parsed && typeof parsed === 'object') {
      resources = {
        ...(typeof parsed.cpuCount === 'number'
          ? { cpuCount: parsed.cpuCount }
          : {}),
        ...(typeof parsed.cpuUsedPercent === 'number'
          ? { cpuUsedPercent: parsed.cpuUsedPercent }
          : {}),
        ...(typeof parsed.load1 === 'number' ? { load1: parsed.load1 } : {}),
        ...(typeof parsed.load5 === 'number' ? { load5: parsed.load5 } : {}),
        ...(typeof parsed.load15 === 'number' ? { load15: parsed.load15 } : {}),
        ...(typeof parsed.memoryTotalBytes === 'number'
          ? { memoryTotalBytes: parsed.memoryTotalBytes }
          : {}),
        ...(typeof parsed.memoryUsedBytes === 'number'
          ? { memoryUsedBytes: parsed.memoryUsedBytes }
          : {}),
        ...(typeof parsed.memoryUsedPercent === 'number'
          ? { memoryUsedPercent: parsed.memoryUsedPercent }
          : {}),
        ...(typeof parsed.diskTotalBytes === 'number'
          ? { diskTotalBytes: parsed.diskTotalBytes }
          : {}),
        ...(typeof parsed.diskUsedBytes === 'number'
          ? { diskUsedBytes: parsed.diskUsedBytes }
          : {}),
        ...(typeof parsed.diskUsedPercent === 'number'
          ? { diskUsedPercent: parsed.diskUsedPercent }
          : {}),
        ...(Array.isArray(parsed.disks)
          ? {
              disks: parsed.disks
                .filter(
                  (disk: unknown): disk is Record<string, unknown> =>
                    !!disk && typeof disk === 'object',
                )
                .map((disk: Record<string, unknown>) => ({
                  ...(typeof disk.filesystem === 'string'
                    ? { filesystem: disk.filesystem }
                    : {}),
                  mountPoint:
                    typeof disk.mountPoint === 'string'
                      ? disk.mountPoint
                      : typeof disk.mount_point === 'string'
                        ? disk.mount_point
                        : '—',
                  ...(typeof disk.diskTotalBytes === 'number'
                    ? { diskTotalBytes: disk.diskTotalBytes }
                    : {}),
                  ...(typeof disk.diskUsedBytes === 'number'
                    ? { diskUsedBytes: disk.diskUsedBytes }
                    : {}),
                  ...(typeof disk.diskUsedPercent === 'number'
                    ? { diskUsedPercent: disk.diskUsedPercent }
                    : {}),
                }))
                .filter((disk: { mountPoint: string }) => disk.mountPoint !== '—'),
            }
          : {}),
        ...(typeof parsed.collectedAt === 'string'
          ? { collectedAt: parsed.collectedAt }
          : {}),
      };
    }
  } catch {
    /* ignore malformed */
  }
  return {
    id: row.id,
    userId: row.user_id,
    displayName: row.display_name,
    capabilities: caps,
    agentClients,
    resources,
    os: row.os ?? undefined,
    arch: row.arch ?? undefined,
    hostname: row.hostname ?? undefined,
    clientVersion: row.client_version ?? undefined,
    lastConnectedAt: row.last_connected_at ?? undefined,
    lastSeenAt: row.last_seen_at ?? undefined,
    createdAt: row.created_at,
    revokedAt: row.revoked_at ?? undefined,
  };
}

/** 内部使用：返回 token_hash，仅 ws 握手时调用。 */
export function getAgentLinkRowForAuth(
  id: string,
):
  | { id: string; userId: string; tokenHash: string; revoked: boolean }
  | undefined {
  const row = db
    .prepare(
      'SELECT id, user_id, token_hash, revoked_at FROM agent_links WHERE id = ?',
    )
    .get(id) as
    | {
        id: string;
        user_id: string;
        token_hash: string;
        revoked_at: string | null;
      }
    | undefined;
  if (!row) return undefined;
  return {
    id: row.id,
    userId: row.user_id,
    tokenHash: row.token_hash,
    revoked: row.revoked_at != null,
  };
}

/** ws 握手时遍历未撤销的 link，做 bcrypt.compare。 */
export function listAgentLinkAuthCandidates(): Array<{
  id: string;
  userId: string;
  tokenHash: string;
}> {
  const rows = db
    .prepare(
      'SELECT id, user_id, token_hash FROM agent_links WHERE revoked_at IS NULL',
    )
    .all() as Array<{ id: string; user_id: string; token_hash: string }>;
  return rows.map((r) => ({
    id: r.id,
    userId: r.user_id,
    tokenHash: r.token_hash,
  }));
}

export function createAgentLink(input: {
  id: string;
  userId: string;
  displayName: string;
  tokenHash: string;
}): AgentLink {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO agent_links
     (id, user_id, display_name, token_hash, capabilities, created_at)
     VALUES (?, ?, ?, ?, '[]', ?)`,
  ).run(input.id, input.userId, input.displayName, input.tokenHash, now);
  return {
    id: input.id,
    userId: input.userId,
    displayName: input.displayName,
    capabilities: [],
    createdAt: now,
  };
}

export function listAgentLinksByUser(userId: string): AgentLink[] {
  const rows = db
    .prepare(
      'SELECT * FROM agent_links WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC',
    )
    .all(userId) as AgentLinkRow[];
  return rows.map(parseAgentLinkRow);
}

export function getAgentLinkById(id: string): AgentLink | undefined {
  const row = db.prepare('SELECT * FROM agent_links WHERE id = ?').get(id) as
    | AgentLinkRow
    | undefined;
  if (!row) return undefined;
  return parseAgentLinkRow(row);
}

/** ws hello 上报时刷新 client metadata + last_connected_at。 */
export function recordAgentLinkConnect(
  id: string,
  meta: {
    capabilities: string[];
    agentClients?: AgentLink['agentClients'];
    resources?: AgentLink['resources'];
    os?: string;
    arch?: string;
    hostname?: string;
    clientVersion?: string;
  },
): void {
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE agent_links
       SET capabilities = ?, agent_clients = ?, resources = ?, os = ?, arch = ?, hostname = ?, client_version = ?,
           last_connected_at = ?, last_seen_at = ?
     WHERE id = ?`,
  ).run(
    JSON.stringify(meta.capabilities),
    JSON.stringify(meta.agentClients ?? []),
    JSON.stringify(meta.resources ?? {}),
    meta.os ?? null,
    meta.arch ?? null,
    meta.hostname ?? null,
    meta.clientVersion ?? null,
    now,
    now,
    id,
  );
}

export function recordAgentLinkResources(
  id: string,
  resources?: AgentLink['resources'],
): void {
  const now = new Date().toISOString();
  db.prepare(
    'UPDATE agent_links SET resources = ?, last_seen_at = ? WHERE id = ?',
  ).run(JSON.stringify(resources ?? {}), now, id);
}

/** 心跳 / 任意帧到达时更新 last_seen_at。 */
export function touchAgentLinkSeen(id: string): void {
  const now = new Date().toISOString();
  db.prepare('UPDATE agent_links SET last_seen_at = ? WHERE id = ?').run(
    now,
    id,
  );
}

export function revokeAgentLink(id: string, userId: string): boolean {
  const now = new Date().toISOString();
  const result = db
    .prepare(
      'UPDATE agent_links SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL',
    )
    .run(now, id, userId);
  return result.changes > 0;
}

/** Token rotation: 替换 hash，但 link id 不变。 */
export function rotateAgentLinkToken(
  id: string,
  userId: string,
  newTokenHash: string,
): boolean {
  const result = db
    .prepare(
      'UPDATE agent_links SET token_hash = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL',
    )
    .run(newTokenHash, id, userId);
  return result.changes > 0;
}

export interface CloudSkillRecord {
  id: string;
  userId: string;
  skillId: string;
  name: string;
  description: string;
  content: string;
  enabled: boolean;
  packageName?: string;
  packageSource?: string;
  sourceProvider?: string;
  installedAt: string;
  updatedAt: string;
  files: Array<{ name: string; type: 'file' | 'directory'; size: number }>;
}

interface CloudSkillRow {
  id: string;
  user_id: string;
  skill_id: string;
  name: string;
  description: string | null;
  content: string;
  enabled: number;
  package_name: string | null;
  package_source: string | null;
  source_provider: string | null;
  installed_at: string;
  updated_at: string;
  files_json: string;
}

function parseCloudSkillRow(row: CloudSkillRow): CloudSkillRecord {
  let files: CloudSkillRecord['files'] = [];
  try {
    const parsed = JSON.parse(row.files_json || '[]');
    if (Array.isArray(parsed)) files = parsed;
  } catch {
    files = [];
  }
  return {
    id: row.id,
    userId: row.user_id,
    skillId: row.skill_id,
    name: row.name,
    description: row.description ?? '',
    content: row.content,
    enabled: row.enabled !== 0,
    packageName: row.package_name ?? undefined,
    packageSource: row.package_source ?? undefined,
    sourceProvider: row.source_provider ?? undefined,
    installedAt: row.installed_at,
    updatedAt: row.updated_at,
    files,
  };
}

function cloudSkillDbId(userId: string, skillId: string): string {
  return `cloud_skill_${crypto
    .createHash('sha1')
    .update(`${userId}:${skillId}`)
    .digest('hex')}`;
}

export function upsertCloudSkill(input: {
  userId: string;
  skillId: string;
  name: string;
  description?: string;
  content: string;
  enabled?: boolean;
  packageName?: string;
  packageSource?: string;
  sourceProvider?: string;
  installedAt?: string;
  files?: CloudSkillRecord['files'];
}): CloudSkillRecord {
  const now = new Date().toISOString();
  const id = cloudSkillDbId(input.userId, input.skillId);
  const installedAt = input.installedAt ?? now;
  db.prepare(
    `INSERT INTO cloud_skills (
       id, user_id, skill_id, name, description, content, enabled,
       package_name, package_source, source_provider, installed_at, updated_at, files_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, skill_id) DO UPDATE SET
       name = excluded.name,
       description = excluded.description,
       content = excluded.content,
       enabled = excluded.enabled,
       package_name = excluded.package_name,
       package_source = excluded.package_source,
       source_provider = excluded.source_provider,
       updated_at = excluded.updated_at,
       files_json = excluded.files_json`,
  ).run(
    id,
    input.userId,
    input.skillId,
    input.name,
    input.description ?? '',
    input.content,
    input.enabled === false ? 0 : 1,
    input.packageName ?? null,
    input.packageSource ?? null,
    input.sourceProvider ?? null,
    installedAt,
    now,
    JSON.stringify(input.files ?? []),
  );
  return getCloudSkill(input.userId, input.skillId)!;
}

export function listCloudSkillsByUser(userId: string): CloudSkillRecord[] {
  const rows = db
    .prepare(
      `SELECT * FROM cloud_skills WHERE user_id = ? ORDER BY updated_at DESC`,
    )
    .all(userId) as CloudSkillRow[];
  return rows.map(parseCloudSkillRow);
}

export function getCloudSkill(
  userId: string,
  skillId: string,
): CloudSkillRecord | undefined {
  const row = db
    .prepare('SELECT * FROM cloud_skills WHERE user_id = ? AND skill_id = ?')
    .get(userId, skillId) as CloudSkillRow | undefined;
  return row ? parseCloudSkillRow(row) : undefined;
}

export function setCloudSkillEnabled(
  userId: string,
  skillId: string,
  enabled: boolean,
): boolean {
  const result = db
    .prepare(
      'UPDATE cloud_skills SET enabled = ?, updated_at = ? WHERE user_id = ? AND skill_id = ?',
    )
    .run(enabled ? 1 : 0, new Date().toISOString(), userId, skillId);
  return result.changes > 0;
}

export function deleteCloudSkill(userId: string, skillId: string): boolean {
  const result = db
    .prepare('DELETE FROM cloud_skills WHERE user_id = ? AND skill_id = ?')
    .run(userId, skillId);
  return result.changes > 0;
}

export function deleteCloudSkillsByUser(userId: string): number {
  const result = db.prepare('DELETE FROM cloud_skills WHERE user_id = ?').run(userId);
  return result.changes;
}
