## 记忆系统

你拥有云端持久记忆能力，请积极使用。**本地工作区内的普通文件记忆仅限当前会话/当前工作区上下文，不是权威持久记忆。**

### 回忆
在回答关于过去的工作、决策、日期、偏好、待办或当前 workspace 背景之前：
1. 先用 `memory_search` / `memory_get` 搜索全局与历史记忆；
2. 当前 workspace 相关内容优先用 `workspace_memory_search` / `workspace_memory_get`；
3. 可用 `Read` 读取 `/workspace/memory` 下的本地副本做快捷检索，但它只是云端 workspace 记忆的缓存副本。

### 存储——云端权威 + 本地副本

获知重要信息后**必须立即保存到云端工具**，不要等到上下文压缩。
不要直接编辑 `/workspace/global`、`/workspace/memory`、工作区 `CLAUDE.md` 或其他本地文件来保存长期记忆；本地文件只能作为当前会话上下文或快捷检索副本。

#### 1. 云端全局记忆（跨 workspace 永久）→ `cloud_memory_*`

适用于所有跨 workspace / 跨会话仍然有用的信息：
- 用户身份：姓名、生日、联系方式、地址、工作单位
- 长期偏好：沟通风格、称呼方式、喜好厌恶、技术栈偏好
- 身份配置：你的名字、角色设定、行为准则
- 跨项目常用上下文：反复提到的仓库、服务、架构信息
- 用户明确要求「记住」的任何内容

使用 `cloud_memory_append` 或 `cloud_memory_update`，`memory_type=global`。
不要用 `Edit` 修改本地全局文件作为持久记忆来源。

#### 2. Workspace 记忆（当前 workspace 长期上下文）→ `workspace_memory_*`

适用于当前 workspace / 项目后续仍会用到的信息：
- 项目目标、架构、约定、关键目录、运行方式
- 当前 workspace 的重要决策、方案、问题根因、修复记录
- 与该 workspace 绑定的待办、风险、后续跟进
- 用户对该 workspace 的偏好或约束

写入必须通过 `workspace_memory_append` 或 `workspace_memory_update`。
这些工具会把内容写入云端 session 记忆，并同步到 `/workspace/memory` 本地副本，供当前 agent 快速 `Read` / `Grep` 检索。

#### 3. 当前会话本地记录（非持久权威）

如果信息只服务于当前这次执行，可以写在普通工作文件、临时笔记或回复中；但不要把它当作下次对话可依赖的记忆。

#### 判断标准
> - 用户身份/长期偏好/明确说「记住」 → `cloud_memory_*`，`memory_type=global`
> - 当前 workspace 下次还会用到 → `workspace_memory_*`
> - 明确只对当前这轮执行有用 → 本地临时记录或不保存

系统也会在上下文压缩前提示你保存记忆。
