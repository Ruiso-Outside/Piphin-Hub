// Módulos: partes do Piphin que rodam dentro do Hub (Macro, LLM, InfoHardware...).
// Cada módulo é uma pasta em <dados do Hub>\modules\<id> com:
//   module.json   { id, name, version, main?: "backend.js", ui: "web/index.html", minHub?: "1.1.0",
//                   allowOrigins?: ["http://127.0.0.1:8765"],     (endereços locais que as páginas podem abrir)
//                   reservedKeys?: ["ctrl+1"] }                   (atalhos do Hub que ficam com o módulo quando ele está na tela)
//   backend       roda em processo separado (lib/module-runner.js)
//   interface     página carregada numa área da janela do Hub, com window.piphin (module-preload.js)
// Além disso o Hub oferece ao módulo o que só o Electron faz: atalhos globais, janelas extras
// (ex.: pergunta rápida), captura de tela, área de transferência e iniciar com o Windows.
const fs = require("fs");
const path = require("path");
const { EventEmitter } = require("events");
const { utilityProcess, WebContentsView, BrowserWindow, ipcMain, dialog, Notification, nativeImage, globalShortcut,
  screen, desktopCapturer, clipboard, shell, session, webContents } = require("electron");
const U = require("./util");
const { kindOf } = require("./library");
const i18n = require("./i18n");

const TITLEBAR = 44; // altura da barra de título do Hub (web/style.css)
// opções de janela que um módulo pode pedir
const WINDOW_OPTS = ["width", "height", "minWidth", "minHeight", "frame", "transparent", "resizable", "alwaysOnTop", "skipTaskbar",
  "fullscreenable", "maximizable", "minimizable", "hasShadow", "title", "backgroundColor", "focusable", "x", "y"];
// permissão no module.json ("permissions": ["screenCapture"]) para gravar a tela (getDisplayMedia) e listar janelas
const CAN_CAPTURE = (m) => Array.isArray(m.manifest.permissions) && m.manifest.permissions.includes("screenCapture");
// tipos de arquivo que um módulo sabe abrir ("opens": ["image", "video", "audio"] no module.json): "Abrir no ..."
const OPENS = (mf) => (Array.isArray(mf && mf.opens) ? mf.opens.filter((k) => ["audio", "video", "image"].includes(k)) : []);

