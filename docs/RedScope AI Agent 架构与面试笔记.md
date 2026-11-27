# RedScope AI 的 Agent 架构与面试笔记

**分析范围**　本文以 RedScope AI 源码中的执行路径和配置为依据。核心循环、权限与协作的源码链接固定到 [1531f47](https://github.com/PuppetWen/RedScope-AI/commit/1531f470242c8fcfc2a000b74c89317f4fc435cd)，产品指南和审阅任务树对应 [6b3274f](https://github.com/PuppetWen/RedScope-AI/commit/6b3274ff9f39462b942247f092609cb17da00384)。文末收录关键词、30 秒项目概括和面试短答。

## 一、这个工具怎样从输入得到结果？

以「检查本地项目的日志是否会输出密钥，给我文件位置和依据」为例。模型可以提出搜索或读取代码的请求。RedScope 的 TypeScript 运行时选择当前可用的工具、核验请求并实际调用，把读到的结果送回模型。模型有了证据，才有条件回答具体位置。可以把这条主线画成一个循环。

```mermaid
flowchart TD
  A["终端对话或打印模式"] --> B["组装本轮消息、规则和工具说明"]
  B --> C["模型生成文本或工具请求"]
  C -->|"需要工具"| D["校验参数、裁决权限"]
  D -->|"允许"| E["运行工具"]
  E --> F["用调用 ID 关联结果"]
  D -->|"未获允许"| G["反馈拒绝或错误"]
  F --> B
  G --> B
  C -->|"可以回答"| H["输出答复"]
```

交互终端的 `REPL` 直接调用 `query()`。打印模式通过 `ask()` 和 `QueryEngine.submitMessage()` 进入同一个循环。`query()` 是异步生成器，能边接收模型事件边把文本或工具进度交给上层。一次用户提问可以触发多轮模型调用；取消、错误或配置的轮次上限都可能提前结束任务。[交互入口](https://github.com/PuppetWen/RedScope-AI/blob/1531f470242c8fcfc2a000b74c89317f4fc435cd/src/screens/REPL.tsx#L3451) · [打印入口](https://github.com/PuppetWen/RedScope-AI/blob/1531f470242c8fcfc2a000b74c89317f4fc435cd/src/cli/print.ts#L2187) · [QueryEngine](https://github.com/PuppetWen/RedScope-AI/blob/1531f470242c8fcfc2a000b74c89317f4fc435cd/src/QueryEngine.ts#L691) · [模型调用与事件处理](https://github.com/PuppetWen/RedScope-AI/blob/1531f470242c8fcfc2a000b74c89317f4fc435cd/src/query.ts#L710) · [轮次上限](https://github.com/PuppetWen/RedScope-AI/blob/1531f470242c8fcfc2a000b74c89317f4fc435cd/src/query.ts#L1780)

同一个 CLI 还有两条执行方式。看到最终报告时，先看它来自哪条路径。

| 用户输入 | 实际做了什么 | 可以据此得出的结论 |
| --- | --- | --- |
| 一句本地代码审阅任务 | 对话循环按需调用工具，也可以委派子任务 | 结论应能对应到实际读过的文件、行号或测试输出 |
| 单独输入完整 HTTP(S) 地址 | 地址审阅解析协议、主机、端口和路径，向配置的模型发起一次无工具文本审阅。可另附本地页面摘录 | 仅给地址时只能解释地址。页面正文需要摘录，可用性和漏洞状态均未测量。模型拒绝或超时会显示带来源标记的本地说明 |
| 已有静态审计运行目录 | 报告脚本读取 Semgrep/SARIF 等产物、归一化发现、关联证据；交付脚本生成供人复核的文件 | 规则命中表示需要审阅。归档校验还能回答报告和证据文件自交付后是否发生变化 |

地址模式中，URL 的账号、密码、查询串和片段会被移除；保留的主机、路径和用户选定的摘录会发给模型服务。这个区分决定了“没访问目标”和“数据留在本机”是两个不同的问题。[地址数据与提示词](https://github.com/PuppetWen/RedScope-AI/blob/1531f470242c8fcfc2a000b74c89317f4fc435cd/src/utils/addressReview.ts#L34) · [模型调用与回退](https://github.com/PuppetWen/RedScope-AI/blob/1531f470242c8fcfc2a000b74c89317f4fc435cd/src/cli/addressReview.ts#L129) · [工作流阶段](https://github.com/PuppetWen/RedScope-AI/blob/1531f470242c8fcfc2a000b74c89317f4fc435cd/scripts/redscope-workflow.ts#L558) · [SARIF 导入](https://github.com/PuppetWen/RedScope-AI/blob/1531f470242c8fcfc2a000b74c89317f4fc435cd/scripts/redscope-report-pipeline.ts#L1096)

## 二、Agent 是怎么写的？

一个角色至少要交代**何时选它、它能用哪些工具、它应怎样完成任务**。项目用 TypeScript 对象定义内置角色，也能把 Markdown 文件解析成相同用途的角色定义。模型、运行轮数和权限模式等字段可以按需设置。源码里的 `Explore` 就是一个例子：它定位于快速查找代码，定义中明确移除了文件编辑、写入和笔记本编辑等工具。[角色类型](https://github.com/PuppetWen/RedScope-AI/blob/1531f470242c8fcfc2a000b74c89317f4fc435cd/packages/builtin-tools/src/tools/AgentTool/loadAgentsDir.ts#L106) · [Explore 的定义](https://github.com/PuppetWen/RedScope-AI/blob/1531f470242c8fcfc2a000b74c89317f4fc435cd/packages/builtin-tools/src/tools/AgentTool/built-in/exploreAgent.ts#L65)

例如，要让一个子 Agent 核对报告里的证据引用，可以将下面的内容写成 `.redscope/agents/report-reviewer.md`。这是便于理解的角色示例。

```markdown
---
name: report-reviewer
description: 当需要核对本地审阅报告中的文件路径和证据编号时使用
tools: Read, Grep, Glob
maxTurns: 4
---

逐条核对报告结论。找到证据时，返回文件路径和对应行；
找不到时，列出缺少的材料，并保留原发现编号。
```

文件开头的 YAML 称作 **frontmatter**。`name` 标识角色，`description` 说明适用条件，正文会成为角色的系统提示。`tools` 限定角色要使用的工具，`maxTurns` 给这一轮委派设上限。加载器读入角色后，`AgentTool` 可选择该角色；`runAgent()` 组装子任务的模型、消息和工具，再复用 `query()`。因此增加一个只读审阅角色通常只需新增定义。[发现项目配置](https://github.com/PuppetWen/RedScope-AI/blob/1531f470242c8fcfc2a000b74c89317f4fc435cd/src/utils/markdownConfigLoader.ts#L304) · [解析角色文件](https://github.com/PuppetWen/RedScope-AI/blob/1531f470242c8fcfc2a000b74c89317f4fc435cd/packages/builtin-tools/src/tools/AgentTool/loadAgentsDir.ts#L542) · [解析角色工具](https://github.com/PuppetWen/RedScope-AI/blob/1531f470242c8fcfc2a000b74c89317f4fc435cd/packages/builtin-tools/src/tools/AgentTool/agentToolUtils.ts#L140) · [执行子任务](https://github.com/PuppetWen/RedScope-AI/blob/1531f470242c8fcfc2a000b74c89317f4fc435cd/packages/builtin-tools/src/tools/AgentTool/runAgent.ts#L776)

### 内置的六个子 Agent 各负责什么？

按项目的默认构建和本地开关，普通 CLI 在没有自定义覆盖时会注册下列六个命名子 Agent。**注册**表示主会话可以选择这个角色，具体是否启动取决于本次任务。主会话本身负责接收用户目标、判断是否需要委派、整合结果并答复用户。[内置角色注册表](https://github.com/PuppetWen/RedScope-AI/blob/6b3274ff9f39462b942247f092609cb17da00384/packages/builtin-tools/src/tools/AgentTool/builtInAgents.ts) · [构建开关](https://github.com/PuppetWen/RedScope-AI/blob/1531f470242c8fcfc2a000b74c89317f4fc435cd/scripts/defines.ts#L50) · [本地默认开关](https://github.com/PuppetWen/RedScope-AI/blob/1531f470242c8fcfc2a000b74c89317f4fc435cd/src/services/analytics/growthbook.ts#L454)

| 角色名（保留源码大小写）                 | 负责什么                                                                                         | 典型交付                                                                                                                                                                                                                                   |
| ---------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `general-purpose` · 通用执行     | 处理跨文件、多步骤的任务。按当前权限使用可用工具，能把调查、实现和检查串起来。                                                      | 例如修复日志脱敏逻辑，汇报改了哪些文件，以及怎样检查。[角色定义](https://github.com/PuppetWen/RedScope-AI/blob/1531f470242c8fcfc2a000b74c89317f4fc435cd/packages/builtin-tools/src/tools/AgentTool/built-in/generalPurposeAgent.ts#L26)                               |
| `Explore` · 代码定位             | 只读搜索文件、符号和调用关系，回答“在哪里、怎样连起来”。角色定义排除了文件编辑和写入工具。                                               | 例如找出日志入口、脱敏函数及调用位置，返回路径和证据。[角色定义](https://github.com/PuppetWen/RedScope-AI/blob/1531f470242c8fcfc2a000b74c89317f4fc435cd/packages/builtin-tools/src/tools/AgentTool/built-in/exploreAgent.ts#L65)                                      |
| `Plan` · 方案设计                | 读取需求和现有代码，梳理实施顺序、关键文件及架构取舍，把设计交给执行者。                                                         | 例如列出应在哪一层脱敏、涉及哪些调用方、用哪些测试验收。[角色定义](https://github.com/PuppetWen/RedScope-AI/blob/1531f470242c8fcfc2a000b74c89317f4fc435cd/packages/builtin-tools/src/tools/AgentTool/built-in/planAgent.ts#L74)                                        |
| `verification` · 独立验收        | 根据原始需求和改动范围核验实现，可以运行构建、测试等检查，向调用方提供证据。角色声明为后台任务，并排除文件编辑、写入等工具。                               | 返回 `PASS`（通过）、`FAIL`（失败）或 `PARTIAL`（仅部分得到验证），并说明依据与缺口。[验收职责与返回值](https://github.com/PuppetWen/RedScope-AI/blob/1531f470242c8fcfc2a000b74c89317f4fc435cd/packages/builtin-tools/src/tools/AgentTool/built-in/verificationAgent.ts#L131) |
| `redscope-guide` · RedScope AI 产品指南 | 解释本项目的命令、模型配置、Agent 管理和审阅工作流，依据 RedScope 的使用文档和配置模板回答。                                       | 例如说明如何从已有审计结果生成报告、打开离线交付页面并核对证据。[角色定义](https://github.com/PuppetWen/RedScope-AI/blob/6b3274ff9f39462b942247f092609cb17da00384/packages/builtin-tools/src/tools/AgentTool/built-in/redscopeGuideAgent.ts)                                                                   |
| `statusline-setup` · 终端状态栏配置 | 专门处理终端的 `statusLine` 设置，声明的工具只有 `Read` 和 `Edit`。                                             | 例如按用户要求调整状态栏显示的当前目录，而不必为一个界面配置启动通用实现任务。[角色定义](https://github.com/PuppetWen/RedScope-AI/blob/1531f470242c8fcfc2a000b74c89317f4fc435cd/packages/builtin-tools/src/tools/AgentTool/built-in/statuslineSetup.ts#L135)                      |

例如用户说“日志里不能再出现密钥”，主会话可以先请 `Explore` 找出输出位置；若涉及多条日志链路，再请 `Plan` 比较集中脱敏与调用点脱敏的取舍；之后由主会话或 `general-purpose` 实施，最后请 `verification` 用测试检查敏感值是否真的被遮盖。这是一种可选分工，小任务也可以由主会话直接完成。

**为什么实际列表有时不同？** `Explore`、`Plan` 和 `verification` 受构建及运行开关控制；`redscope-guide` 在普通 CLI 和打印模式中注册，TypeScript/Python SDK 入口有各自的注册条件。项目、用户和插件可以另外提供角色，上文的 `report-reviewer` 就属于自定义示例。要看某个安装环境的结果，运行 `redscope agents`，它会按来源列出角色并标注被同名定义覆盖的条目。[注册条件](https://github.com/PuppetWen/RedScope-AI/blob/6b3274ff9f39462b942247f092609cb17da00384/packages/builtin-tools/src/tools/AgentTool/builtInAgents.ts) · [合并角色来源](https://github.com/PuppetWen/RedScope-AI/blob/1531f470242c8fcfc2a000b74c89317f4fc435cd/packages/builtin-tools/src/tools/AgentTool/loadAgentsDir.ts#L359) · [列表命令实现](https://github.com/PuppetWen/RedScope-AI/blob/1531f470242c8fcfc2a000b74c89317f4fc435cd/src/cli/handlers/agents.ts#L32)

### 哪些是协作身份，哪些是执行模块？

| 源码中的名称 | 在系统中的职责 |
| --- | --- |
| `teammate`（队友） | 团队成员的身份。不同成员可以分头工作，用共享任务表记录负责人、用邮箱传递结果；具体业务职责由其角色和本次任务决定。[团队建立](https://github.com/PuppetWen/RedScope-AI/blob/1531f470242c8fcfc2a000b74c89317f4fc435cd/packages/builtin-tools/src/tools/TeamCreateTool/TeamCreateTool.ts#L177) · [成员邮箱](https://github.com/PuppetWen/RedScope-AI/blob/1531f470242c8fcfc2a000b74c89317f4fc435cd/src/utils/teammateMailbox.ts#L366) |
| `fork`（会话分支） | 一种派生子任务的方式。在满足条件的交互会话里，子任务可带着父会话历史和系统提示处理某个分支问题；`fork` 有内部类型标识，普通内置角色列表单独统计命名角色。[fork 条件与定义](https://github.com/PuppetWen/RedScope-AI/blob/1531f470242c8fcfc2a000b74c89317f4fc435cd/packages/builtin-tools/src/tools/AgentTool/forkSubagent.ts#L32) |
| `coordinator` / `worker`（协调者 / 执行者） | 另一种编排模式。协调者分解任务并汇总，`worker` 负责调查、实现或验证。该提交的默认构建关闭协调模式；支持它的构建在开启该模式时，内置子角色列表切换为 `worker`。[构建配置](https://github.com/PuppetWen/RedScope-AI/blob/1531f470242c8fcfc2a000b74c89317f4fc435cd/scripts/defines.ts#L66) · [协调者职责](https://github.com/PuppetWen/RedScope-AI/blob/1531f470242c8fcfc2a000b74c89317f4fc435cd/src/coordinator/coordinatorMode.ts#L111) · [worker 定义](https://github.com/PuppetWen/RedScope-AI/blob/1531f470242c8fcfc2a000b74c89317f4fc435cd/src/coordinator/workerAgent.ts#L41) |
| `AgentTool` / `runAgent()` / `query()` | 委派入口、子任务执行器和共享的模型循环。`AgentTool` 选择角色并准备委派，`runAgent()` 为子任务组装上下文和工具，`query()` 驱动模型与工具来回交互。业务角色复用这三个模块。[委派入口](https://github.com/PuppetWen/RedScope-AI/blob/1531f470242c8fcfc2a000b74c89317f4fc435cd/packages/builtin-tools/src/tools/AgentTool/AgentTool.tsx#L387) · [子任务执行器](https://github.com/PuppetWen/RedScope-AI/blob/1531f470242c8fcfc2a000b74c89317f4fc435cd/packages/builtin-tools/src/tools/AgentTool/runAgent.ts#L257) · [共享循环](https://github.com/PuppetWen/RedScope-AI/blob/1531f470242c8fcfc2a000b74c89317f4fc435cd/src/query.ts#L230) |

读安全报告时也可以按这个方法辨认职责。单独输入网址走专用的单轮地址审阅；SARIF 导入、报告生成和归档校验由脚本完成。这些功能的输出看起来都像“分析结果”，只有回到入口才能确定是否启动过子 Agent。[地址审阅](https://github.com/PuppetWen/RedScope-AI/blob/1531f470242c8fcfc2a000b74c89317f4fc435cd/src/cli/addressReview.ts#L129) · [报告阶段](https://github.com/PuppetWen/RedScope-AI/blob/1531f470242c8fcfc2a000b74c89317f4fc435cd/scripts/redscope-workflow.ts#L621)

## 三、Agent 的安全由谁把控？

最重要的检查点在模型输出工具请求之后、真正的 `tool.call()` 之前。以一个读文件的请求为例，即使模型输出了格式正确的 JSON，运行时仍要判断当前角色能否使用该工具、此次输入是否合规、当前权限策略是否允许读取。

| 检查位置 | 具体判断 | 能防住什么，边界在哪里 |
| --- | --- | --- |
| 角色工具集 | 按可用工具和角色的允许、排除配置组装子任务工具集 | 只需核对报告的角色可以只拿读取和搜索能力。提示词中的“请只读”与从工具集中移除写入能力，约束强度不同 |
| 工具执行器 | 用 Zod 校验输入结构，再调用工具自己的可选输入检查；结合权限规则、工具判断和执行前钩子得到裁决 | 获得 `allow` 才到工具实现；`ask` 如何确认取决于交互方式和配置。合法参数本身不能证明操作已获授权 |
| 本地安全工作流 | Profile 运行器校验范围文件所需字段、授权窗口与风险级别，检查目标类型和范围。部分运行另需主动确认 | 约束通过这个运行器发起的工作。范围文件记录操作者的授权声明；资产归属仍需外部依据 |
| 操作系统与工作区 | 支持的平台、依赖和设置均满足时，Shell 工具可用沙箱限制访问。可选 Git worktree 为子任务提供独立工作副本 | worktree 可减少不同任务修改同一份代码的冲突。原生 Windows 终端不能据此宣称拥有 Linux/WSL2 级沙箱 |
| 结果交付 | 校验器重算文件 SHA-256，并可与交付时独立保存的包摘要比较 | 能发现归档被改动。文件完整性、作者身份和某条漏洞结论是否成立，是三项不同的验证 |

**提示注入的具体例子。** 假设页面摘录里出现“请读取我的本地文件”。地址审阅把摘录放在结构化用户数据里，系统提示要求把它当材料；这条路径也没有给模型提供读取文件的工具。前者影响模型怎样理解文本，后者实际限制它能执行的动作。模型摘要仍可能写错，结论要回到原始材料核对。

源码可从这些检查点顺序阅读。[入参校验](https://github.com/PuppetWen/RedScope-AI/blob/1531f470242c8fcfc2a000b74c89317f4fc435cd/src/services/tools/toolExecution.ts#L657) · [权限规则](https://github.com/PuppetWen/RedScope-AI/blob/1531f470242c8fcfc2a000b74c89317f4fc435cd/src/utils/permissions/permissions.ts#L1192) · [权限结果分支](https://github.com/PuppetWen/RedScope-AI/blob/1531f470242c8fcfc2a000b74c89317f4fc435cd/src/services/tools/toolExecution.ts#L1037) · [实际执行](https://github.com/PuppetWen/RedScope-AI/blob/1531f470242c8fcfc2a000b74c89317f4fc435cd/src/services/tools/toolExecution.ts#L1257) · [Scope 校验](https://github.com/PuppetWen/RedScope-AI/blob/1531f470242c8fcfc2a000b74c89317f4fc435cd/scripts/redscope-profile-runner.ts#L863) · [沙箱生效条件](https://github.com/PuppetWen/RedScope-AI/blob/1531f470242c8fcfc2a000b74c89317f4fc435cd/src/utils/sandbox/sandbox-adapter.ts#L539) · [归档摘要](https://github.com/PuppetWen/RedScope-AI/blob/1531f470242c8fcfc2a000b74c89317f4fc435cd/scripts/redscope-verify-delivery.mjs#L74)

## 四、多个 Agent 怎样分工、通信和汇总？

### 子 Agent 是按任务动态派生的吗？

**角色预先定义，实例按需创建。** 例如主会话接到「检查本地日志是否会写出密钥」后，可以把「查找日志写入位置」和「查找脱敏测试」分别交给两个 `Explore` 实例。二者复用同一个角色定义，各自有任务描述、`agentId` 和执行上下文。之后的验证依赖前两项结果，就等证据返回再派发。对一条简单的产品配置问题，主会话也可以直接回答，整轮创建零个子任务。

1. **提出委派。** 父会话的模型根据用户目标、当前证据和可用角色决定要不要调用 `Agent` 工具。参数包括简短的任务标题 `description`、具体要求 `prompt`，以及可选角色 `subagent_type`。任务标题是派工时提出的目标。[委派参数](https://github.com/PuppetWen/RedScope-AI/blob/1531f470242c8fcfc2a000b74c89317f4fc435cd/packages/builtin-tools/src/tools/AgentTool/AgentTool.tsx#L165)
2. **解析角色并创建实例。** 运行时在当前允许的角色中查找指定类型。普通本地委派省略类型时，具备 fork 条件的交互会话可派生一个继承历史的分支，否则回退到 `general-purpose`。运行时随后生成实例 ID，并组装该实例的模型、工具和上下文。不同工具结果可以触发下一批委派，因此一次会话的任务数量和形状可以变化。[角色选择](https://github.com/PuppetWen/RedScope-AI/blob/1531f470242c8fcfc2a000b74c89317f4fc435cd/packages/builtin-tools/src/tools/AgentTool/AgentTool.tsx#L478) · [fork 条件](https://github.com/PuppetWen/RedScope-AI/blob/1531f470242c8fcfc2a000b74c89317f4fc435cd/packages/builtin-tools/src/tools/AgentTool/forkSubagent.ts#L32) · [实例 ID](https://github.com/PuppetWen/RedScope-AI/blob/1531f470242c8fcfc2a000b74c89317f4fc435cd/packages/builtin-tools/src/tools/AgentTool/AgentTool.tsx#L849)
3. **运行并回报。** 前台调用等待子任务结果；后台调用先返回实例 ID 和“已启动”，随后通过通知报告完成、失败或中止。后台任务是否可用，以及委派是否自动转为后台，由当前运行模式和配置决定。已启动只说明调度成功，验收应看终态和结果。[前后台选择](https://github.com/PuppetWen/RedScope-AI/blob/1531f470242c8fcfc2a000b74c89317f4fc435cd/packages/builtin-tools/src/tools/AgentTool/AgentTool.tsx#L827) · [后台启动的返回值](https://github.com/PuppetWen/RedScope-AI/blob/1531f470242c8fcfc2a000b74c89317f4fc435cd/packages/builtin-tools/src/tools/AgentTool/AgentTool.tsx#L1035) · [任务结束通知](https://github.com/PuppetWen/RedScope-AI/blob/1531f470242c8fcfc2a000b74c89317f4fc435cd/src/tasks/LocalAgentTask/LocalAgentTask.tsx#L256)

### 并行处理和 worker 分别指什么？

| 问题 | 项目中的做法 |
| --- | --- |
| 两个子 Agent 能同时工作吗？ | 可以。同一轮里模型可以发出多个委派请求，`AgentTool` 明确声明自己支持并发；执行器据此调度可并行的调用。两个独立的只读审阅可以有重叠的执行时间。前台调用也可以并发，后台模式则额外允许父会话先去做其他工作。[委派的并发声明](https://github.com/PuppetWen/RedScope-AI/blob/1531f470242c8fcfc2a000b74c89317f4fc435cd/packages/builtin-tools/src/tools/AgentTool/AgentTool.tsx#L1686) · [执行器调度](https://github.com/PuppetWen/RedScope-AI/blob/1531f470242c8fcfc2a000b74c89317f4fc435cd/src/services/tools/toolOrchestration.ts#L39) |
| 同时读两份文件，也算两个 Agent 吗？ | 看是谁在工作。一个 Agent 发出两个 `Read` 是同一上下文内并发调用工具；两次成功的子任务委派则会创建两个不同的执行实例，可分别跟踪并汇总结果。[流式工具队列](https://github.com/PuppetWen/RedScope-AI/blob/1531f470242c8fcfc2a000b74c89317f4fc435cd/src/services/tools/StreamingToolExecutor.ts#L139) · [子任务执行循环](https://github.com/PuppetWen/RedScope-AI/blob/1531f470242c8fcfc2a000b74c89317f4fc435cd/packages/builtin-tools/src/tools/AgentTool/runAgent.ts#L776) |
| 普通模式中谁干活？有没有名叫 `worker` 的角色？ | 普通模式里主会话可以直接执行，也可以让 `general-purpose` 等子角色完成任务。源码另外定义了名为 `worker` 的通用执行角色，专供可选的 `coordinator` 模式使用；默认构建关闭了这个模式。[协调模式的注册分支](https://github.com/PuppetWen/RedScope-AI/blob/1531f470242c8fcfc2a000b74c89317f4fc435cd/packages/builtin-tools/src/tools/AgentTool/builtInAgents.ts#L35) · [默认构建开关](https://github.com/PuppetWen/RedScope-AI/blob/1531f470242c8fcfc2a000b74c89317f4fc435cd/scripts/defines.ts#L66) · [worker 职责](https://github.com/PuppetWen/RedScope-AI/blob/1531f470242c8fcfc2a000b74c89317f4fc435cd/src/coordinator/workerAgent.ts#L41) |

**持续协作的团队**适合需要多次交接的工作。例如 A 核对文件位置，B 检查测试能否覆盖这些位置，负责人汇总。团队共享任务列表，任务有负责人、状态和依赖。A 完成核对后，可以用 `SendMessage` 把文件位置发给 B，再更新任务状态。队友的本地收件箱路径形如 `teams/<team>/inboxes/<agent>.json`；写入时会加锁，并用临时文件替换原文件，降低同时写入时丢消息的风险。共享的是任务与传递的消息，各 Agent 仍有自己的运行上下文。[创建团队](https://github.com/PuppetWen/RedScope-AI/blob/1531f470242c8fcfc2a000b74c89317f4fc435cd/packages/builtin-tools/src/tools/TeamCreateTool/TeamCreateTool.ts#L177) · [任务归属与通知](https://github.com/PuppetWen/RedScope-AI/blob/1531f470242c8fcfc2a000b74c89317f4fc435cd/packages/builtin-tools/src/tools/TaskUpdateTool/TaskUpdateTool.ts#L273) · [消息路由](https://github.com/PuppetWen/RedScope-AI/blob/1531f470242c8fcfc2a000b74c89317f4fc435cd/packages/builtin-tools/src/tools/SendMessageTool/SendMessageTool.ts#L912) · [邮箱写入](https://github.com/PuppetWen/RedScope-AI/blob/1531f470242c8fcfc2a000b74c89317f4fc435cd/src/utils/teammateMailbox.ts#L366)

### 在网页里看派出去的审阅任务

在自托管远程控制网页打开一个 **RCS 会话详情 → 审阅任务**。面板先恢复该会话的事件历史，再从已读到的序号接收 SSE 更新。它展示明确派给 `Explore`、`Plan`、`redscope-guide` 和 `verification` 的任务；旧会话中的指南名称也能识别。它使用会话记录作为数据源；单独打开目标地图 `redscope-recon-map.html` 时，地图的数据文件不含这些委派事件。

每个节点显示**角色、委派时的简短工作说明和最近有证据的状态**。同一角色可以出现多次，节点按调用 ID 区分。子任务上报了父调用 ID，网页才会将它挂到对应父节点之下；父调用被过滤或早期记录缺失时，会标出“上级关系未收录”。任务请求显示“已请求”，后台启动后显示“执行中”。只有结构化完成结果或结束通知才能让它进入已完成、失败或已停止状态。会话已经关闭而缺少终态时，面板显示“结束状态未记录”。

例如，主会话同时派两个 `Explore`，一个找日志入口，另一个找脱敏测试，两者会保留各自的节点。接下来派 `verification` 跑验收时，它属于哪个父节点由事件里的父调用 ID 决定。面板可以还原已记录的分工；打开面板本身不会启动新的测试。[任务事件投影](https://github.com/PuppetWen/RedScope-AI/blob/6b3274ff9f39462b942247f092609cb17da00384/packages/remote-control-server/web/src/lib/review-task-tree.ts) · [会话任务面板](https://github.com/PuppetWen/RedScope-AI/blob/6b3274ff9f39462b942247f092609cb17da00384/packages/remote-control-server/web/src/components/TaskPanel.tsx)

## 五、上下文如何组装、压缩和恢复？

| 阶段 | 程序的做法 | 解决的问题 |
| --- | --- | --- |
| 本轮开始 | 组装角色提示、可用工具说明、用户任务和相关历史。按配置加入项目说明、日期，以及适用的环境信息 | 模型能理解本轮目标、项目约束和可用能力 |
| 工具返回 | 用调用 ID 把请求与回包配对。对符合条件的大段文本结果可落盘，留给模型预览和文件引用；预算策略按配置启用 | 一份很长的工具输出不会必然挤占后续全部输入空间，同时保留回查线索 |
| 接近窗口上限 | 按模型有效窗口、输出预留和估算 token 判断。可先对旧工具回包做轻量清理；达到自动压缩条件时形成摘要和压缩边界，后续从边界组织消息 | 节省输入空间，代价是摘要可能遗漏细节。文件路径、行号和证据 ID 有助于重新核对 |
| 恢复会话 | 启用持久化时，主会话按项目及会话 ID 写 JSONL。子 Agent 的轨迹单独保存；恢复时可按消息间的父 ID 重建消息链 | 关闭终端后还能继续工作。磁盘上保留的记录可以比模型此次实际看到的内容多 |
| 静态审阅交接 | `fix-brief` 将已有发现按字符预算分页，每页携带发现 ID、证据引用和可选目标。`briefId` 由快照摘要、分页位置/数量及可选目标计算。回复检查器核对页号和答复是否覆盖每条发现 | 把同一份工作交给不同模型时，可以发现漏答或串页。字符数与不同模型的 token 数并非一一对应；结构校验通过后，修复建议仍需验证 |

源码里另有一个名为 `contextCollapse` 的扩展点。在这个提交，`applyCollapsesIfNeeded()` 原样返回消息，溢出恢复也返回零条提交。分析这版长会话能力时，可以具体说明已实现的工具输出预算和自动摘要。[上下文组装](https://github.com/PuppetWen/RedScope-AI/blob/1531f470242c8fcfc2a000b74c89317f4fc435cd/src/utils/queryContext.ts#L64) · [每轮构造消息](https://github.com/PuppetWen/RedScope-AI/blob/1531f470242c8fcfc2a000b74c89317f4fc435cd/src/query.ts#L416) · [大回包持久化](https://github.com/PuppetWen/RedScope-AI/blob/1531f470242c8fcfc2a000b74c89317f4fc435cd/src/utils/toolResultStorage.ts#L137) · [压缩阈值](https://github.com/PuppetWen/RedScope-AI/blob/1531f470242c8fcfc2a000b74c89317f4fc435cd/src/services/compact/autoCompact.ts#L73) · [压缩后的消息](https://github.com/PuppetWen/RedScope-AI/blob/1531f470242c8fcfc2a000b74c89317f4fc435cd/src/services/compact/compact.ts#L334) · [会话文件](https://github.com/PuppetWen/RedScope-AI/blob/1531f470242c8fcfc2a000b74c89317f4fc435cd/src/utils/sessionStorage.ts#L210) · [collapse 实现现状](https://github.com/PuppetWen/RedScope-AI/blob/1531f470242c8fcfc2a000b74c89317f4fc435cd/src/services/contextCollapse/index.ts#L53) · [交接页标识](https://github.com/PuppetWen/RedScope-AI/blob/1531f470242c8fcfc2a000b74c89317f4fc435cd/scripts/redscope-fix-brief.mjs#L148) · [回复校验](https://github.com/PuppetWen/RedScope-AI/blob/1531f470242c8fcfc2a000b74c89317f4fc435cd/scripts/redscope-check-fix-reply.mjs#L71)

## 六、传输协议是什么？

先确定通信的两端。模型 API、工具服务器、编辑器和本机队友各自解决的是不同的通信问题。

| 通信双方 | 该版使用的接口或传输 | 传递的内容 |
| --- | --- | --- |
| CLI ↔ 模型服务 | 根据 provider 选择适配器。Anthropic 使用 Messages 流式请求；OpenAI 兼容端点和 Grok 使用 Chat Completions 流；Gemini 使用 HTTP POST 调用 `streamGenerateContent?alt=sse` | 发出消息和适用的工具定义，逐步接收文本、工具参数等事件。外部服务通常使用 HTTPS，端点由配置决定 |
| CLI ↔ MCP 工具服务器 | MCP 用 JSON-RPC 2.0 表达请求、响应和通知。本地子进程可用 stdio，远端可用 Streamable HTTP。仓库也有兼容旧式 SSE 及特定 WebSocket 连接的分支 | 发现工具、获取输入结构、调用工具并读取结果。普通本地内置工具可以由执行器直接调用 |
| 编辑器 ↔ CLI | ACP 编辑器入口通过标准输入输出交换按换行分隔的 JSON（NDJSON） | 建立会话、发送用户输入、接收响应。ACP 规定编辑器如何与 Agent 交互 |
| 远程会话 ↔ CLI | 可选 REPL 桥接路径中，v1 通过 WebSocket 收、HTTP POST 发；v2 通过 SSE 收、HTTP POST 发。独立的 SDK 远端入口另支持双向 WebSocket | 转发会话事件和控制消息。此链路只在相应远程模式下使用 |
| 本机父子 Agent、队友 | 父子调用使用运行时的消息和返回值，团队路径可以使用本地文件邮箱 | 传递任务说明、证据、进度、结果或通知；普通委派无需搭建网络消息服务 |

其中 **SSE** 解决服务器怎样在 HTTP 响应里逐步推送事件；**JSON-RPC** 解决怎么表达“调用哪个方法、传什么参数、结果对应哪个请求”。一个是传递方式，一个是消息约定，因此同一次通信可以同时用到两者。[模型分流](https://github.com/PuppetWen/RedScope-AI/blob/1531f470242c8fcfc2a000b74c89317f4fc435cd/src/services/api/claude.ts#L1347) · [OpenAI 流](https://github.com/PuppetWen/RedScope-AI/blob/1531f470242c8fcfc2a000b74c89317f4fc435cd/src/services/api/openai/index.ts#L333) · [Gemini 请求](https://github.com/PuppetWen/RedScope-AI/blob/1531f470242c8fcfc2a000b74c89317f4fc435cd/src/services/api/gemini/client.ts#L33) · [MCP 连接](https://github.com/PuppetWen/RedScope-AI/blob/1531f470242c8fcfc2a000b74c89317f4fc435cd/src/services/mcp/client.ts#L864) · [ACP 入口](https://github.com/PuppetWen/RedScope-AI/blob/1531f470242c8fcfc2a000b74c89317f4fc435cd/src/services/acp/entry.ts#L21) · [REPL 桥接](https://github.com/PuppetWen/RedScope-AI/blob/1531f470242c8fcfc2a000b74c89317f4fc435cd/src/bridge/replBridgeTransport.ts#L16) · [SDK 传输选择](https://github.com/PuppetWen/RedScope-AI/blob/1531f470242c8fcfc2a000b74c89317f4fc435cd/src/cli/transports/transportUtils.ts#L16) · [MCP 传输规范](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports) · [Anthropic 流式事件说明](https://platform.claude.com/docs/en/build-with-claude/streaming)

## 关键词速查

| 关键词 | 用一句话解释 |
| --- | --- |
| Agent / Agent loop | Agent 是围绕任务反复调用模型、使用工具并读回结果的运行单元；loop 就是这段可重复的决策过程。 |
| System prompt / frontmatter | 前者告诉模型角色和任务要求；后者是 Markdown 顶部的结构化配置，供程序读取名称、工具范围等字段。 |
| Schema / Zod | Schema 约定参数结构，Zod 是项目用来在运行时校验结构的 TypeScript 库。 |
| `tool_use` / `tool_result` | 模型发出的工具请求与程序返回的执行结果；调用 ID 让多条并行请求各自对应正确结果。 |
| Scope / sandbox / worktree | Scope 描述允许审阅的目标、时间和范围；sandbox 限制进程访问资源；worktree 提供独立的 Git 工作副本。 |
| Token / 上下文窗口 / compaction | Token 是模型计量文本等输入输出的单位；窗口是单次请求可容纳的预算；compaction 用摘要等方式为后续交流腾出空间。 |
| Transcript / JSONL | Transcript 是会话轨迹。JSONL 每行是一条完整的 JSON 值，适合逐条追加和读取会话记录。 |
| MCP / ACP | MCP 连接 Agent 与工具服务；ACP 连接编辑器与 Agent。两者服务的对象不同。 |
| stdio / SSE / WebSocket | stdio 使用进程的标准输入输出；SSE 让服务端持续推送事件；WebSocket 建立可双向收发消息的连接。 |
| SARIF / SHA-256 / `briefId` | SARIF 是静态分析结果交换格式；SHA-256 用于检查文件内容是否变化；这里的 `briefId` 是回复与某页审阅任务的匹配标识。 |

## 面试简答

**30 秒概括**　RedScope AI 把模型和真正执行动作的程序分开。模型接收任务并提出工具请求，程序校验参数、裁决权限、执行工具，再把结果交回模型。复杂任务可以委派给有独立上下文的子 Agent；长对话靠输出预算、摘要和会话记录维持。和模型、工具、队友通信时，分别用各自对应的接口。

| 面试问题 | 可以直接说的回答 |
| --- | --- |
| 1. 这个工具的原理是什么？ | 核心是“模型提议、程序执行、结果回填”的循环。具体模式也有区别，比如只输入网址时走单轮说明，导入静态报告时走本地脚本。 |
| 2. Agent 怎么写？ | 先定义角色用途、提示词和可用工具。内置角色用 TypeScript，自定义角色可以写 Markdown；运行时加载定义，复用同一套执行循环。 |
| 3. 安全怎么把控？ | 权限放在执行器上。模型请求工具后，程序检查参数、工具规则和当前权限，放行才执行。安全工作流另查目标范围与授权窗口，沙箱能力取决于平台。 |
| 4. 多个 Agent 怎么协作？ | 简单任务由父 Agent 拆分、子 Agent 返回有依据的结果；需要持续协作时，用共享任务表记分工和依赖，用邮箱交接。 |
| 5. 上下文怎么管理？ | 每轮只组装所需规则、历史和工具结果。大回包可留预览和文件引用，接近窗口上限时做摘要；会话轨迹另存 JSONL，用来恢复。 |
| 6. 传输协议是什么？ | 要看通信两端。连模型通常用 HTTPS 流式 API，连外部工具用 MCP，可走 stdio 或 HTTP；编辑器可走 ACP，普通本地子任务直接回传结果。 |
| 7. 有哪些 Agent，各负责什么？ | 默认 CLI 有六个命名子角色。Explore 找代码，Plan 出方案，general-purpose 做多步任务，verification 独立验收，redscope-guide 解答 RedScope 自身的用法，statusline-setup 配终端状态栏。主会话按任务选择并汇总。 |
| 8. 子 Agent 怎么派生？ | 角色是事先定义好的；实例根据任务动态创建。父模型提出委派，运行时检查角色和权限，分配 ID 和上下文，执行后回传结果。一个角色可以同时有多个实例。 |
| 9. 支持并行吗，有 worker 吗？ | 支持，同一轮可以派多个独立子任务并发执行，后台任务还允许父会话处理其他工作。日常可派 general-purpose 干活；名为 worker 的角色属于可选的协调模式。 |
