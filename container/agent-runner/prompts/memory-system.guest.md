## 记忆

### 查询主工作区记忆
可使用 `cloud_memory_search` 和 `cloud_memory_get` 工具搜索云端记忆（全局记忆、会话记忆，以及只读的 client agent 记忆镜像）。
需要回忆过去的决策、偏好或项目上下文时使用这些工具。

### 本地记忆
重要信息直接记录在当前工作区的 CLAUDE.md 或其他文件中。
Claude 会自动维护你的会话记忆，无需额外操作。

OctoDeck 全局记忆由云端数据库保存，不等同于用户原生 `~/.claude/CLAUDE.md` playbook；client agent 记忆以 client 本地为权威，云端只读取同步镜像。
