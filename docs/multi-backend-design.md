# Phase 4 — 自定义 CLI Backend 配置化

## 目标

让 admin 能在 web 页面上「新增 / 编辑 / 删除自定义 CLI agent backend」，无需写代码。每条配置自动注册进 backend registry，热更新生效（不需重启服务）。最终用户在 group 编辑页可以从下拉里选到自定义 backend。

不做：container 模式（保留 Phase 5 再开）；MCP 桥接；流式 partial messages；多用户隔离的 backend（仅 admin 全局）。

---

## 一、整体架构

```
admin 在 UI 配置 CustomBackendDef
        │
        ▼
data/config/custom-backends.json
        │ (server 启动时 + 每次 CRUD 后)
        ▼
loadCustomBackendsFromDisk()
        │
        ▼ for each def
buildDynamicBackend(def) → AgentBackend
        │
        ▼
registerBackend(backend)
        │
        ▼ (resolveBackend 时)
group.backend → registry.get → backend.run()
        │
        ▼
runHostCli(args, hostCliConfig)
        │
        ▼ (从 def 翻译来的 config)
spawn(binary, renderedArgv) → stdout 行流解析 → ContainerOutput
```

关键复用：
- 现有 `getBackend / listBackends / resolveBackend / unregisterBackend?` 不变
- 现有 `coco.ts` 重构成「调用 driver」的薄壳（30 行），与 dynamic.ts 共用同一 driver
- 内置 `claude-sdk` / `coco` 永远是 module-top-level register，不会被 custom 覆盖

---

## 二、文件改动清单

### 1. 抽出公用 host CLI driver（新文件）

**`src/backends/host-cli-driver.ts`（新建）** — 把 coco.ts 当前的 spawn / 行流 / timeout / 收尾逻辑抽到这里。导出：

```ts
export type OutputProtocol = 'jsonline-stream-json' | 'plain-text';

export interface HostCliDriverConfig {
  backendId: string;                      // 仅用于 log
  resolveBinary: () => string | null;     // 已封装好「候选路径 / PATH lookup」
  buildArgv: (ctx: { prompt: string; sessionId?: string; cwd: string; folder: string; backendId: string }) => string[];
  outputProtocol: OutputProtocol;
  timeoutMs?: number;                     // 0/undefined → SystemSettings.containerTimeout
  maxOutputBytes?: number;                // 0/undefined → SystemSettings.containerMaxOutputSize
  envOverrides?: Record<string, string>;
}

export async function runHostCli(
  args: BackendRunArgs,
  cfg: HostCliDriverConfig,
): Promise<ContainerOutput>;
```

内部子函数（私有）：
- `prepareCwdAndLogs(group)` ← 来源 coco.ts:86-108
- `parseStreamJsonLine(line, state)` ← 来源 coco.ts:185-211 抽成纯函数（input: line, state；output: 更新 state）
- `parsePlainText(chunk, state)` ← 新增：把所有 stdout 当 `result` 字符串累计
- `writeRunLog(...)` ← coco.ts:237-263
- `finalizeOutput(state)` ← coco.ts:265-305

### 2. coco backend 重构成薄壳

**`src/backends/coco.ts`** — 缩到约 35 行：

```ts
const COCO_BINARY_CANDIDATES = [...];
function resolveCocoBinary(): string | null { /* 不变 */ }

export const cocoBackend: AgentBackend = {
  id: 'coco',
  displayName: 'TraeCLI (coco)',
  usesProviderPool: false,
  supportsExecutionMode: (mode) => mode === 'host',
  run: (args) => runHostCli(args, {
    backendId: 'coco',
    resolveBinary: resolveCocoBinary,
    buildArgv: (ctx) => {
      const argv = ['-p', ctx.prompt, '--output-format=stream-json', '-y'];
      if (ctx.sessionId) argv.push(`--resume=${ctx.sessionId}`);
      return argv;
    },
    outputProtocol: 'jsonline-stream-json',
  }),
};
```

行为不变（已通过 Phase 2.5 冒烟测试），只是把代码搬家。

