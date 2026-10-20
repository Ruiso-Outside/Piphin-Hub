// Módulos: partes do Piphin que rodam dentro do Hub (Macro, LLM, InfoHardware...).
// Cada módulo é uma pasta em <dados do Hub>\modules\<id> com:
//   module.json   { id, name, version, main?: "backend.js", ui: "web/index.html", minHub?: "1.1.0" }
//   backend       roda em processo separado (lib/module-runner.js)
//   interface     página carregada numa área da janela do Hub, com window.piphin (module-preload.js)
const fs = require("fs");
const path = require("path");
const { EventEmitter } = require("events");
const { utilityProcess, WebContentsView, ipcMain, dialog, Notification, nativeImage } = require("electron");
const U = require("./util");

const SIDEBAR = 216; // largura da barra lateral do Hub (web/style.css)
const TITLEBAR = 40;

class ModuleHost extends EventEmitter {
  constructor({ dir, dataDir, logDir, hubVersion, getWindow }) {
    super();
    this.dir = dir; // ...\modules
    this.dataDir = dataDir; // ...\module-data
    this.logDir = logDir;
    this.hubVersion = hubVersion;
    this.getWindow = getWindow;
    this.mods = new Map(); // id -> { manifest, dir, proc, state, error, view, pending, seq, keepAlive }
    this.visible = null;
    fs.mkdirSync(dir, { recursive: true });

    // chamadas da interface de um módulo: o módulo é identificado pela própria página
    ipcMain.handle("mod:invoke", async (e, ch, args) => {
      const m = this.byContents(e.sender);
      if (!m) return { ok: false, error: "Módulo desconhecido" };
      try { return { ok: true, data: await this.invoke(m, ch, args) }; }
      catch (err) { return { ok: false, error: err.message }; }
    });
    ipcMain.on("mod:info", (e) => {
      const m = this.byContents(e.sender);
      e.returnValue = m ? { id: m.manifest.id, name: m.manifest.name, version: m.manifest.version, hubVersion: this.hubVersion } : null;
    });
  }

  byContents(wc) {
    for (const m of this.mods.values()) if (m.view && m.view.webContents === wc) return m;
    return null;
  }

  readManifest(dir) {
    const mf = U.readJson(path.join(dir, "module.json"), null);
    if (!mf || !mf.id || !mf.version) return null;
    return mf;
  }

  installed() {
    const out = [];
    for (const name of fs.readdirSync(this.dir)) {
      if (name.includes(".hub-")) continue;
      const mf = this.readManifest(path.join(this.dir, name));
      if (mf) out.push(mf);
    }
    return out;
  }

  status() {
    return this.installed().map((mf) => {
      const m = this.mods.get(mf.id);
      return { id: mf.id, name: mf.name, version: mf.version, icon: mf.icon ? "file:///" + path.join(this.dir, mf.id, mf.icon).replace(/\\/g, "/") : null,
        accent: mf.accent, state: m ? m.state : "stopped", error: m ? m.error : null, keepAlive: !!(m && m.keepAlive && m.proc) };
    });
  }

  // ---------------------------------------------------------------- ciclo de vida
  startAll() {
    for (const mf of this.installed()) this.start(mf.id).catch(() => {});
  }

  start(id) {
    const existing = this.mods.get(id);
    if (existing && existing.proc) return existing.ready;
    const dir = path.join(this.dir, id);
    const manifest = this.readManifest(dir);
    if (!manifest) return Promise.reject(new Error("Módulo não instalado: " + id));
    if (manifest.minHub && U.cmpVersion(this.hubVersion, manifest.minHub) < 0)
      return Promise.reject(new Error(`${manifest.name} precisa do Piphin Hub ${manifest.minHub} ou mais novo`));

    const m = existing || { pending: new Map(), seq: 0, view: null, keepAlive: false };
    Object.assign(m, { manifest, dir, state: "starting", error: null });
    this.mods.set(id, m);

    const dataDir = path.join(this.dataDir, id);
    fs.mkdirSync(dataDir, { recursive: true });
    m.ready = new Promise((resolve, reject) => {
      if (!manifest.main) { m.state = "running"; return resolve(); }
      const proc = utilityProcess.fork(path.join(__dirname, "module-runner.js"), [], {
        serviceName: "Piphin " + manifest.name,
        stdio: "ignore",
        env: { ...process.env, PIPHIN_MODULE_DIR: dir, PIPHIN_MODULE_DATA: dataDir, PIPHIN_LOG_DIR: this.logDir },
      });
      m.proc = proc;
      proc.on("message", (msg) => this.onMessage(m, msg, resolve, reject));
      proc.on("exit", (code) => {
        m.proc = null;
        for (const p of m.pending.values()) p.reject(new Error(`${manifest.name} parou`));
        m.pending.clear();
        if (m.keepAlive) { m.keepAlive = false; this.emit("keepAlive"); }
        if (m.state !== "stopping") { m.state = "crashed"; m.error = `O módulo parou (código ${code})`; reject(new Error(m.error)); }
        else m.state = "stopped";
        this.emit("changed");
      });
    });
    m.ready.then(() => this.emit("changed"), () => this.emit("changed"));
    this.emit("changed");
    return m.ready;
  }

