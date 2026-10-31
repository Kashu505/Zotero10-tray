# Zotero 10 Tray — Windows 测试版 0.1.4

适用目标：Windows 10/11、Zotero 10.0.x。**尚未在真实 Windows + Zotero 10 环境验证，不能保证安装后立即可用。**

## 0.1.2 诊断与启动修正

显式初始化 `Components.classes` 和 `Components.interfaces`，不再假定插件沙箱提供 `Cc`/`Ci` 别名。新增“工具 → Zotero 10 Tray 状态 / 诊断”，即使助手启动失败也能查看失败阶段和错误。尚未确认这是否就是当前用户机器上助手未启动的原因。

## 0.1.1 安装修复

补上 Zotero 安装器强制要求的 `applications.zotero.update_url`，修复 0.1.0 安装清单缺失字段的问题。
此测试版没有托管更新服务；清单使用保留域名 `example.invalid` 占位，须手动安装新版。Zotero 检查更新时可能提示无法连接该地址。托盘助手本身不联网。

## 0.1.3 修复

根据实机错误日志，将助手读取方式从 `Zotero.File.getContentsAsync(jar:file:...)` 改为 `nsIZipReader` 直接解压 XPI 内的 helper.ps1；避免 HTTP 接口解析 jar URI 时触发 `nsIURI.username / NS_ERROR_FAILURE`。脚本自带 UTF-8 BOM，保留 Windows PowerShell 5.1 中文编码兼容。

## 0.1.4 隐藏助手窗口

在 `nsIProcess` 启动助手之前设置 `startHidden = true` 与 `noShell = true`，避免通过 Windows Shell 打开可见终端。保留 `-WindowStyle Hidden`。PowerShell 进程仍负责托盘，但其窗口无需显示。接口依据 Mozilla `xpcom/threads/nsIProcess.idl`；本版仍需 Windows 实机确认窗口隐藏效果。

## 安装

1. 先在 Zotero 的“工具 → 插件”中停用旧的 KeepZotero、Minimize Zotero To Tray 等关闭拦截插件，避免冲突。
2. 在同一页面点击齿轮 →“从文件安装插件”，选择 `zotero10-tray-0.1.4.xpi`。
3. 重启 Zotero。首次启动 Windows PowerShell 助手需要几秒；右下角出现 Zotero 托盘图标后再测试。
4. 点击主窗口的 ×，窗口应隐藏，Zotero 继续运行。托盘图标可能位于 Windows 的“显示隐藏图标”箭头内。

## 使用

- 主窗口 ×、Alt+F4，以及主窗口的 `window.close()`：助手正常时改为隐藏。
- 工具 →“隐藏到托盘 / Hide to Tray”：手动隐藏。
- 左键单击托盘图标：显示 Zotero。
- 右键托盘图标：显示、隐藏、退出 Zotero、停用托盘助手。
- **文件 → 退出**：正常退出 Zotero；托盘菜单退出也走 Zotero 的正常退出流程，不会强杀 Zotero。
- 普通最小化按钮保持原有行为。PDF 独立窗口不由本插件拦截。

本版只实现手动启动后常驻托盘；不含开机启动、启动自动隐藏、全局热键或自动更新。

## 工作方式与恢复

插件使用 Zotero 的 bootstrap 生命周期，绕开旧 `ChromeUtils.import()` / JSM 和 js-ctypes。
托盘由系统自带的 Windows PowerShell 5.1 加载 WinForms/C# 源码创建，无需安装 AutoHotkey、.NET SDK 或额外 EXE。
会运行 `powershell.exe -NoProfile -NonInteractive -STA -WindowStyle Hidden -ExecutionPolicy Bypass -File ...`。
`Bypass` 只作用于这个助手进程，不修改系统执行策略；组织策略、受限语言模式或禁用 PowerShell 的电脑可能无法运行。
托盘助手不联网、不开监听端口，也不读写文献库。助手与插件通过每个会话独立的临时文件目录通信。

窗口句柄来自主窗口自身；助手校验窗口属于当前 Zotero PID，不按窗口标题或第一个 Mozilla 窗口猜测。
只有托盘图标建立并持续报告就绪时，插件才拦截关闭。
助手失效时插件尝试显示主窗口；插件停用时移除事件、恢复 close 方法并停止助手。
插件失去心跳超过 15 秒时助手恢复它隐藏的窗口并退出；Zotero 长时间繁忙也可能触发此保护。
关闭 Zotero、禁用插件、Windows 注销/关机等特殊场景仍须实机检查。

如果没有出现图标，先等几秒，再查看“帮助 → 调试输出记录”或“工具 → 开发者 → 错误控制台”，搜索 `Zotero 10 Tray`。
启动失败的详细信息还会保存在 `%TEMP%\zotero10-tray-*\error.txt`。
正常退出助手会删除其会话临时目录；失败会话保留错误文件以便诊断。
如果助手被人为结束且窗口没有恢复，可从任务栏重新打开 Zotero；若仍不可见，重启 Zotero并停用插件。

## 验证范围

已提供 Node.js 模拟测试：助手就绪/未就绪、心跳过期、关闭拦截、正常退出、停用清理、迟到的异步初始化等。
这些测试验证 JavaScript 生命周期逻辑，不验证 Windows API、PowerShell 运行或 Zotero 真实事件顺序。
本开发环境为 Linux，没有 Windows PowerShell、WinForms 或 Zotero GUI，不能做端到端测试。

本机建议依次检查：安装和托盘出现 → × 隐藏 → 托盘恢复 → 最大化后重复 → 与 Firefox 同时打开时重复 → Alt+F4 → 文件退出 → 托盘退出 → 隐藏时停用插件 → 单独结束助手后恢复。
确认浏览器 Connector 抓取和 Word 插入引用在窗口隐藏时仍能工作。

## 源码和打包

```
node --test tests/lifecycle.test.cjs
python3 build.py
```

`addon/` 直接打包为 XPI 的根目录。无依赖下载、无混淆、无预编译二进制。此插件拥有独立 ID，不会覆盖原插件。

参考：
- https://github.com/B3000Kcn/minimize-zotero-to-tray （参考提交 `19a9577a3f53aef9ec69c645c71897d7b172264b`）
- https://www.zotero.org/support/dev/zotero_7_for_developers
- https://www.zotero.org/support/dev/zotero_8_for_developers
- https://www.zotero.org/support/dev/zotero_10_for_developers

本项目是根据相似功能重新编写的独立原型，不是原作者发布的兼容更新。