### 3. 自定义 backend 类型 / 加载 / 翻译

**`src/backends/dynamic.ts`（新建）** — 把 admin 配置翻译成 `AgentBackend`：

```ts
export interface CustomBackendDef {
  id: string;
  displayName: string;
  binary: string;                    // 绝对路径 或 纯命令名
  argvTemplate: string[];            // 含 {prompt} {sessionId} {cwd} {folder} {backendId}
  outputProtocol: 'jsonline-stream-json' | 'plain-text';
  supportsHost: boolean;             // Phase 1 强制 true
  supportsContainer: boolean;        // Phase 1 强制 false
  usesProviderPool: boolean;
  timeoutMs?: number;
  maxOutputBytes?: number;
  env?: Record<string, string>;
}

export function buildDynamicBackend(def: CustomBackendDef): AgentBackend;
```

`buildDynamicBackend` 内部：
- `resolveBinary` = 闭包逐级 fallback（绝对路径 existsSync → 否则 PATH lookup 即返回 def.binary）
- `buildArgv` = 对每个 token 做模板替换（仅替换白名单 `{...}`，未知占位符保持字面量）
- `runHostCli` 复用，传入 `def.timeoutMs / def.maxOutputBytes / def.env`

---

**`src/backends/custom-loader.ts`（新建）** — disk I/O + registry sync：

```ts
const CUSTOM_BACKENDS_FILE = path.join(DATA_DIR, 'config', 'custom-backends.json');

export function loadCustomBackendsFromDisk(): void;     // 启动时调一次
export function reloadCustomBackends(): void;           // CRUD 后调
export function listCustomBackends(): CustomBackendDef[];   // 给 API 用
export function upsertCustomBackend(def: CustomBackendDef): void;  // 含 fs 写盘
export function deleteCustomBackend(id: string): boolean;
```

实现要点：
- 内存缓存 `customBackendsCache: Map<string, CustomBackendDef>` + 文件 mtime 失效
- 写盘：临时文件 + atomic rename（与 `writeStoredStateV4` 风格一致）
- `reloadCustomBackends`：先把 registry 里所有 custom id（即不在 builtin 集合中的 id）unregister，再重新逐个 register
- 注意保护：永远不允许 unregister `claude-sdk` / `coco`（即 `BUILTIN_BACKEND_IDS = new Set(['claude-sdk', 'coco'])`）
- 启动时若 JSON 文件不存在，视为空数组，不要抛错
- 单条 def 校验失败（如 binary 不存在）打 warn 并 skip 该条，不阻塞其他

---

**`src/backends/registry.ts`** — 加 `unregisterBackend`：

```ts
const BUILTIN_BACKEND_IDS = new Set(['claude-sdk', 'coco']);

export function unregisterBackend(id: string): boolean {
  if (BUILTIN_BACKEND_IDS.has(id)) return false;   // 保护
  return registry.delete(id);
}
```

### 4. 安全校验工具

**`src/backends/validation.ts`（新建）** — 纯函数，给 zod superRefine 和 runtime 双重保护：

```ts
export const ALLOWED_PLACEHOLDER_KEYS = ['prompt', 'sessionId', 'cwd', 'folder', 'backendId'];

const PLACEHOLDER_RE = /\{([a-zA-Z]+)\}/g;
const BAD_BINARY_CHARS = /[\s;|&><`$"'\\]/;
const PURE_COMMAND_RE = /^[A-Za-z0-9_.-]{1,64}$/;

export function validateBinaryPath(binary: string): { ok: boolean; error?: string };
// 规则：
//   - 必须非空，长度 ≤ 512
//   - 不允许 BAD_BINARY_CHARS
//   - 要么 path.isAbsolute（runtime 再做 fs.existsSync + isFile 检查）
//     要么匹配 PURE_COMMAND_RE
//   - 拒绝相对路径（含 / 但非 abs）

export function validateArgvTemplate(template: string[]): { ok: boolean; error?: string };
// 规则：
//   - length ≤ 64，每项 length ≤ 1000
//   - 至少一项含 {prompt}
//   - {xxx} 中 xxx 必须在 ALLOWED_PLACEHOLDER_KEYS 内