  onMessage(m, msg, resolve, reject) {
    if (msg.t === "ready") { m.state = "running"; resolve(); }
    else if (msg.t === "failed") { m.state = "crashed"; m.error = msg.error; reject(new Error(msg.error)); }
    else if (msg.t === "res") {
      const p = m.pending.get(msg.id);
      if (!p) return;
      m.pending.delete(msg.id);
      msg.ok ? p.resolve(msg.data) : p.reject(new Error(msg.error));
    } else if (msg.t === "emit") {
      if (m.view && !m.view.webContents.isDestroyed()) m.view.webContents.send("mod:event", msg.ch, msg.data);
    } else if (msg.t === "call") {
      this.hostCall(m, msg.fn, msg.args || []).then(
        (data) => m.proc && m.proc.postMessage({ t: "ret", id: msg.id, ok: true, data }),
        (e) => m.proc && m.proc.postMessage({ t: "ret", id: msg.id, ok: false, error: e.message }));
    }
  }

  async hostCall(m, fn, args) {
    const win = this.getWindow();
    switch (fn) {
      case "saveDialog": { const r = await dialog.showSaveDialog(win, args[0] || {}); return r.canceled ? null : r.filePath; }
      case "openDialog": { const r = await dialog.showOpenDialog(win, args[0] || {}); return r.canceled ? null : r.filePaths; }
      case "notify":
        if (Notification.isSupported()) {
          const icon = m.manifest.icon ? nativeImage.createFromPath(path.join(m.dir, m.manifest.icon)) : undefined;
          const n = new Notification({ title: args[0] || m.manifest.name, body: args[1] || "", icon });
          n.on("click", () => this.emit("focus", m.manifest.id));
          n.show();
        }
        return true;
      case "focus": this.emit("focus", m.manifest.id); return true;
      case "windowBounds": return win ? win.getBounds() : null;
      case "keepAlive": m.keepAlive = !!args[0]; m.keepAliveReason = args[1]; this.emit("keepAlive"); return true;
    }
    throw new Error("Função desconhecida: " + fn);
  }

  keepAliveReasons() {
    return [...this.mods.values()].filter((m) => m.keepAlive && m.proc).map((m) => m.keepAliveReason || m.manifest.name);
  }

  async invoke(m, ch, args) {
    if (m.state === "starting") await m.ready;
    if (!m.proc) throw new Error(`${m.manifest.name} não está rodando`);
    const id = ++m.seq;
    return new Promise((resolve, reject) => {
      m.pending.set(id, { resolve, reject });
      m.proc.postMessage({ t: "invoke", id, ch, args: args || [] });
    });
  }

  async stop(id) {
    const m = this.mods.get(id);
    if (!m) return;
    if (this.visible === id) this.hide();
    if (m.view) { this.getWindow()?.contentView.removeChildView(m.view); m.view.webContents.close(); m.view = null; }
    if (m.proc) {
      m.state = "stopping";
      const proc = m.proc;
      const exited = new Promise((r) => proc.once("exit", r));
      proc.postMessage({ t: "stop" });
      const t = setTimeout(() => proc.kill(), 4000); // não respondeu: encerra à força
      await exited;
      clearTimeout(t);
    }
    this.mods.delete(id);
    this.emit("changed");
  }

  async stopAll() {
    await Promise.all([...this.mods.keys()].map((id) => this.stop(id).catch(() => {})));
  }

  async restart(id) {
    await this.stop(id);
    return this.start(id);
  }

  // ---------------------------------------------------------------- interface
  async show(id) {
    const win = this.getWindow();
    if (!win) return;
    let m = this.mods.get(id);
    if (!m || (!m.proc && m.manifest.main)) { await this.start(id); m = this.mods.get(id); }
    if (!m.view) {
      m.view = new WebContentsView({
        webPreferences: { preload: path.join(__dirname, "..", "module-preload.js"), contextIsolation: true, sandbox: true },
      });
      m.view.setBackgroundColor("#0b0a12");
      const wc = m.view.webContents;
      wc.setWindowOpenHandler(({ url }) => { if (/^https:\/\//.test(url)) require("electron").shell.openExternal(url); return { action: "deny" }; });
      wc.on("will-navigate", (e, url) => { if (!url.startsWith("file:")) e.preventDefault(); });
      wc.on("render-process-gone", () => { m.view = null; if (this.visible === id) this.visible = null; this.emit("changed"); });
      wc.loadFile(path.join(m.dir, m.manifest.ui || "web/index.html"));
    }
    for (const [oid, o] of this.mods) if (oid !== id && o.view) o.view.setVisible(false);
    if (!win.contentView.children.includes(m.view)) win.contentView.addChildView(m.view);
    m.view.setVisible(true);
    this.visible = id;
    this.layout();
    m.view.webContents.focus();
  }

  hide() {
    for (const m of this.mods.values()) if (m.view) m.view.setVisible(false);
    this.visible = null;
  }

  layout() {
    const win = this.getWindow();
    const m = this.visible && this.mods.get(this.visible);
    if (!win || !m || !m.view) return;
    const [w, h] = win.getContentSize();
    m.view.setBounds({ x: SIDEBAR, y: TITLEBAR, width: Math.max(0, w - SIDEBAR), height: Math.max(0, h - TITLEBAR) });
  }

  reloadView(id) {
    const m = this.mods.get(id);
    if (m && m.view) m.view.webContents.reload();
  }
}

module.exports = { ModuleHost };
