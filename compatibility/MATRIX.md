# DSH 兼容性矩阵

截至 2026-11-11 的 37 个官方 GitHub Release 条目。源码审查不等于运行验证。当前核心测试通过 35 个版本，其中 35 个已验证预构建安装包的加载和实际宿主版本识别。

| DSH 版本 | 流适配器 | 接口源码 | 核心宿主测试 | 自动中断/恢复 |
|---|---|---|---|---|
| 0.2.2-rc.1 | live-frames | 已审查 | 通过 | 未开放 |
| 0.2.2-alpha.3 | live-frames | 已审查 | 通过 | 未开放 |
| 0.2.1-rc.5 | live-frames | 已审查 | 通过 | 未开放 |
| 0.2.2-alpha.2 | live-frames | 已审查 | 通过 | 未开放 |
| 0.2.1-rc.4 | live-frames | 已审查 | 通过 | 未开放 |
| 0.2.1-rc.3 | live-frames | 已审查 | 通过 | 未开放 |
| 0.2.1-rc.2 | live-frames | 已审查 | 通过 | 未开放 |
| 0.2.1-rc.1 | live-frames | 已审查 | 通过 | 未开放 |
| 0.2.1-alpha.5 | live-frames | 已审查 | 通过 | 未开放 |
| 0.2.1-alpha.4 | live-frames | 已审查 | 通过 | 未开放 |
| 0.2.1-alpha.3 | live-frames | 已审查 | 通过 | 未开放 |
| 0.2.1-alpha.2 | live-frames | 已审查 | 通过 | 未开放 |
| 0.2.1-alpha.1 | live-frames | 已审查 | 通过 | 未开放 |
| 0.2.0-rc.2 | live-frames | 已审查 | 通过 | 未开放 |
| 0.2.0-rc.1 | live-frames | 已审查 | 通过 | 未开放 |
| 0.1.7-rc.2 | live-frames | 已审查 | 通过 | 未开放 |
| 0.1.7-rc.1 | live-frames | 已审查 | 通过 | 未开放 |
| 0.1.7-alpha.2 | live-frames | 已审查 | 通过 | 未开放 |
| 0.1.7-alpha.1 | live-frames | 已审查 | 通过 | 未开放 |
| 0.1.6-alpha.2 | live-frames | 已审查 | 通过 | 未开放 |
| 0.1.6-alpha.1 | live-frames | 已审查 | 通过 | 未开放 |
| 0.1.5-rc.2 | live-frames | 已审查 | 通过 | 未开放 |
| 0.1.5-rc.1 | live-frames | 已审查 | 通过 | 未开放 |
| 0.1.5-alpha.2 | live-frames | 已审查 | 通过 | 未开放 |
| 0.1.5-alpha.1 | live-frames | 已审查 | 通过 | 未开放 |
| 0.1.3-alpha.2 | live-frames | 已审查 | 通过 | 未开放 |
| 0.1.3-alpha.1 | live-frames | 已审查 | 缺少 npm 宿主包 | 未开放 |
| 0.1.2-rc.1 | stream-waterfall | 已审查 | 通过 | 未开放 |
| 0.1.2-alpha.5 | stream-waterfall | 已审查 | 通过 | 未开放 |
| 0.1.2-alpha.4 | stream-waterfall | 已审查 | 通过 | 未开放 |
| 0.1.2-alpha.3 | stream-waterfall | 已审查 | 通过 | 未开放 |
| 0.1.2-alpha.2 | stream-waterfall | 已审查 | 通过 | 未开放 |
| 0.1.2-alpha.1 | stream-waterfall | 已审查 | 缺少 npm 宿主包 | 未开放 |
| 0.1.1-rc.2 | stream-waterfall | 已审查 | 通过 | 未开放 |
| 0.1.1-rc.1 | stream-waterfall | 已审查 | 通过 | 未开放 |
| 0.1.0-rc.8 | stream-waterfall | 已审查 | 通过 | 未开放 |
| 0.1.0-rc.7 | stream-waterfall | 已审查 | 通过 | 未开放 |

核心宿主测试使用各发行版实际发布的 Cordis、AgentLoop、Session 和 Tools，并锁定整套 DSH 依赖；模型由确定性测试适配器替代。覆盖正常输出、重复推理、流数据原样转发、工具结果、单会话关闭、软纠正交付及两次追加上限、新用户输入重置预算和卸载。测试明细见 host-results.json。未包含真实 DeepSeek API、桌面端安装或性能效果评估。

0.1.2-alpha.1 和 0.1.3-alpha.1 的对应 npm 宿主包不可获取，仅完成接口源码审查和协议回放，不能宣称运行验证通过。

自动干预还需真实提供方取消、用户停止竞态和恢复预算持久化验证，所有版本均未开放。未知版本按观察接口回退，但安装器可能因明确的版本白名单拒绝安装，需要补测后更新包。未列出的 npm 构建、源码修改版、第三方分支和未来版本不属于此矩阵。