export function validateBackendEnv(env: Record<string,string>): { ok: boolean; error?: string };
// 规则：复用 ENV_KEY_RE，hard reject RESERVED_CLAUDE_ENV_KEYS ∪ DANGEROUS_ENV_VARS
// 与 sanitizeCustomEnvMap 不同：那个是 skip，这个是 reject 抛 400

export function renderArgv(template: string[], ctx: PlaceholderCtx): string[];
// 仅替换白名单 key；未识别 {xxx} 保持字面量并打 warn（一次）
```

### 5. Server CRUD API

**`src/routes/config.ts`（追加）** — 现有 `GET /api/config/backends` 上方/下方加四个 admin 路由：

```ts
configRoutes.get('/custom-backends', authMiddleware, systemConfigMiddleware, (c) => { ... });
configRoutes.post('/custom-backends', authMiddleware, systemConfigMiddleware, async (c) => { ... });
configRoutes.patch('/custom-backends/:id', authMiddleware, systemConfigMiddleware, async (c) => { ... });
configRoutes.delete('/custom-backends/:id', authMiddleware, systemConfigMiddleware, async (c) => { ... });
```

每个 mutate 路由结尾调 `reloadCustomBackends()`，让新条目立即对下一条消息生效。

**修改 `GET /api/config/backends`（src/routes/config.ts:1308）**：返回 `listBackends()` 已经包含 dynamic backend（因为它们已 register 进同一个 registry），无需变更逻辑；但要在每个 item 加 `kind: 'builtin' | 'custom'` 字段，方便前端区分（custom 才显示「编辑 / 删除」按钮）。

### 6. Zod schema

**`src/schemas.ts`（追加）** — 在 BillingPlan 区块旁：

```ts
export const CustomBackendCreateSchema = z.object({
  id: z.string().min(1).max(64).regex(/^[a-z][a-z0-9_-]*$/, '小写字母开头，仅 [a-z0-9_-]'),
  displayName: z.string().min(1).max(64),
  binary: z.string().min(1).max(512),
  argvTemplate: z.array(z.string().max(1000)).min(1).max(64),
  outputProtocol: z.enum(['jsonline-stream-json', 'plain-text']),
  supportsHost: z.boolean().optional().default(true),
  supportsContainer: z.boolean().optional().default(false),
  usesProviderPool: z.boolean().optional().default(false),
  timeoutMs: z.number().int().min(60_000).max(86_400_000).optional(),
  maxOutputBytes: z.number().int().min(1_048_576).max(104_857_600).optional(),
  env: z.record(z.string().max(256), z.string().max(4096)).optional(),
}).superRefine((data, ctx) => {
  // 调 validation.ts 三个函数，逐项 addIssue
  // 强制 supportsContainer=false（Phase 1）
  // 强制 supportsHost=true
  // 防 id 撞内置：reject 'claude-sdk' / 'coco'
});

export const CustomBackendPatchSchema = CustomBackendCreateSchema
  // schema.shape 取出 base，逐字段 .optional() — 因为 superRefine 后 .partial 不能用，要手写
  ...
