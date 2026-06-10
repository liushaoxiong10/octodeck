---
name: repo-knowledge-graph
description: >
  Knowledge graph construction helper for repo analysis tasks. Provides scan,
  symbol extraction, and JSON export patterns that an agent should follow when
  asked to produce a repo knowledge graph in the required output schema.
user-invocable: false
---

# Repo Knowledge Graph Generator (Skill)

当被要求为**当前仓库工作区**生成知识图谱（通常来自 `repo knowledge / AI agent graph` 流水线）时，使用本 Skill 的约定。

## 目标格式

最终必须输出一个独立的 ` ```json ... ``` ` 代码块，内容遵循：

```json
{
  "summary": "仓库语义摘要（一句话 + 小节）",
  "chunks": [
    {
      "kind": "symbol | dependency | doc | graph",
      "key": "稳定唯一标识（路径+符号/标题），必填",
      "path": "相对仓库根的文件路径，必填",
      "name": "符号名/标题",
      "language": "ts/tsx/py/go/rs/.../markdown",
      "startLine": 1,
      "endLine": 40,
      "content": "chunk 文本（尽量完整，不超过 32KB）",
      "keywords": "空格分隔，用英文",
      "metadata": { "任意附加字段": "..." }
    }
  ],
  "edges": [
    {
      "edgeKind": "imports | imported_by | depends_on | exports | documents | references",
      "key": "稳定唯一标识，必填",
      "fromPath": "起点相对路径，必填",
      "toPath": "终点相对路径（文件内引用可省略）",
      "symbol": "关联符号名（选填）",
      "packageName": "第三方包名（选填）",
      "source": "建议填 agent:repo-knowledge-graph-skill",
      "metadata": {}
    }
  ],
  "stats": { "chunkCount": 0, "edgeCount": 0, "...": "..." }
}
```

## 工作流程（推荐）

1. 用 `Bash` 扫入口：列出顶层文件、`src/`、`packages/*`、`README`、关键配置。
2. 选择 **关键路径** 深入（入口/路由/核心模块/协议类型），避免大而全。
3. 对每种语言的 AST/正则提取：
   - TS/JS：类/函数/接口/类型/常量定义 + `import/export/require`；
   - Go/Python/Rust/Java：`class/def/func/struct` 等顶级声明；
   - Markdown：按 `#`/`##` 切分文档章节；
   - `package.json`/`pyproject.toml`/`go.mod`/`Cargo.toml` → dependency chunk + depends_on 边。
4. 对内部引用（同仓库文件间 import），生成双向 `imports` + `imported_by` 边。
5. 用 LLM 语义补齐：识别模块间调用/文档交叉引用，生成 `references` 边。
6. 写出 JSON 代码块时：
   - chunks 至少 200 条，上限 1200；
   - edges 至少 200 条，上限 3000；
   - 任何时候不要输出除 JSON 代码块之外的说明文字。

## 质量约束

- 同一文件的同一符号只能出一次（去重）；
- `edgeKind` 必须严格使用枚举值；
- 不要把敏感信息（API key、密钥、带凭据的 URL）写入 content；
- 不要扫描 `node_modules/`、`.git/`、`dist/`、`build/`、`coverage/`、`.next/`、`target/`、`vendor/`、`__pycache__/`。

## 输出示例（片段）

```json
{
  "summary": "…",
  "chunks": [
    {
      "kind": "symbol",
      "key": "src/routes/foo.ts:POST /foo:createFoo",
      "path": "src/routes/foo.ts",
      "name": "createFoo",
      "language": "ts",
      "startLine": 42,
      "endLine": 98,
      "content": "…代码片段…",
      "keywords": "createFoo route handler POST",
      "metadata": { "visibility": "exported" }
    }
  ],
  "edges": [
    {
      "edgeKind": "imports",
      "key": "src/routes/foo.ts -> ../services/bar.ts",
      "fromPath": "src/routes/foo.ts",
      "toPath": "src/services/bar.ts",
      "symbol": "BarService",
      "source": "agent:repo-knowledge-graph-skill"
    }
  ],
  "stats": {}
}
```
