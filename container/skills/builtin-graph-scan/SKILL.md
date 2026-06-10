---
name: builtin-graph-scan
description: >
  Deterministic repo knowledge graph builder (Python). Scans the workspace,
  extracts symbols / imports / dependencies / doc sections and writes
  chunks.json / edges.json / stats.json / summary.md / run.log into a
  requested output directory. Agent-invocable — pass `--output-dir <path>`
  to choose where artifacts land. The written schema matches the
  OctoDeck repo knowledge upload payload exactly, so the agent can either
  curl the output straight to the server upload endpoint, or invoke the
  script and then let the server fall-back-pull the files. Writes
  atomic (tmp+fsync+rename) so artifacts and tees stderr to run.log for observability.
user-invocable: false
dependencies: python3 >= 3.8
tags: [repo-knowledge, graph, code-analysis, builtin]
allowed-tools: Bash(), Read()
---

# builtin-graph-scan (Python)

**用途**：在设备端的 task agent 工作目录中，用一个**确定性、零额外依赖**的 Python 脚本扫仓库，产出 OctoDeck 知识库要求的 `chunks.json / edges.json / stats.json / summary.md / run.log` 五件套。  
**设计原则**：纯标准库（`python3 >= 3.8` 即可），不用 ast/tokenizer 以外的第三方包；单次运行不依赖网络；出错时返回非零 exit code 并把错误写到 stderr，stdout 只输出一行 JSON summary；所有产物**原子写入**（tmp + fsync + rename），中途中断不会产生半截 JSON；stderr 同步 tee 到 `run.log` 供 Agent 作为 observability 附件上传。

## 1. 脚本位置（由 OctoDeck 在 skill 安装时同步到下列任一路径）

```
<skill-root>/scripts/builtin_graph_scan.py
```

skill 根目录下还会有一个 CLI 包装：

```
<skill-root>/bin/builtin-graph-scan    # shell：exec python3 scripts/builtin_graph_scan.py "$@"
```

## 2. 调用方式

```bash
# 最简：扫描当前工作目录，产物写到 .octodeck/knowledge/
builtin-graph-scan

# 自定义仓库根和输出目录
builtin-graph-scan \
  --repo /path/to/repo \
  --output-dir /path/to/repo/.octodeck/knowledge \
  --repo-name myrepo \
  --max-files 800 \
  --max-file-bytes 65536 \
  --max-output-mb 32
```

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `--repo` | path | `$PWD` | 仓库根（必须存在且可读） |
| `--output-dir` | path | `<repo>/.octodeck/knowledge` | 产物写入目录；不存在会 `mkdir -p` |
| `--repo-name` | string | basename `--repo` | 写进 summary 的仓库名 |
| `--revision` | string | null | git revision / commit id，会写进 stats.json 和 overview |
| `--max-files` | int | 800 | 最多扫描多少个文本文件 |
| `--max-file-bytes` | int | 65536 | 单文件超过此字节数直接跳过（上限 2MB） |
| `--include` | glob（可重复） | — | 只包含匹配到的相对路径（fnmatch 模式） |
| `--exclude` | glob（可重复） | — | 排除匹配的相对路径（优先级高于 include） |
| `--include-docs` | flag | `true`（带 `--no-include-docs` 可关） | 是否解析 Markdown doc chunks |
| `--include-deps` | flag | `true` | 要不要生成 dependency chunks/edges |
| `--include-imports` | flag | `true` | 要不要生成 imports / imported_by 边 |
| `--max-output-mb` | float | null | chunks.json / edges.json 单文件体积预算，超过会直接报错退出（防磁盘/网络膨胀） |
| `--pretty` | flag | `false` | 开启时 JSON 写 `indent=2`，默认紧凑格式更省空间 |

成功时 stdout 只打印一行：

```json
{"ok": true, "chunks": N, "edges": M, "output_dir": "...", "duration_ms": X, "stats": {...}}
```

失败时 exit != 0，stderr 打印错误信息，同时 `run.log` 中会留下带时间戳的 START/BUILD/DONE/FAIL 记录。

## 3. 输出文件格式（= OctoDeck 上传 payload schema）

所有字段语义、枚举与 `RepoKnowledgeUploadSchema` 完全一致，可直接 curl 到 `/api/repos/knowledge/runs/:runId/upload`。

### `chunks.json`

```json
[
  {
    "key": "稳定唯一标识，必填（repo 内同一目标每次生成都一致）",
    "path": "相对 --repo 的路径",
    "kind": "overview | file | symbol | dependency | doc | graph",
    "name": "符号名 / 文档章节名 / 包名 / ...",
    "language": "ts | tsx | python | go | rust | ... | markdown | null",
    "startLine": 1,
    "endLine": 42,
    "content": "chunk 文本（单文件 ≤ 128KB）",
    "keywords": "空格分隔的检索关键词",
    "metadata": { "任意": "附加信息" }
  }
]
```

### `edges.json`

```json
[
  {
    "key": "稳定唯一标识，必填",
    "fromPath": "起点文件路径（必填）",
    "toPath": "终点文件路径（选填；第三方包为 null，内部真实文件才填）",
    "edgeKind": "imports | imported_by | depends_on | exports | documents | references",
    "symbol": "关联符号名（选填）",
    "packageName": "第三方包名（选填）",
    "source": "builtin-graph-scan",
    "metadata": {}
  }
]
```

### `stats.json`

