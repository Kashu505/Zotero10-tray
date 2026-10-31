/* Windows-only Zotero 10 prototype. No legacy JSM imports or TCP listener. */
// A system-principal Sandbox exposes Components, but shorthand aliases must
// not be assumed to exist in a plugin bootstrap scope.
var Cc = Components.classes;
var Ci = Components.interfaces;
var Tray10 = {
  sessions: new Map(),
  diagnostics: new Map(),
  active: false,
  quitting: false,
  log(error) { Zotero.logError(new Error("Zotero 10 Tray: " + String(error))); },

  addDiagnostic(win, state) {
    const menu = win.document.getElementById("menu_ToolsPopup");
    if (!menu || this.diagnostics.has(win)) return;
    const item = win.document.createXULElement("menuitem");
    item.id = "zotero10-tray-status";
    item.setAttribute("label", "Zotero 10 Tray 状态 / 诊断");
    item.addEventListener("command", async () => {
      let report = "Zotero 10 Tray 0.1.4\n";
      report += "状态：" + (this.healthy(state) ? "托盘助手已就绪" : "托盘助手未就绪") + "\n";
      report += "初始化阶段：" + (state.stage || "尚未开始") + "\n";
      if (state.error) report += "错误：" + state.error + "\n";
      if (state.dir) {
        report += "诊断目录：" + state.dir.path + "\n";
        try {
          if (await IOUtils.exists(state.path("error.txt"))) {
            report += "助手错误：\n" + await IOUtils.readUTF8(state.path("error.txt"));
          }
        } catch (e) { report += "读取助手错误失败：" + e; }
      }
      Services.prompt.alert(win, "Zotero 10 Tray 诊断", report);
    });
    menu.appendChild(item);
    this.diagnostics.set(win, item);
  },

  async start({ rootURI }) {
    if (Services.appinfo.OS !== "WINNT") {
      this.log("Zotero 10 Tray supports Windows only.");
      return;
    }
    this.rootURI = rootURI;
    this.active = true;
    this.quitting = false;
    this.observer = { observe: () => { this.quitting = true; } };
    Services.obs.addObserver(this.observer, "quit-application-granted");
    for (const win of Zotero.getMainWindows()) await this.attach(win);
  },

  async extractHelper(state) {
    // Zotero.File.getContentsAsync routes jar:file: through Zotero.HTTP,
    // whose URI credential parser cannot handle nsIJARURI. Read the XPI
    // directly instead. The packaged PS1 already includes its UTF-8 BOM.
    const root = Services.io.newURI(this.rootURI);
    if (root.scheme === "jar") {
      const archive = root.QueryInterface(Ci.nsIJARURI).JARFile.QueryInterface(Ci.nsIFileURL).file;
      const reader = Cc["@mozilla.org/libjar/zip-reader;1"].createInstance(Ci.nsIZipReader);
      try {
        reader.open(archive);
        if (!reader.hasEntry("helper.ps1")) throw new Error("helper.ps1 is missing from XPI");
        const target = state.dir.clone();
        target.append("helper.ps1");
        reader.extract("helper.ps1", target);
      } finally { reader.close(); }
    } else if (root.scheme === "file") {
      const source = Services.io.newURI(this.rootURI + "helper.ps1").QueryInterface(Ci.nsIFileURL).file;
      source.copyTo(state.dir, "helper.ps1");
    } else {
      throw new Error("Unsupported plugin resource scheme: " + root.scheme);
    }
  },

  async attach(win) {
    if (!this.active || this.sessions.has(win)) return;
    const state = { win, alive: true, ready: false, busy: false, process: null, timer: null };
    this.sessions.set(win, state);
    this.addDiagnostic(win, state);
    try {
      state.stage = "获取主窗口句柄";
      const base = win.docShell.treeOwner.QueryInterface(Ci.nsIInterfaceRequestor)
        .getInterface(Ci.nsIBaseWindow);
      const handle = String(base.nativeHandle);
      if (!/^(0x[0-9a-f]+|[0-9]+)$/i.test(handle) || /^0(x0+)?$/.test(handle)) {
        throw new Error("Cannot obtain a valid native window handle: " + handle);
      }
      state.base = base;
      state.stage = "创建助手目录";
      const dir = Services.dirsvc.get("TmpD", Ci.nsIFile).clone();
      dir.append("zotero10-tray-" + Services.uuid.generateUUID().toString().replace(/[{}]/g, ""));
      dir.create(Ci.nsIFile.DIRECTORY_TYPE, 0o700);
      state.dir = dir;
      state.path = name => { const f = dir.clone(); f.append(name); return f.path; };
      state.stage = "读取助手脚本";
      await this.extractHelper(state);
      await IOUtils.writeUTF8(state.path("lease"), "active");
      if (!state.alive || !this.active) return;
      state.stage = "启动 Windows PowerShell";
      const exe = Services.dirsvc.get("WinD", Ci.nsIFile).clone();
      for (const part of ["System32", "WindowsPowerShell", "v1.0", "powershell.exe"]) exe.append(part);
      const proc = Cc["@mozilla.org/process/util;1"].createInstance(Ci.nsIProcess);
      proc.init(exe);
      // Hide at process creation, rather than relying only on PowerShell's
      // -WindowStyle argument after a console has already been allocated.
      proc.startHidden = true;
      proc.noShell = true;
      const args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-STA", "-WindowStyle", "Hidden",
        "-ExecutionPolicy", "Bypass", "-File", state.path("helper.ps1"),
        "-ParentId", String(Services.appinfo.processID), "-WindowHandle", handle, "-SessionDir", dir.path];
      proc.runwAsync(args, args.length, { observe: () => {
        state.ready = false;
        state.error = "PowerShell 助手已退出；如有 error.txt，详情见下方。";
        state.timer?.cancel();
        // Also recover if the helper was terminated without running its finally block.
        this.restore(state);
        if (state.alive) this.log("Zotero 10 Tray helper stopped. Close-to-tray is disabled for this window.");
      } });
      state.process = proc;
      state.stage = "等待助手创建托盘图标";
      state.onClose = event => {
        if (this.quitting || !this.healthy(state)) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        this.send(state, "hide");
      };
      state.originalClose = win.close;
      state.wrappedClose = function(...args) {
        if (!Tray10.quitting && Tray10.healthy(state)) Tray10.send(state, "hide");
        else return state.originalClose.apply(this, args);
      };
      win.close = state.wrappedClose;
      // No quit observer cancels application shutdown. File > Exit remains usable.
      win.addEventListener("close", state.onClose, true);
      const menu = win.document.getElementById("menu_ToolsPopup");
      if (menu) {
        const item = win.document.createXULElement("menuitem");
        item.id = "zotero10-tray-hide";
        item.setAttribute("label", "隐藏到托盘 / Hide to Tray");
        item.addEventListener("command", () => {
          if (this.healthy(state)) this.send(state, "hide");
          else Services.prompt.alert(win, "Zotero 10 Tray", "托盘助手尚未就绪或已经停止。窗口保持可见。\n请在帮助 → 调试输出记录中查看错误。");
        });
        menu.appendChild(item);
        state.menu = item;
      }
      const timer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
      state.timer = timer;
      timer.initWithCallback({ notify: () => { this.poll(state).catch(e => this.log(e)); } },
        500, Ci.nsITimer.TYPE_REPEATING_SLACK);
    } catch (e) {
      state.error = String(e) + (e.stack ? "\n" + e.stack : "");
      this.log(e);
      await this.detach(win);
    }
  },

  healthy(state) {
    return state.alive && state.ready && state.process?.isRunning && Date.now() - state.lastSeen < 4000;
  },
  send(state, command) {
    // Separate files prevent a hide request from overwriting a stop request.
    if (command === "hide") state.mayBeHidden = true;
    IOUtils.writeUTF8(state.path(command), command).catch(e => { this.restore(state); this.log(e); });
  },
  restore(state) {
    if (this.quitting || state.win.closed) return;
    try {
      const hidden = state.mayBeHidden || (state.base && !state.base.visibility);
      if (state.base) state.base.visibility = true;
      // An external Win32 SW_HIDE can bypass Gecko's visibility bookkeeping.
      // A minimize/restore cycle forces a native show even if Gecko cached true.
      if (hidden) {
        state.win.minimize();
        state.win.restore();
        state.win.focus();
      }
      state.mayBeHidden = false;
    } catch (e) { this.log(e); }
  },
  async poll(state) {
    if (!state.alive || state.busy) return;
    state.busy = true;
    try {
      if (!state.process?.isRunning) { state.ready = false; state.timer?.cancel(); this.restore(state); return; }
      await IOUtils.writeUTF8(state.path("lease"), "active");
      if (!state.alive) return;
      if (await IOUtils.exists(state.path("ready"))) {
        const stat = await IOUtils.stat(state.path("ready"));
        state.lastSeen = stat.lastModified;
        state.ready = Date.now() - state.lastSeen < 4000;
        if (state.ready) state.stage = "托盘已就绪，关闭拦截已启用";
      }
      if (!this.healthy(state)) this.restore(state);
      if (await IOUtils.exists(state.path("quit"))) {
        await IOUtils.remove(state.path("quit"));
        if (state.alive) Services.startup.quit(Ci.nsIAppStartup.eAttemptQuit);
      }
    } finally { state.busy = false; }
  },
  async detach(win) {
    const state = this.sessions.get(win);
    if (!state) return;
    state.alive = false;
    state.ready = false;
    state.timer?.cancel();
    if (state.onClose) win.removeEventListener("close", state.onClose, true);
    if (win.close === state.wrappedClose) win.close = state.originalClose;
    state.menu?.remove();
    this.restore(state);
    if (state.dir) {
      try { await IOUtils.writeUTF8(state.path("stop"), "stop"); } catch (e) { this.log(e); }
    }
    // Let the helper restore the window and dispose its tray icon itself.
    // Its lease timeout also handles an interrupted asynchronous shutdown.
    this.sessions.delete(win);
  },
  async stop() {
    this.active = false;
    if (this.observer) Services.obs.removeObserver(this.observer, "quit-application-granted");
    this.observer = null;
    for (const win of [...this.sessions.keys()]) await this.detach(win);
    for (const item of this.diagnostics.values()) item.remove();
    this.diagnostics.clear();
  }
};
function install() {}
function uninstall() {}
async function startup(data) { await Tray10.start(data); }
async function shutdown() { await Tray10.stop(); }
async function onMainWindowLoad({ window }) { await Tray10.attach(window); }
async function onMainWindowUnload({ window }) {
  await Tray10.detach(window);
  Tray10.diagnostics.get(window)?.remove();
  Tray10.diagnostics.delete(window);
}