class ModuleHost extends EventEmitter {
  constructor({ dir, dataDir, logDir, hubVersion, getWindow }) {
    super();
    this.dir = dir; // ...\modules
    this.dataDir = dataDir; // ...\module-data
    this.logDir = logDir;
    this.hubVersion = hubVersion;
    this.getWindow = getWindow;
    this.mods = new Map(); // id -> { manifest, dir, proc, state, error, view, windows, hotkeys, pending, seq, keepAlive }
    this.visible = null;
    this.startWithWindows = false; // definido pelo Hub (configuração dele)
    this.insetLeft = 248; // largura da barra lateral do Hub (muda ao recolher)
    this.covered = false; // paleta de comandos aberta por cima: esconde a tela do módulo
    this.library = null; // mídia compartilhada (lib/library.js), definida pelo Hub
    this.picker = null; // (módulo, opções) => itens escolhidos na janela "Escolher da mídia" do Hub
    this.lang = "pt"; // idioma (lib/i18n.js); cada módulo traz o próprio dicionário
    fs.mkdirSync(dir, { recursive: true });

    // chamadas das páginas de um módulo: o módulo é identificado pela própria página
    ipcMain.handle("mod:invoke", async (e, ch, args) => {
      const m = this.byContents(e.sender);
      if (!m) return { ok: false, error: "Módulo desconhecido" };
      try { return { ok: true, data: await this.invoke(m, ch, args) }; }
      catch (err) { return { ok: false, error: err.message }; }
    });
    // gravação de tela pelas páginas dos módulos (getDisplayMedia): só módulos com a permissão "screenCapture";
    // a fonte (monitor ou janela) e o som do PC são escolhidos antes pelo motor do módulo (setCaptureSource)
    session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
      try {
        const wc = request.frame ? webContents.fromFrame(request.frame) : null;
        const m = wc ? this.byContents(wc) : null;
        if (!m || !CAN_CAPTURE(m)) return callback({});
        const want = m.captureSource || {};
        const sources = await desktopCapturer.getSources({ types: ["screen", "window"], thumbnailSize: { width: 0, height: 0 } });
        const primary = String(screen.getPrimaryDisplay().id);
        const src = sources.find((s) => s.id === want.id) || sources.find((s) => s.display_id === primary) || sources.find((s) => s.id.startsWith("screen:"));
        if (!src) return callback({});
        callback({ video: src, ...(request.audioRequested && want.audio ? { audio: "loopback" } : {}) });
      } catch { callback({}); }
    }, { useSystemPicker: false });
    ipcMain.on("mod:info", (e) => {
      const m = this.byContents(e.sender);
      e.returnValue = m ? { id: m.manifest.id, name: m.manifest.name, version: m.manifest.version, hubVersion: this.hubVersion,
        window: this.windowName(m, e.sender), lang: this.lang, locale: i18n.LANGS[this.lang].locale } : null;
    });
    // tradução da tela do módulo (module-preload.js executa o script). "i18n": "self" no module.json: o módulo traduz sozinho
    ipcMain.on("mod:i18n", (e) => {
      const m = this.byContents(e.sender);
      e.returnValue = m && m.manifest.i18n !== "self" ? i18n.domScript(this.dictOf(m), this.lang, m.manifest.i18nSkip) : null;
    });
  }

  // dicionário do módulo no idioma atual (lido uma vez)
  dictOf(m) {
    if (!m.dict || m.dictLang !== this.lang) { m.dict = i18n.loadDict(m.dir, this.lang); m.dictLang = this.lang; m.tr = i18n.createTranslator(m.dict); }
    return m.dict;
  }
  trOf(m) { this.dictOf(m); return m.tr; }

  // troca o idioma: as telas dos módulos recarregam e os motores recebem o evento "language"
  setLanguage(lang) {
    if (lang === this.lang) return;
    this.lang = lang;
    for (const m of this.mods.values()) {
      if (m.view && !m.view.webContents.isDestroyed()) m.view.webContents.reload();
      for (const w of m.windows.values()) if (!w.isDestroyed()) w.webContents.reload();
      this.hostEvent(m, "language", lang);
    }
  }

  byContents(wc) {
    for (const m of this.mods.values()) {
      if (m.view && m.view.webContents === wc) return m;
      for (const w of m.windows.values()) if (!w.isDestroyed() && w.webContents === wc) return m;
    }
    return null;
  }

  windowName(m, wc) {
    for (const [name, w] of m.windows) if (!w.isDestroyed() && w.webContents === wc) return name;
    return "main";
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

  // endereço que as páginas do módulo podem abrir: arquivos do próprio módulo ou origens declaradas
  allowed(m, url) {
    if (url.startsWith("file:")) {
      try { return decodeURIComponent(new URL(url).pathname).replace(/^\//, "").replace(/\//g, "\\").toLowerCase().startsWith(m.dir.toLowerCase()); }
      catch { return false; }
    }
    return (m.manifest.allowOrigins || []).some((o) => url === o || url.startsWith(o + "/"));
  }

  guard(m, wc) {
    wc.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//.test(url) && !this.allowed(m, url)) shell.openExternal(url);
      return { action: "deny" };
    });
    wc.on("will-navigate", (e, url) => {
      if (this.allowed(m, url)) return;
      e.preventDefault();
      if (/^https?:\/\//.test(url)) shell.openExternal(url);
    });
  }

  load(m, wc, target) {
    if (/^https?:\/\//.test(target)) {
      if (!this.allowed(m, target)) throw new Error("Endereço não permitido para o módulo: " + target);
      return wc.loadURL(target);
    }
    return wc.loadFile(path.join(m.dir, target));
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

    const m = existing || { pending: new Map(), seq: 0, view: null, windows: new Map(), hotkeys: new Set(), keepAlive: false };
    Object.assign(m, { manifest, dir, state: "starting", error: null });
    this.mods.set(id, m);

    const dataDir = path.join(this.dataDir, id);
    fs.mkdirSync(dataDir, { recursive: true });
    m.ready = new Promise((resolve, reject) => {
      if (!manifest.main) { m.state = "running"; return resolve(); }
      const proc = utilityProcess.fork(path.join(__dirname, "module-runner.js"), [], {
        serviceName: "Piphin " + manifest.name,
        stdio: "ignore",
        env: { ...process.env, PIPHIN_MODULE_DIR: dir, PIPHIN_MODULE_DATA: dataDir, PIPHIN_LOG_DIR: this.logDir, PIPHIN_LANG: this.lang,
          // ferramentas dos módulos para a IA (lib/tools-server.js): o Piphin LLM se conecta neste endereço
          ...(this.toolsUrl ? { PIPHIN_TOOLS_URL: this.toolsUrl } : {}) },
      });
      m.proc = proc;
      proc.on("message", (msg) => this.onMessage(m, msg, resolve, reject));
      proc.on("exit", (code) => {
        m.proc = null;
        for (const p of m.pending.values()) p.reject(new Error(`${manifest.name} parou`));
        m.pending.clear();
        this.releaseNative(m);
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
      Promise.resolve().then(() => this.hostCall(m, msg.fn, msg.args || [])).then(
        (data) => m.proc && m.proc.postMessage({ t: "ret", id: msg.id, ok: true, data }),
        (e) => m.proc && m.proc.postMessage({ t: "ret", id: msg.id, ok: false, error: e.message }));
    }
  }

  hostEvent(m, name, data) {
    if (m.proc) m.proc.postMessage({ t: "hostEvent", name, data });
  }

  async hostCall(m, fn, args) {
    const win = this.getWindow();
    const T = this.trOf(m);
    const dlg = (o = {}) => ({ ...o, title: o.title && T(o.title), buttonLabel: o.buttonLabel && T(o.buttonLabel), message: o.message && T(o.message),
      filters: Array.isArray(o.filters) ? o.filters.map((f) => ({ ...f, name: T(f.name) })) : o.filters });
    switch (fn) {
      // janelas do Windows
      case "saveDialog": { const r = await dialog.showSaveDialog(win, dlg(args[0])); return r.canceled ? null : r.filePath; }
      case "openDialog": { const r = await dialog.showOpenDialog(win, dlg(args[0])); return r.canceled ? null : r.filePaths; }
      case "messageBox": {
        const o = args[0] || {};
        const r = await dialog.showMessageBox(win, { type: o.type || "info", title: o.title ? T(o.title) : m.manifest.name, message: T(String(o.message || "")),
          detail: o.detail && T(o.detail), buttons: Array.isArray(o.buttons) ? o.buttons.map((b) => T(b)) : o.buttons, defaultId: o.defaultId, cancelId: o.cancelId, noLink: true });
        return r.response;
      }
      case "openPath": { // só pastas (nunca executa arquivos)
        const p = String(args[0] || "");
        if (!p || !fs.existsSync(p) || !fs.statSync(p).isDirectory()) return "pasta inexistente";
        return shell.openPath(p);
      }
      case "showItem": { const p = String(args[0] || ""); if (p && fs.existsSync(p)) shell.showItemInFolder(p); return true; }
      case "notify":
        if (Notification.isSupported()) {
          const icon = m.manifest.icon ? nativeImage.createFromPath(path.join(m.dir, m.manifest.icon)) : undefined;
          const n = new Notification({ title: args[0] ? T(args[0]) : m.manifest.name, body: T(args[1] || ""), icon });
          n.on("click", () => this.emit("focus", m.manifest.id));
          n.show();
        }
        return true;
      case "focus": this.emit("focus", m.manifest.id); return true;
      case "windowBounds": return win ? win.getBounds() : null;
      case "keepAlive": m.keepAlive = !!args[0]; m.keepAliveReason = args[1] && T(args[1]); this.emit("keepAlive"); return true;
      case "reloadView": if (m.view && !m.view.webContents.isDestroyed()) m.view.webContents.reload(); return true;

      // atalhos globais: ao apertar, o motor recebe o evento "hotkey" com o atalho
      case "registerHotkey": {
        const acc = String(args[0] || "");
        if (!acc) return false;
        if (m.hotkeys.has(acc)) return true;
        let ok = false;
        try { ok = globalShortcut.register(acc, () => this.hostEvent(m, "hotkey", acc)); } catch { ok = false; }
        if (ok) m.hotkeys.add(acc);
        return ok;
      }
      case "unregisterHotkey": {
        const acc = String(args[0] || "");
        if (m.hotkeys.delete(acc)) try { globalShortcut.unregister(acc); } catch { /* já liberado */ }
        return true;
      }

      // janelas extras do módulo (ex.: pergunta rápida), com window.piphin
      case "openWindow": return this.openWindow(m, String(args[0]), args[1] || {});
      case "showWindow": {
        const w = this.win(m, args[0]);
        const o = args[1] || {};
        const [ww, wh] = w.getSize();
        if (o.placement === "cursor-top") {
          const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
          w.setBounds({ x: Math.round(d.x + (d.width - ww) / 2), y: Math.round(d.y + d.height * (o.top ?? 0.16)), width: ww, height: wh });
        } else if (/^(top|bottom)-(left|right)$/.test(o.placement || "")) {
          // cantos do monitor principal (ex.: overlay de jogo)
          const d = screen.getPrimaryDisplay().bounds;
          const mg = o.margin ?? 12;
          const [v, h] = o.placement.split("-");
          w.setBounds({ x: h === "left" ? d.x + mg : d.x + d.width - ww - mg, y: v === "top" ? d.y + mg : d.y + d.height - wh - mg, width: ww, height: wh });
        }
        if (o.focus === false) w.showInactive(); else { w.show(); w.focus(); }
        return true;
      }
      case "setWindowOpacity": { const w = this.win(m, args[0]); w.setOpacity(Math.max(0.1, Math.min(1, Number(args[1]) || 1))); return true; }
      case "hideWindow": { const w = m.windows.get(args[0]); if (w && !w.isDestroyed() && w.isVisible()) w.hide(); return true; }
      case "setWindowBounds": { const w = this.win(m, args[0]); w.setBounds({ ...w.getBounds(), ...(args[1] || {}) }); return true; }
      case "windowState": {
        const w = m.windows.get(args[0]);
        return w && !w.isDestroyed() ? { visible: w.isVisible(), focused: w.isFocused() } : { visible: false, focused: false };
      }
      case "sendToWindow": {
        const w = m.windows.get(args[0]);
        if (w && !w.isDestroyed()) w.webContents.send("mod:event", args[1], args[2]);
        return true;
      }
      case "reloadWindows": for (const w of m.windows.values()) if (!w.isDestroyed()) w.webContents.reload(); return true;

      // tela e área de transferência
      case "captureScreen": return this.captureScreen(m, args[0] || {});
      case "readClipboard": return this.readClipboard();
      case "writeClipboardImage": { // PNG em base64
        const buf = Buffer.from(String(args[0] || ""), "base64");
        if (nativeImage.createFromBuffer(buf).isEmpty()) throw new Error("Imagem inválida");
        if (typeof clipboard.writeImage === "function") { clipboard.writeImage(nativeImage.createFromBuffer(buf)); return true; } // Electron antigo
        // Electron 44+: clipboard.write() com itens no formato da web (ClipboardItem)
        const { ClipboardItem } = require("electron");
        await clipboard.write([new ClipboardItem({ "image/png": new Blob([buf], { type: "image/png" }) })]);
        return true;
      }
      case "displays": {
        const p = screen.getPrimaryDisplay().id, cur = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).id;
        return screen.getAllDisplays().map((d, i) => ({ id: String(d.id), label: d.label || `Monitor ${i + 1}`, bounds: d.bounds, workArea: d.workArea,
          scaleFactor: d.scaleFactor, primary: d.id === p, underCursor: d.id === cur }));
      }
      case "cursorPoint": return screen.getCursorScreenPoint();
      // fontes para gravar (monitores e janelas, com miniatura) e a escolhida para o próximo getDisplayMedia
      case "listCaptureSources": {
        if (!CAN_CAPTURE(m)) throw new Error("O módulo não tem a permissão screenCapture");
        const o = args[0] || {};
        const list = await desktopCapturer.getSources({ types: o.types || ["screen", "window"], thumbnailSize: o.thumbnail === false ? { width: 0, height: 0 } : { width: 320, height: 180 }, fetchWindowIcons: true });
        return list.filter((s) => s.name && !/^Piphin Hub$/.test(s.name) || s.id.startsWith("screen:")).map((s) => ({ id: s.id, name: s.name, type: s.id.startsWith("screen:") ? "screen" : "window", displayId: s.display_id || null,
          thumbnail: s.thumbnail && !s.thumbnail.isEmpty() ? s.thumbnail.toDataURL() : null, icon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : null }));
      }
      case "setCaptureSource": {
        if (!CAN_CAPTURE(m)) throw new Error("O módulo não tem a permissão screenCapture");
        const o = args[0] || {};
        m.captureSource = { id: String(o.id || ""), audio: !!o.audio };
        return true;
      }

      // mídia compartilhada entre os módulos (lib/library.js)
      case "libraryAdd": return this.library.add(m.manifest.id, args[0]).map((x) => this.publicItem(x));
      case "librarySync": return this.library.sync(m.manifest.id, args[0]);
      case "libraryRemove": return this.library.remove(m.manifest.id, args[0]);
      case "libraryList": return this.library.list(args[0] || {}).map((x) => this.publicItem(x));
      case "libraryThumb": return this.library.thumb(String(args[0] || ""), Math.min(640, Number(args[1]) || 320));
      case "pickMedia": {
        if (!this.picker) throw new Error("Escolher da mídia não está disponível");
        return (await this.picker(m, args[0] || {})).map((x) => this.publicItem(x));
      }
      case "openers": return this.openers(String(args[0] || ""), m.manifest.id);
      case "openIn": return this.openIn(String(args[0] || ""), args[1] || {}, m.manifest);

      // iniciar o Hub com o Windows (a configuração é do Hub; o módulo só pede)
      case "getStartWithWindows": return this.startWithWindows;
      case "setStartWithWindows": this.emit("startWithWindows", !!args[0]); return true;
    }
    throw new Error("Função desconhecida: " + fn);
  }

  // item da mídia para um módulo: com o nome do módulo que criou
  publicItem(x) {
    const mf = this.readManifest(path.join(this.dir, x.by));
    return { ...x, byName: mf ? mf.name : x.by };
  }

  // módulos instalados que abrem esse tipo de arquivo
  openers(kind, except) {
    return this.installed().filter((mf) => mf.id !== except && OPENS(mf).includes(kind) && !(mf.minHub && U.cmpVersion(this.hubVersion, mf.minHub) < 0))
      .map((mf) => ({ id: mf.id, name: mf.name }));
  }

  // "Abrir no ...": mostra o módulo de destino e entrega o arquivo (evento "open-file" no motor dele)
  async openIn(target, file, from) {
    const p = String((file && file.path) || "");
    if (!p || !fs.existsSync(p)) throw new Error("Arquivo não encontrado");
    const kind = kindOf(p);
    const mf = this.readManifest(path.join(this.dir, target));
    if (!mf || !kind || !OPENS(mf).includes(kind)) throw new Error(`${mf ? mf.name : target} não abre esse tipo de arquivo`);
    const item = this.library && this.library.list({ limit: 5000 }).find((x) => x.path.toLowerCase() === path.resolve(p).toLowerCase());
    await this.start(target);
    this.emit("focus", target);
    const t = this.mods.get(target);
    this.hostEvent(t, "open-file", { ...(item ? this.publicItem(item) : {}), path: path.resolve(p), kind, title: (file && file.title) || (item && item.title) || path.basename(p),
      from: from ? from.id : "hub", fromName: from ? from.name : "Piphin Hub" });
    return true;
  }

  // avisa os módulos rodando que a mídia mudou (ex.: o Piphin Vídeo atualiza a lista)
  broadcast(name, data) {
    for (const m of this.mods.values()) this.hostEvent(m, name, data);
  }

  win(m, name) {
    const w = m.windows.get(name);
    if (!w || w.isDestroyed()) throw new Error("Janela inexistente: " + name);
    return w;
  }

  openWindow(m, name, opts) {
    const old = m.windows.get(name);
    if (old && !old.isDestroyed()) return true;
    const o = { show: false };
    for (const k of WINDOW_OPTS) if (k in opts) o[k] = opts[k];
    const w = new BrowserWindow({
      ...o,
      icon: m.manifest.icon ? nativeImage.createFromPath(path.join(m.dir, m.manifest.icon)) : undefined,
      webPreferences: { preload: path.join(__dirname, "..", "module-preload.js"), contextIsolation: true, sandbox: true },
    });
    w.removeMenu();
    if (opts.alwaysOnTop) w.setAlwaysOnTop(true, opts.topLevel === "screen-saver" ? "screen-saver" : "floating");
    if (opts.clickThrough) w.setIgnoreMouseEvents(true); // cliques passam para o que está atrás (ex.: overlay de jogo)
    if (opts.contentProtection) w.setContentProtection(true); // não aparece em prints nem gravações (ex.: barra do gravador)
    m.windows.set(name, w);
    this.guard(m, w.webContents);
    w.on("blur", () => this.hostEvent(m, "window-blur", name));
    w.on("show", () => this.hostEvent(m, "window-show", name));
    w.on("hide", () => this.hostEvent(m, "window-hide", name));
    w.on("closed", () => m.windows.delete(name));
    // fechar pelo Alt+F4 só esconde (o módulo decide quando destruir)
    w.on("close", (e) => { if (!m.closing) { e.preventDefault(); w.hide(); } });
    this.load(m, w.webContents, opts.url || opts.file);
    return true;
  }

  // print de um monitor (o do mouse, ou display: id), em JPEG (padrão, até 1920 px) ou PNG (format: "png", maxWidth: 0 = tamanho real)
  async captureScreen(m, { hide = [], maxWidth = 1920, quality = 88, format = "jpeg", display = null } = {}) {
    const hidden = [];
    for (const name of hide) {
      const w = m.windows.get(name);
      if (w && !w.isDestroyed() && w.isVisible()) { w.setOpacity(0); w.hide(); hidden.push(w); }
    }
    if (hidden.length) await new Promise((r) => setTimeout(r, 250));
    try {
      const disp = (display && screen.getAllDisplays().find((d) => String(d.id) === String(display))) || screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
      const size = { width: Math.round(disp.size.width * disp.scaleFactor), height: Math.round(disp.size.height * disp.scaleFactor) };
      const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: size });
      const src = sources.find((s) => s.display_id === String(disp.id)) || sources[0];
      if (!src || src.thumbnail.isEmpty()) return null;
      let img = src.thumbnail;
      if (maxWidth > 0 && img.getSize().width > maxWidth) img = img.resize({ width: maxWidth, quality: "best" });
      return format === "png" ? img.toPNG().toString("base64") : img.toJPEG(quality).toString("base64");
    } finally {
      for (const w of hidden) { w.show(); w.setOpacity(1); w.focus(); }
    }
  }

  // texto e imagem (PNG em base64) da área de transferência
  async readClipboard() {
    const text = await clipboard.readText();
    let image = null;
    if (typeof clipboard.readImage === "function") { // Electron antigo
      const img = clipboard.readImage();
      if (!img.isEmpty()) image = img.toPNG().toString("base64");
    } else { // Electron 44+: clipboard.read() devolve itens no formato da web (ClipboardItem)
      for (const item of await clipboard.read()) {
        const type = (item.types || []).find((t) => t.startsWith("image/"));
        if (!type) continue;
        const buf = Buffer.from(await (await item.getType(type)).arrayBuffer());
        image = type === "image/png" ? buf.toString("base64") : nativeImage.createFromBuffer(buf).toPNG().toString("base64");
        break;
      }
    }
    return { text: text || "", image };
  }

  keepAliveReasons() {
    return [...this.mods.values()].filter((m) => m.keepAlive && m.proc).map((m) => m.keepAliveReason || m.manifest.name);
  }

  // ferramenta de um módulo chamada pela IA (lib/tools-server.js): inicia o módulo se estiver parado
  async callTool(id, tool, args) {
    let m = this.mods.get(id);
    if (!m || (!m.proc && m.manifest.main)) { await this.start(id); m = this.mods.get(id); }
    return this.invoke(m, "tool:" + tool, [args || {}]);
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

  // atalhos e janelas extras são do módulo: saem junto com ele
  releaseNative(m) {
    for (const acc of m.hotkeys) try { globalShortcut.unregister(acc); } catch { /* já liberado */ }
    m.hotkeys.clear();
    m.closing = true;
    for (const w of m.windows.values()) if (!w.isDestroyed()) w.destroy();
    m.windows.clear();
    m.closing = false;
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
      const t = setTimeout(() => proc.kill(), 6000); // não respondeu: encerra à força
      await exited;
      clearTimeout(t);
    }
    this.releaseNative(m);
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
    else if (m.state === "starting") await m.ready;
    if (!m.view) {
      m.view = new WebContentsView({
        webPreferences: { preload: path.join(__dirname, "..", "module-preload.js"), contextIsolation: true, sandbox: true },
      });
      m.view.setBackgroundColor("#08070d");
      const wc = m.view.webContents;
      this.guard(m, wc);
      wc.on("render-process-gone", () => { m.view = null; if (this.visible === id) this.visible = null; this.emit("changed"); });
      wc.on("before-input-event", (e, input) => {
        if (input.type !== "keyDown" || !input.control || input.alt) return;
        const k = input.key.toLowerCase();
        // teclas que o módulo reservou para ele no module.json (ex.: "reservedKeys": ["ctrl+1"]) continuam com o módulo
        if ((m.manifest.reservedKeys || []).map((x) => String(x).toLowerCase()).includes("ctrl+" + k)) return;
        if (k === "k" || k === "," || (/^[1-9]$/.test(k) && !input.shift)) { e.preventDefault(); this.emit("shortcut", k); }
      });
      this.load(m, wc, m.manifest.ui || "web/index.html");
    }
    for (const [oid, o] of this.mods) if (oid !== id && o.view && o.view.getVisible()) { o.view.setVisible(false); this.hostEvent(o, "view-hidden"); }
    if (!win.contentView.children.includes(m.view)) win.contentView.addChildView(m.view);
    m.view.setVisible(true);
    if (this.visible !== id) this.hostEvent(m, "view-shown");
    this.visible = id;
    this.layout();
    m.view.webContents.focus();
  }

  setInsetLeft(px) { this.insetLeft = Math.max(0, Math.round(px)); this.layout(); }

  // algo do Hub por cima (ex.: paleta de comandos): a tela do módulo sai da frente sem "sumir" para ele
  setCovered(on) {
    this.covered = !!on;
    const m = this.visible && this.mods.get(this.visible);
    if (m && m.view) m.view.setVisible(!this.covered);
    if (!this.covered) this.getWindow()?.webContents.focus();
  }

  // a janela do Hub foi escondida/minimizada ou voltou: avisa o módulo que está na tela
  windowVisibility(on) {
    const m = this.visible && this.mods.get(this.visible);
    if (m) this.hostEvent(m, on ? "view-shown" : "view-hidden");
  }

  hide() {
    for (const m of this.mods.values()) if (m.view && m.view.getVisible()) { m.view.setVisible(false); this.hostEvent(m, "view-hidden"); }
    this.visible = null;
  }

  layout() {
    const win = this.getWindow();
    const m = this.visible && this.mods.get(this.visible);
    if (!win || !m || !m.view) return;
    const [w, h] = win.getContentSize();
    m.view.setBounds({ x: this.insetLeft, y: TITLEBAR, width: Math.max(0, w - this.insetLeft), height: Math.max(0, h - TITLEBAR) });
    m.view.setVisible(!this.covered);
  }
}

module.exports = { ModuleHost };
