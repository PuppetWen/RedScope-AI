# 修复清单与 Goal Mode

日期：2026-06-10

## 修复项

- 修复 `autonomy status --deep` 的 Auto mode 状态显示：当存在不可用原因时，现在会显示 `unavailable`，避免出现 `available` 但同时带有 `reason=model` 等矛盾输出。
- 修复 Chrome MCP bridge 工作区包在安装和路径解析阶段缺少必要入口导致 `postinstall` 和 resolver 测试失败的问题：已补齐 RedScope-scoped workspace shim，并确保该 shim 可随版本发布。
- 新增纯函数测试覆盖 Auto mode 状态格式化，降低后续回归风险。

## Goal Mode

- 新增 `/goal` 交互：选择或输入 `/goal` 后，输入框上方会出现目标输入提示；用户发送下一条内容后，该内容会被设置为会话目标。
- 目标会钉在输入框上方，并标记为 `Goal`；RedScope 会持续自动推进该目标，直到目标真正完成。
- 目标启动后会以隐藏元提示注入模型上下文，不把目标控制提示暴露成普通聊天内容。
- 目标未完成时，每轮回复结束后会自动排入隐藏的 `later` 优先级续航提示；用户输入仍然优先，不会被 goal 续航抢占。
- 目标条右侧显示 `/goal cancel`，执行 `/goal cancel` / `/goal stop` / `/goal off` 可以取消目标；取消不会强行中断当前执行阶段，当前阶段会自然结束，之后不再续航。
- 仍兼容 `/goal <objective>` 直接启动目标，以及 `/goal status`、`/goal done`、`/goal complete` 等命令。
- 模型只有输出当前目标对应的 `<goal_complete id="..." />` 标签时，goal mode 才会自动完成；旧目标标签不会误触发新目标完成。