```

### 7. 启动时加载

**`src/index.ts:8651`**（在 `logger.info('Database initialized')` 之后）插入：

```ts
loadCustomBackendsFromDisk();
logger.info('Custom backends loaded');
```

### 8. 前端 — admin 列表 + 表单

**复用样板**：`web/src/components/billing/{AdminPlansList,PlanFormDialog}.tsx`（最干净的字段纯量 CRUD）

新增：
- `web/src/components/settings/CustomBackendList.tsx` — 列表 + 行级 编辑/删除按钮 + 健康徽标（builtin 灰、custom 蓝）
- `web/src/components/settings/CustomBackendFormDialog.tsx` — 新建/编辑共用：
  - 字段：id（编辑时只读）/ displayName / binary / outputProtocol（select）/ argvTemplate（每行一项的 textarea，前端把换行 split 成数组）/ timeoutMs / maxOutputBytes / env（key=value 多行）
  - 提示：占位符列表（{prompt} 必填、{sessionId} 可选 …）
  - 提交时前端二次校验 argvTemplate 含 `{prompt}`，给即时 toast
- `web/src/stores/customBackends.ts` — Zustand store：`load / create / update / remove`

**入口位置**：`SystemSettingsSection.tsx`「Agent 后端」section 下方，新增第三个 section「自定义 Backend」，里面挂 `<CustomBackendList />`。表单弹窗放在 List 内部 useState 控制。

**前端类型**：在 `web/src/components/settings/types.ts` 加 `CustomBackend` interface（与 server 的 `CustomBackendDef` 对齐）。

### 9. group 编辑页 — 自动获益

**`web/src/components/groups/GroupDetail.tsx`** — 不需修改。`/api/config/backends` 已返回 builtin + custom 合集，且现有下拉已根据 `allowedBackends` 过滤。admin 把 custom id 加到 `allowedBackends` 后，group 用户即可选。

注意提示文案可微调：「下拉中的 `(builtin)` / `(custom)` 标签」如果想要的话，再加一句条件渲染。

### 10. SystemSettings UI — `allowedBackends` 自动列出 custom

**`web/src/components/settings/SystemSettingsSection.tsx`** — 现有「Agent 后端」section 通过 `availableBackends` 渲染 checkbox 列表，custom backend 自动出现在里面。无需改动。

---

## 三、安全清单

| 项 | 实施 |
|---|---|
| 谁能 CRUD | `systemConfigMiddleware`（admin）|
| 占位符 | 白名单 `{prompt} {sessionId} {cwd} {folder} {backendId}`，未知 `{...}` 字面量 + warn |
| binary | `path.isAbsolute` 时 runtime check `existsSync && isFile`；纯命令名匹配 `/^[A-Za-z0-9_.-]{1,64}$/`；含空格 / 引号 / shell 元字符 reject |
| spawn | 永远 `shell:false`，argv 数组 |
| ENV | hard reject `RESERVED_CLAUDE_ENV_KEYS ∪ DANGEROUS_ENV_VARS`，max 50 entries |
| 执行模式 | Phase 1 强制 host-only（schema 校验拒绝 supportsContainer=true）|
| timeout / max output | 上下界与 `SystemSettings` 同步 |
| id | 不允许 `claude-sdk` / `coco`，必须 `^[a-z][a-z0-9_-]*$` |
| 审计 | 每次 CRUD 写 `data/config/custom-backends.audit.log`（仿 `appendClaudeConfigAudit`，含 user / action / id / timestamp） |

---

## 四、Typecheck + 验证

1. `npx tsc --noEmit -p tsconfig.json`（root）
2. `cd web && npx tsc --noEmit -p tsconfig.json`
3. 冒烟：
   - 启服务 → admin UI 创建一条 `id=echo-test`、`binary=echo`、`argvTemplate=['{prompt}']`、`outputProtocol=plain-text` 的 backend
   - admin UI 把 `echo-test` 勾进 `allowedBackends`
   - 给某个 group 的 backend 设为 `echo-test`，发条消息，确认 result = 原 prompt
4. 异常路径：
   - 非法 binary（含空格）→ 400
   - argvTemplate 无 `{prompt}` → 400
   - id = `claude-sdk` → 400
   - 删除一条正在被 group 引用的 backend → 删除成功；group 下次执行通过 `resolveBackend` 软降级到 `defaultBackend`，前端可在删除前给 warn

---

## 五、TodoTask 拆分

- Phase 4.0  抽 host-cli-driver，coco.ts 重构（保持行为不变）
- Phase 4.1  validation.ts + dynamic.ts + custom-loader.ts（含 unregisterBackend）
- Phase 4.2  Zod schema + Server CRUD API + 启动时 load + audit log
- Phase 4.3  前端 store + 列表 + 表单弹窗 + 挂到 SystemSettingsSection
- Phase 4.4  双端 typecheck + 端到端 echo-test 冒烟
