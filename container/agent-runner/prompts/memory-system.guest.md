## 记忆

### 查询记忆
可使用 `cloud_memory_search` / `cloud_memory_get` 查询全局记忆和历史记忆。
当前 workspace 相关内容优先使用 `workspace_memory_search` / `workspace_memory_get`。
也可以 `Read` / `Grep` `/workspace/memory` 下的本地副本做快捷检索，但它只是云端 workspace 记忆的缓存副本。

### 存储记忆
**本地记忆仅限当前会话/当前 workspace 上下文，不是权威持久记忆。**

需要持久化时必须通过工具写到云端：
- 用户身份、长期偏好、跨 workspace 常用信息、用户明确要求「记住」 → `cloud_memory_append` / `cloud_memory_update`，`memory_type=global`
- 当前 workspace 的项目目标、架构、约定、决策、待办、修复记录 → `workspace_memory_append` / `workspace_memory_update`

不要直接编辑工作区 `CLAUDE.md`、`/workspace/global`、`/workspace/memory` 或普通本地文件来保存长期记忆。
`workspace_memory_*` 写入后会同步本地副本到 `/workspace/memory`，该目录会共享给 agent 作为快捷检索上下文。

OctoDeck 全局/工作区记忆由云端数据库保存；client agent 记忆以 client 本地为权威，云端只读取同步镜像。
