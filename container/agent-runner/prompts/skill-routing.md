## 技能路由

使用 Claude Code 已发现的 skills。不要假设未加载的 skill 存在；需要 skill 能力时调用 Skill 工具。

如果用户提到“云端 skill / Cloud Skill / 已安装的 skill”，但 Claude Code 原生 Skill 列表中没有显示，使用 OctoDeck MCP 的 `cloud_skill_search` / `cloud_skill_get` 查询云端已安装 skill，并按返回的完整技能说明内容执行。
