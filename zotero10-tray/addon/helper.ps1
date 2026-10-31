param(
    [Parameter(Mandatory=$true)][int]$ParentId,
    [Parameter(Mandatory=$true)][string]$WindowHandle,
    [Parameter(Mandatory=$true)][string]$SessionDir
)
$ErrorActionPreference = 'Stop'
try {
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    Add-Type -ReferencedAssemblies System.Windows.Forms,System.Drawing -TypeDefinition @'
using System;
using System.IO;
using System.Diagnostics;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace Zotero10Tray {
  internal static class Native {
    [DllImport("user32.dll")] internal static extern bool IsWindow(IntPtr h);
    [DllImport("user32.dll")] internal static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] internal static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] internal static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] internal static extern bool ShowWindowAsync(IntPtr h, int command);
    [DllImport("user32.dll")] internal static extern bool SetForegroundWindow(IntPtr h);
  }
  public sealed class TrayContext : ApplicationContext {
    readonly IntPtr window;
    readonly int parentId;
    readonly string dir;
    readonly Process parent;
    readonly NotifyIcon icon;
    readonly ContextMenuStrip menu;
    readonly System.Windows.Forms.Timer timer;
    Icon ownIcon;
    bool hidden;
    bool disposed;

    public TrayContext(int pid, string handle, string sessionDir) {
      parentId = pid;
      dir = sessionDir;
      long number = handle.StartsWith("0x", StringComparison.OrdinalIgnoreCase)
        ? Convert.ToInt64(handle.Substring(2), 16) : Convert.ToInt64(handle);
      window = new IntPtr(number);
      parent = Process.GetProcessById(pid);
      if (!ValidWindow()) throw new InvalidOperationException("Window does not belong to Zotero process");
      icon = new NotifyIcon();
      try { ownIcon = Icon.ExtractAssociatedIcon(parent.MainModule.FileName); } catch { }
      icon.Icon = ownIcon ?? SystemIcons.Application;
      icon.Text = "Zotero 10 Tray";
      menu = new ContextMenuStrip();
      menu.Items.Add("Show Zotero / 显示", null, delegate { Show(); });
      menu.Items.Add("Hide to Tray / 隐藏", null, delegate { Hide(); });
      menu.Items.Add(new ToolStripSeparator());
      menu.Items.Add("Exit Zotero / 退出", null, delegate {
        Show();
        try { File.WriteAllText(Path.Combine(dir, "quit"), "quit"); } catch { }
      });
      menu.Items.Add("Stop Tray Helper / 停用托盘", null, delegate { ExitThread(); });
      icon.ContextMenuStrip = menu;
      icon.MouseClick += delegate(object sender, MouseEventArgs e) {
        if (e.Button == MouseButtons.Left) Show();
      };
      icon.Visible = true;
      timer = new System.Windows.Forms.Timer();
      timer.Interval = 500;
      timer.Tick += delegate { Tick(); };
      // Publish readiness only after an icon and a usable restore action exist.
      File.WriteAllText(Path.Combine(dir, "ready"), "ready");
      timer.Start();
    }

    bool ValidWindow() {
      uint pid;
      Native.GetWindowThreadProcessId(window, out pid);
      return Native.IsWindow(window) && pid == (uint)parentId;
    }
    void Hide() {
      if (!ValidWindow() || disposed) return;
      Native.ShowWindowAsync(window, 0); // SW_HIDE retains the maximized state
      hidden = true;
    }
    void Show() {
      if (!ValidWindow()) return;
      Native.ShowWindowAsync(window, Native.IsIconic(window) ? 9 : 5); // RESTORE / SHOW
      Native.SetForegroundWindow(window);
      hidden = false;
    }
    bool Take(string name) {
      string path = Path.Combine(dir, name);
      if (!File.Exists(path)) return false;
      File.Delete(path);
      return true;
    }
    void Tick() {
      try {
        if (parent.HasExited || !ValidWindow() || Take("stop")) { ExitThread(); return; }
        // On a suspended/busy Zotero or unloaded plugin, reveal the window and
        // stop. A stale helper must never keep hiding a window without its owner.
        string lease = Path.Combine(dir, "lease");
        if (!File.Exists(lease) || (DateTime.UtcNow - File.GetLastWriteTimeUtc(lease)).TotalSeconds > 15) {
          ExitThread(); return;
        }
        File.WriteAllText(Path.Combine(dir, "ready"), "ready");
        if (Take("hide")) Hide();
      } catch { ExitThread(); }
    }
    protected override void ExitThreadCore() {
      if (!disposed) {
        // Only restore windows hidden by this helper. A normally minimized
        // Zotero window should stay minimized when disabling the plugin.
        if (hidden && ValidWindow()) Show();
        disposed = true;
        timer.Stop();
        timer.Dispose();
        icon.Visible = false;
        icon.Dispose();
        menu.Dispose();
        if (ownIcon != null) ownIcon.Dispose();
        parent.Dispose();
        try { File.Delete(Path.Combine(dir, "ready")); } catch { }
      }
      base.ExitThreadCore();
    }
    public void Stop() { ExitThread(); }
  }
}
'@
    [System.Windows.Forms.Application]::EnableVisualStyles()
    $context = New-Object Zotero10Tray.TrayContext($ParentId, $WindowHandle, $SessionDir)
    try { [System.Windows.Forms.Application]::Run($context) }
    finally { $context.Stop() }
} catch {
    try { [System.IO.File]::WriteAllText((Join-Path $SessionDir 'error.txt'), $_.Exception.ToString()) } catch {}
    exit 1
} finally {
    # Preserve startup errors for diagnosis; successful sessions leave no files.
    if (-not (Test-Path (Join-Path $SessionDir 'error.txt'))) {
        Remove-Item -LiteralPath $SessionDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}
