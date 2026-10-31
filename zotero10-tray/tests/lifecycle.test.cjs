const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../addon/bootstrap.js'), 'utf8');

function setup() {
  const files = new Map(), events = new Map(), errors = [], timers = [];
  let originalCloses = 0, quitCalls = 0, visible = true;
  const base = { nativeHandle: '0x123456', get visibility() { return visible; }, set visibility(v) { visible = v; } };
  const originalClose = function() { originalCloses++; };
  const win = {
    closed: false, close: originalClose,
    minimize() {}, restore() {}, focus() {},
    docShell: { treeOwner: { QueryInterface() { return { getInterface() { return base; } }; } } },
    addEventListener(n, f) { events.set(n, f); },
    removeEventListener(n, f) { if (events.get(n) === f) events.delete(n); },
    document: { getElementById() { return null; } }
  };
  const file = p => ({ path: p, clone() { return file(this.path); }, append(s) { this.path += '/' + s; }, create() {} });
  const proc = { isRunning: true, init() {}, runwAsync(args, len, observer) {
    assert.equal(this.startHidden, true, 'Process must be hidden before launch');
    assert.equal(this.noShell, true, 'Process must bypass the Windows shell');
    this.args = args; this.observer = observer;
  } };
  const observers = new Map();
  const zip = { closed: false, open() {}, hasEntry() { return true; },
    extract(name, target) { files.set(target.path, { value: '\uFEFFhelper-source', time: Date.now() }); },
    close() { this.closed = true; } };
  const context = vm.createContext({
    console, Error, Date, Map,
    Services: {
      appinfo: { OS: 'WINNT', processID: 1234 }, uuid: { generateUUID() { return '{unique}'; } },
      dirsvc: { get(key) { return file(key === 'TmpD' ? '/tmp' : '/Windows'); } },
      obs: { addObserver(o, topic) { observers.set(topic, o); }, removeObserver(o, topic) { observers.delete(topic); } },
      startup: { quit() { quitCalls++; } }
      ,io: { newURI() { return { scheme: 'jar', QueryInterface() {
        return { JARFile: { QueryInterface() { return { file: file('/addon.xpi') }; } } };
      } }; } }
    },
    Ci: { nsIFile: { DIRECTORY_TYPE: 1 }, nsITimer: { TYPE_REPEATING_SLACK: 1 }, nsIAppStartup: { eAttemptQuit: 1 } },
    Cc: new Proxy({}, { get(_, name) { return { createInstance() {
      if (name.includes('process')) return proc;
      if (name.includes('zip-reader')) return zip;
      const timer = { cancelled: false, initWithCallback(cb) { this.cb = cb; }, cancel() { this.cancelled = true; } };
      timers.push(timer); return timer;
    } }; } }),
    IOUtils: {
      async writeUTF8(p, value) { files.set(p, { value, time: Date.now() }); },
      async exists(p) { return files.has(p); },
      async stat(p) { return { lastModified: files.get(p).time }; },
      async remove(p) { files.delete(p); }
    },
    Zotero: { logError(e) { errors.push(e); }, getMainWindows() { return [win]; },
      File: { async getContentsAsync() { throw new Error('Regression: jar:file must not use Zotero.HTTP'); } } }
  });
  context.Components = { classes: context.Cc, interfaces: context.Ci };
  delete context.Cc;
  delete context.Ci;
  vm.runInContext(source, context);
  return { context, win, base, proc, files, events, errors, timers, observers, originalClose, zip,
    get closes() { return originalCloses; }, get quits() { return quitCalls; },
    async start() { await context.startup({ rootURI: 'jar:file:///addon.xpi!/' }); return context.Tray10.sessions.get(win); },
    async ready(state) { files.set(state.path('ready'), { value: 'ready', time: Date.now() }); await context.Tray10.poll(state); },
    closeEvent() { const ev = { cancelled: false, stopped: false, preventDefault() { this.cancelled = true; }, stopImmediatePropagation() { this.stopped = true; } }; events.get('close')?.(ev); return ev; }
  };
}

test('helper receives exact PID/handle and separate arguments, BOM script', async () => {
  const h = setup(); const s = await h.start();
  assert.ok(h.proc.args.includes('0x123456'));
  assert.ok(h.proc.args.includes('1234'));
  assert.equal(h.files.get(s.path('helper.ps1')).value[0], '\uFEFF');
  assert.equal(h.zip.closed, true);
  assert.equal(h.closeEvent().cancelled, false);
  h.win.close(); assert.equal(h.closes, 1);
});
test('healthy helper intercepts native and programmatic close', async () => {
  const h = setup(); const s = await h.start(); await h.ready(s);
  assert.equal(h.closeEvent().cancelled, true);
  h.win.close(); await Promise.resolve();
  assert.equal(h.closes, 0);
  assert.ok(h.files.has(s.path('hide')));
});