```json
{
  "generator": "builtin-graph-scan",
  "repoName": "...",
  "repoRoot": "...",
  "scannedFiles": N,
  "skippedLargeFiles": N,
  "skippedBinaryFiles": N,
  "skippedSensitiveFiles": N,
  "skippedSecretFiles": N,
  "chunkCount": N,
  "edgeCount": N,
  "symbolCount": N,
  "dependencyCount": N,
  "docCount": N,
  "importEdgeCount": N,
  "languages": { "typescript": N, ... },
  "totalBytes": N
}
```

### `summary.md`

人类可读的仓库概览（与 builtin 服务端生成的 summary 风格对齐），末尾追加 `## Stats` JSON 代码块，可单独被 Agent 作为上下文参考。

### `run.log`

带 `[YYYY-MM-DD HH:MM:SS]` 时间戳的执行日志，记录：
- START（参数 + 输出目录）
- BUILD（扫描/跳过统计）
- DONE（输出目录 + 总字节数）
- FAIL（异常栈）
以及所有 stderr 内容（stderr 会被同步 tee 进来）。Agent 上传时可作为可观测材料一并提交。

## 4. 语言/符号抽取

只做**够准、稳、可预测**的抽取：

| 语言 | 符号提取方式 | import 提取方式 |
|------|-------------|----------------|
| TS/TSX/JS/JSX | `^export? (async )? function/class/interface/type/enum/const/let/var NAME`（正则，因为 cli-ast 不可用） | `import ... from 'x'`、`export ... from 'x'`、`require('x')` |
| Python | `^def / ^class`（按缩进判定作用域时只用起始行，不做嵌套统计） | `from X import`、`import X` |
| Go | `^func / ^type / ^var / ^const` | `import (...)` / 单行 `import "x"` |
| Rust | `^fn / ^struct / ^enum / ^trait / ^pub fn / ^pub struct ...` | 当前只记 `use X::Y` 最外层 crate |
| 其它（Java/Kt/C++/…） | 不强求，只输出 file chunk 与 import graph 若能简单 grep 到 | 同上 |
| Markdown | 按 `#..######` 切节 | 提取 `[title](相对路径)` 作为 `documents` 边 |

符号块的 `content`：起始行 ±36 行（不超过 4KB），避免整块源码膨胀；`metadata.confidence = heuristic`。

## 5. 内置排除

**目录黑名单**：`.git`、`node_modules`、`dist`、`build`、`coverage`、`.next`、`.nuxt`、`.turbo`、`.cache`、`vendor`、`target`、`__pycache__`、`.venv`、`venv`、`.idea`、`.vscode`。  
**敏感文件名**：`.env*`、`.pem`、`.key`、`.p12`、`.pfx`、`id_rsa*`、`.netrc`、`.npmrc`、`credentials.json`、`service-account-*.json`、`.ssh/`、`.aws/`、`.gcloud/`、`.azure/`、`.kube/`。  
**内容层扫密**：匹配 5 个常见 secret regex（SSH 私钥头、AKIA、ghp_/…、JWT、password=…），命中则该文件跳过，同时 `stats.skippedSecretFiles += 1`。

## 6. Skill 调用模板（Agent 直接用 Bash 即可）

```bash
builtin-graph-scan \
  --repo . \
  --output-dir .octodeck/knowledge \
  --max-files 1500 \
  --max-output-mb 32 \
  --pretty
```

后续 agent 可以：

```bash
ls -lh .octodeck/knowledge/ && wc -l .octodeck/knowledge/*.json
```

确认文件后，按 repo-knowledge 上传约定 POST 到服务端（Token 来自 env `OCTODECK_REPO_KNOWLEDGE_UPLOAD_TOKEN`，URL 来自 `OCTODECK_REPO_KNOWLEDGE_UPLOAD_URL`）。若 curl 失败也不要删除输出目录，服务端会 fallback pull 把文件拉回。

**典型完整模板（device 端 agent 直接复制执行）**：

```bash
OUT_DIR=".octodeck/knowledge"
builtin-graph-scan --repo . --output-dir "$OUT_DIR" --max-output-mb 32 --pretty \
  2>&1 | tee -a "$OUT_DIR/run.log"  # tee 防止 agent 忘记 run.log
if [ "${PIPESTATUS[0]}" -eq 0 ]; then
  curl -sS --max-time 300 --retry 2 --retry-delay 3 \
    -X POST "$OCTODECK_REPO_KNOWLEDGE_UPLOAD_URL" \
    -H "Authorization: Bearer $OCTODECK_REPO_KNOWLEDGE_UPLOAD_TOKEN" \
    -F "chunks.json=@$OUT_DIR/chunks.json;type=application/json" \
    -F "edges.json=@$OUT_DIR/edges.json;type=application/json" \
    -F "summary.md=@$OUT_DIR/summary.md;type=text/markdown" \
    -F "stats.json=@$OUT_DIR/stats.json;type=application/json" \
    -F "run.log=@$OUT_DIR/run.log;type=text/plain"
fi
```

## 7. 可观测

脚本 stderr 会被**同步 tee 到 `--output-dir/run.log`**（带时间戳 START/BUILD/DONE/FAIL 记录）。agent 最终把 `--output-dir/run.log` 连同 4 件 JSON/MD 产物一起上传，中心侧可追溯扫描了多少文件、跳过了哪些敏感/大文件、异常栈是啥。
