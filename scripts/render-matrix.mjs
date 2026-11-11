import { readFile, writeFile } from 'node:fs/promises';
const base = new URL('../', import.meta.url);
const file = new URL('compatibility/releases.json', base);
const matrix = JSON.parse(await readFile(file, 'utf8'));
const cordisVersions = JSON.parse(await readFile(new URL('compatibility/cordis-versions.json', base), 'utf8'));
const legacyLifecycle = new Set(['0.1.5-rc.2','0.1.5-rc.1','0.1.5-alpha.2','0.1.5-alpha.1','0.1.3-alpha.2','0.1.3-alpha.1','0.1.2-rc.1','0.1.2-alpha.5','0.1.2-alpha.4','0.1.2-alpha.3','0.1.2-alpha.2','0.1.2-alpha.1','0.1.1-rc.2','0.1.1-rc.1','0.1.0-rc.8','0.1.0-rc.7']);
let results = [];
try { results = JSON.parse(await readFile(new URL('compatibility/host-results.json', base), 'utf8')).results; } catch { /* First build. */ }
for (const release of matrix.releases) {
  release.features.lifecycle = legacyLifecycle.has(release.version) ? 'agent/session-start' : 'agent/created';
  release.hostTest = results.find(r => r.version === release.version)?.status ?? 'pending';
}
await writeFile(file, JSON.stringify(matrix, null, 2) + '\n');
const pkgFile = new URL('package.json', base);
const pkg = JSON.parse(await readFile(pkgFile, 'utf8'));
// Explicit prerelease versions: ordinary broad SemVer ranges exclude prereleases.
pkg.engines.dsh = matrix.releases.map(r => r.version).join(' || ');
pkg.peerDependencies['@deepseek-ai/cordis'] = [...new Set(cordisVersions.map(r => r.cordisVersion))].join(' || ');
for (const name of ['@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-tools']) {
  pkg.peerDependencies[name] = pkg.engines.dsh;
  (pkg.peerDependenciesMeta ??= {})[name] = { optional: true };
}
await writeFile(pkgFile, JSON.stringify(pkg, null, 2) + '\n');
const rows = matrix.releases.map(r => `| ${r.version} | ${r.adapter} | 已审查 | ${r.hostTest === 'passed' ? '通过' : r.hostTest === 'unavailable' ? '缺少 npm 宿主包' : r.hostTest} | ${r.interventionVerified ? '已验证' : '未开放'} |`);
const passed = results.filter(r => r.status === 'passed');
await writeFile(new URL('compatibility/MATRIX.md', base), `# DSH 兼容性矩阵\n\n截至 ${matrix.checkedAt} 的 ${matrix.releases.length} 个官方 GitHub Release 条目。源码审查不等于运行验证。当前核心测试通过 ${passed.length} 个版本，其中 ${passed.filter(r => r.packaged).length} 个已验证预构建安装包的加载和实际宿主版本识别。\n\n| DSH 版本 | 流适配器 | 接口源码 | 核心宿主测试 | 自动中断/恢复 |\n|---|---|---|---|---|\n${rows.join('\n')}\n\n核心宿主测试使用各发行版实际发布的 Cordis、AgentLoop、Session 和 Tools，并锁定整套 DSH 依赖；模型由确定性测试适配器替代。覆盖正常输出、重复推理、流数据原样转发、工具结果、单会话关闭、软纠正交付及两次追加上限、新用户输入重置预算和卸载。测试明细见 host-results.json。未包含真实 DeepSeek API、桌面端安装或性能效果评估。\n\n0.1.2-alpha.1 和 0.1.3-alpha.1 的对应 npm 宿主包不可获取，仅完成接口源码审查和协议回放，不能宣称运行验证通过。\n\n自动干预还需真实提供方取消、用户停止竞态和恢复预算持久化验证，所有版本均未开放。未知版本按观察接口回退，但安装器可能因明确的版本白名单拒绝安装，需要补测后更新包。未列出的 npm 构建、源码修改版、第三方分支和未来版本不属于此矩阵。\n`);
console.log(`Updated ${matrix.releases.length} compatibility entries`);
