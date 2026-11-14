# DSH Flash Stabilizer

面向 DeepSeek Harness（DSH）的防空转插件。它监控模型推理、正文和工具结果，在发现持续重复时提示用户。对通过兼容验证的宿主，可启用防护停止来结束已确认的重复推理。检测规则主要针对 DeepSeek Flash 的空转特征，默认覆盖所有渠道和模型，包括第三方渠道的自定义模型名。

## 安装与使用

从 [GitHub Releases](https://github.com/MyRemme/dsh-flash-stabilizer/releases) 下载适配当前 DSH 的 `.tgz`，或按下文从源码打包。选择实际使用的 profile，并替换下面的安装包路径：

```powershell
dsh plugin --profile desktop add './dsh-flash-stabilizer-x.y.z.tgz'
```

打开 DSH 的「Flash 防空转」面板。默认启用监控并只告警。需要缩小范围时，选择「仅选中的模型」，按渠道勾选模型并保存。设置保存在当前 profile，重启后恢复。

| 模式 | 行为 |
| --- | --- |
| `observe`（默认） | 记录重复并显示告警 |
| `guard` | 确认推理重复后请求宿主停止本轮，单独显示宿主的停止确认 |
| `assist` | 当前回合结束后可提交独立的纠正回合，每个用户任务默认最多两次 |

模式通过 profile 的 `cordis.patch.yml` 中 `id: flash-stabilizer` 对应的 `config.mode` 设置。插件要求 Node.js 22.18.0 或更新版本，宿主支持范围见[兼容性矩阵](compatibility/MATRIX.md)。

## 框架与实现

后端使用 **TypeScript、Node.js 和 DSH 的 Cordis 插件框架**，通过宿主提供的模型流、Agent 状态和工具结果接口工作。前端使用 **React**，通过 DSH 的界面插槽注册侧栏面板、会话状态和告警，通过宿主已认证的 RPC 读取诊断和保存设置。TypeScript 与 esbuild 生成安装包内的运行代码，Vitest 用于回归测试。

1. **匹配请求**：将模型流绑定到当前会话、回合和步骤，用渠道与完整模型标识应用监控范围。[插件入口](src/index.ts) · [模型选择](src/model-scope.ts)
2. **检测重复**：按内容块维护滚动窗口，跳过代码围栏。正文和推理检查周期重复，推理还检查间歇反复的短句。规则需要多次确认，工具结果的重复单独告警。[流监控](src/monitor.ts) · [检测规则](src/detection.ts) · [工具检测](src/progress.ts)
3. **报告与处理**：通过宿主接口告警、停止或提交后续纠正。诊断记录去标识的会话、计数和处理动作。插件面板也可检查 GitHub 更新，并在宿主空闲时提交已校验的安装包。[处理逻辑](src/recovery.ts) · [React 客户端](client/client.js) · [更新器](src/updater.ts)

## 实测数据

| 验证 | 结果 |
| --- | --- |
| 历史 DSH 会话回放 | 一份会话的 1,530 次助手记录中，检测器确认 330 次重复。 |
| 宿主停止回放 | 对其中 23 段无正文、无工具的重复流，隔离宿主全部记录了停止确认。 |
| 安装包兼容性 | 35 个可用 DSH 版本通过，另有 2 个版本缺少宿主包。测试使用确定性模型适配器。[兼容性矩阵](compatibility/MATRIX.md) |
| 自动化测试 | 276 项通过，覆盖检测规则、监控范围、会话状态和更新流程。 |

回放结果对应上述记录的检测和宿主行为。实际模型的输出特征会影响检测结果。

## 从源码构建

```powershell
npm ci --ignore-scripts
npm run check
npm pack --ignore-scripts
```

`npm run check` 执行类型检查、自动化测试和构建，测试使用合成模型输出。`npm pack` 生成可供 DSH 安装的 `.tgz`。