test('missing helper entry closes XPI reader and never launches PowerShell', async () => {
  const h = setup(); h.zip.hasEntry = () => false;
  await h.start();
  assert.equal(h.zip.closed, true);
  assert.equal(h.proc.args, undefined);
  assert.equal(h.win.close, h.originalClose);
  assert.ok(h.errors.some(e => /helper.ps1 is missing/.test(String(e))));
});

test('XPI extraction failure closes reader and preserves native close', async () => {
  const h = setup(); h.zip.extract = () => { throw new Error('Extraction denied'); };
  await h.start();
  assert.equal(h.zip.closed, true);
  assert.equal(h.proc.args, undefined);
  assert.equal(h.win.close, h.originalClose);
});
test('stale heartbeat never cancels close and reveals hidden main window', async () => {
  const h = setup(); const s = await h.start(); await h.ready(s);
  h.base.visibility = false;
  h.files.get(s.path('ready')).time -= 10000;
  await h.context.Tray10.poll(s);
  assert.equal(h.closeEvent().cancelled, false);
  assert.equal(h.base.visibility, true);
});
test('confirmed application quit bypasses both close hooks', async () => {
  const h = setup(); const s = await h.start(); await h.ready(s);
  h.observers.get('quit-application-granted').observe();
  assert.equal(h.closeEvent().cancelled, false);
  h.win.close(); assert.equal(h.closes, 1);
});
test('tray quit uses normal application quit, does not poison future close if cancelled', async () => {
  const h = setup(); const s = await h.start(); await h.ready(s);
  h.files.set(s.path('quit'), {}); await h.context.Tray10.poll(s);
  assert.equal(h.quits, 1);
  assert.equal(h.context.Tray10.quitting, false);
  assert.equal(h.closeEvent().cancelled, true);
});
test('disable restores window, original close and observers, signals cooperative stop', async () => {
  const h = setup(); const s = await h.start(); await h.ready(s);
  h.base.visibility = false;
  await h.context.shutdown();
  assert.equal(h.base.visibility, true);
  assert.equal(h.win.close, h.originalClose);
  assert.equal(h.events.size, 0);
  assert.equal(h.observers.size, 0);
  assert.equal(h.timers[0].cancelled, true);
  assert.ok(h.files.has(s.path('stop')));
});
test('unexpected helper termination reveals window and stops polling', async () => {
  const h = setup(); const s = await h.start(); await h.ready(s);
  h.base.visibility = false; h.proc.isRunning = false; h.proc.observer.observe();
  assert.equal(h.base.visibility, true);
  assert.equal(h.closeEvent().cancelled, false);
  assert.equal(h.timers[0].cancelled, true);
});
test('disable while script is loading never launches helper or leaves close override', async () => {
  const h = setup(); let release;
  h.context.Tray10.extractHelper = () => new Promise(r => { release = r; });
  const starting = h.context.startup({ rootURI: 'test:' });
  await h.context.shutdown(); release('script'); await starting;
  assert.equal(h.proc.args, undefined);
  assert.equal(h.win.close, h.originalClose);
  assert.equal(h.context.Tray10.sessions.size, 0);
});
test('failed handle acquisition leaves Zotero close behavior intact', async () => {
  const h = setup(); h.base.nativeHandle = 'unavailable'; await h.start();
  assert.equal(h.context.Tray10.sessions.size, 0);
  assert.equal(h.win.close, h.originalClose);
  assert.equal(h.proc.args, undefined);
  assert.ok(h.errors.length);
});
test('detach does not overwrite a later plugin close wrapper', async () => {
  const h = setup(); await h.start();
  const otherWrapper = () => {};
  h.win.close = otherWrapper; await h.context.shutdown();
  assert.equal(h.win.close, otherWrapper);
});

test('diagnostics menu survives initialization failure and reports the actual error', async () => {
  const h = setup(); const items = [];
  const menu = { appendChild(item) { items.push(item); } };
  h.win.document.getElementById = () => menu;
  h.win.document.createXULElement = () => ({
    setAttribute() {}, addEventListener(name, callback) { this.callback = callback; },
    remove() { this.removed = true; }
  });
  let report;
  h.context.Services.prompt = { alert(win, title, text) { report = text; } };
  h.base.nativeHandle = 'unavailable';
  await h.start();
  assert.equal(items.length, 1);
  assert.equal(items[0].removed, undefined);
  await items[0].callback();
  assert.match(report, /Cannot obtain a valid native window handle/);
  await h.context.shutdown();
  assert.equal(items[0].removed, true);
});
