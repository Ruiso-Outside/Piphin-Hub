// Piphin Hub: processo principal do Electron.
const { app, BrowserWindow, ipcMain, shell, dialog, Notification, nativeImage, Tray, Menu, protocol, net } = require("electron");
const { pathToFileURL } = require("url");
const os = require("os");
const fs = require("fs");
const path = require("path");
const { Hub } = require("./lib/apps");
const U = require("./lib/util");
const selfupdate = require("./lib/selfupdate");
const { ModuleHost } = require("./lib/modules");
const { ToolsServer } = require("./lib/tools-server");
const { MediaLibrary } = require("./lib/library");
const zone = require("./lib/zone");

app.setAppUserModelId("studio.piphin.hub");
// piphin://ui/...: o kit de interface (Piphin UI) servido para o Hub e para as páginas dos módulos
// desenvolvimento: desenha a janela mesmo coberta por outras (para revisar telas automaticamente)
if (process.env.PIPHIN_DEV === "1") app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");
protocol.registerSchemesAsPrivileged([{ scheme: "piphin", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
// Uma cópia do Hub por vez. Se outra cópia MAIS ANTIGA estiver aberta (ex.: escondida perto do relógio),
// ela fecha e passa a vez para esta (ver "second-instance"); a mesma versão ou mais nova só vem para a frente.
const INSTANCE = { version: app.getVersion(), exe: process.execPath };
let hasLock = app.requestSingleInstanceLock(INSTANCE);
const instanceFile = () => path.join(app.getPath("userData"), "instance.json");

async function acquireInstance() {
  if (!hasLock) {
    // escrito pelo Hub 1.4.2 ou mais novo; sem ele, a cópia aberta é mais antiga e não sabe passar a vez
    const running = U.readJson(instanceFile(), null);
    if (running && running.version && U.cmpVersion(app.getVersion(), running.version) <= 0) return false;
    const tries = running ? 24 : 6;
    for (let i = 0; i < tries && !hasLock; i++) {
      await new Promise((r) => setTimeout(r, 500));
      hasLock = app.requestSingleInstanceLock(INSTANCE);
    }
    if (!hasLock) {
      await dialog.showMessageBox({ type: "warning", title: "Piphin Hub", noLink: true, buttons: ["OK"],
        message: "Outra cópia do Piphin Hub está aberta",
        detail: `Uma versão mais antiga do Hub continua rodando (talvez escondida perto do relógio). Clique com o botão direito no ícone dela, escolha "Sair" e abra esta versão (${app.getVersion()}) de novo.` });
      return false;
    }
  }
  try { U.writeJson(instanceFile(), { ...INSTANCE, pid: process.pid, at: new Date().toISOString() }); } catch { /* sem disco */ }
  return true;
}

const ICON = path.join(__dirname, "icons", "hub.png");
let win = null;
let hub = null;
let hubUpdate = null; // atualização do próprio Hub: { version, notes, pct, ready, error }
let hubChecking = false;
let modules = null; // módulos que rodam dentro do Hub
let tools = null; // ferramentas dos módulos para a IA (servidor MCP local)
let library = null; // mídia compartilhada entre os módulos (lib/library.js)
const picks = new Map(); // janelas "Escolher da mídia" abertas: id -> resolve
let tray = null;
let quitting = false;
let modulesStopped = false;
const CHECK_EVERY = 6 * 60 * 60 * 1000; // apps
const HUB_CHECK_EVERY = 60 * 60 * 1000; // o próprio Hub (1 consulta, pacote pequeno)

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 900,
    minHeight: 560,
    backgroundColor: "#08070d",
    title: "Piphin Hub",
    icon: nativeImage.createFromPath(ICON),
    titleBarStyle: "hidden",
    titleBarOverlay: { color: "#08070d", symbolColor: "#a9a6c2", height: 44 },
    show: false,
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, sandbox: true },
  });
  win.removeMenu();
  win.loadFile(path.join(__dirname, "web", "index.html"));
  // aberto pelo Windows (iniciar com o Windows): fica só no ícone perto do relógio
  win.once("ready-to-show", () => { if (process.argv.includes("--hidden")) showTray(false); else win.show(); });
  // links externos abrem no navegador
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//.test(url)) shell.openExternal(url); return { action: "deny" }; });
  win.webContents.on("will-navigate", (e, url) => { if (!url.startsWith("file:")) { e.preventDefault(); if (/^https:\/\//.test(url)) shell.openExternal(url); } });
  win.on("resize", () => modules && modules.layout());
  for (const [ev, on] of [["hide", false], ["minimize", false], ["show", true], ["restore", true]]) win.on(ev, () => modules && modules.windowVisibility(on));
  // com um módulo trabalhando em segundo plano (ex.: atalhos de macro), fechar só esconde o Hub
  win.on("close", (e) => {
    if (quitting || !modules || !modules.keepAliveReasons().length) return;
    e.preventDefault();
    win.hide();
    showTray(true);
    if (hubUpdate && hubUpdate.ready) restartHidden(); // atualização pronta: aproveita que a janela saiu da frente
  });
}

const showWin = () => { if (!win) return; if (win.isMinimized()) win.restore(); win.show(); win.focus(); };

// Ícone perto do relógio: aparece quando o Hub fica rodando escondido
let trayHinted = false;
function showTray(hint) {
  if (!tray) {
    tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }));
    tray.on("click", showWin);
  }
  updateTray();
  if (hint && !trayHinted) {
    trayHinted = true;
    tray.displayBalloon({ title: "Piphin Hub", content: `Continua rodando aqui: ${modules.keepAliveReasons().join(", ")}. Clique no ícone para abrir.`, iconType: "info" });
  }
}

function updateTray() {
  if (!tray) return;
  const reasons = modules ? modules.keepAliveReasons() : [];
  tray.setToolTip("Piphin Hub" + (reasons.length ? " · " + reasons.join(", ") : ""));
  const mods = modules ? modules.status() : [];
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Abrir o Piphin Hub", click: showWin },
    ...(mods.length ? [{ type: "separator" }, ...mods.map((m) => ({ label: m.name, click: () => { showWin(); send("hub:openModule", m.id); } }))] : []),
    { type: "separator" },
    { label: "Sair", click: () => { quitting = true; app.quit(); } },
  ]));
}

// Iniciar com o Windows: abre escondido (--hidden), para os atalhos dos módulos funcionarem desde o início
function applyStartWithWindows() {
  const on = !!hub.settings.startWithWindows;
  if (modules) modules.startWithWindows = on;
  if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: on, args: ["--hidden"] });
}

// Para os módulos com calma (eles desligam ganchos de teclado, processos auxiliares...)
async function stopModules() {
  if (modulesStopped || !modules) return;
  await modules.stopAll();
  modulesStopped = true;
}

const send = (ch, data) => { if (win && !win.isDestroyed()) win.webContents.send(ch, data); };

// Toda chamada do renderer devolve { ok, data } ou { ok:false, error, code }
function handle(name, fn) {
  ipcMain.handle(name, async (_e, ...args) => {
    try { return { ok: true, data: await fn(...args) }; }
    catch (e) { return { ok: false, error: e.message || String(e), code: e.code }; }
  });
}

function registerIpc() {
  handle("hub:snapshot", () => ({ ...hub.snapshot(), hubVersion: app.getVersion(), hubUpdate, modules: modules.status(), visibleModule: modules.visible, hubBlocked: hubBlocked() }));
  handle("hub:unblock", () => unblockHub());
  handle("hub:openModule", (id) => modules.show(id));
  handle("hub:layout", (o) => { if (o && typeof o.left === "number") modules.setInsetLeft(o.left); if (o && "covered" in o) modules.setCovered(o.covered); });
  handle("hub:pulse", () => sysPulse());
  // só em desenvolvimento (PIPHIN_DEV=1): foto da área de um módulo, para revisar as telas
  if (process.env.PIPHIN_DEV === "1") handle("hub:devCapture", async (id) => {
    const m = modules.mods.get(id);
    if (!m || !m.view) return null;
    win.show(); win.moveTop();
    await new Promise((r) => setTimeout(r, 400));
    return (await m.view.webContents.capturePage()).toPNG().toString("base64");
  });
  // só em desenvolvimento: tecla com Ctrl dentro de um módulo, pelo mesmo caminho do teclado de verdade
  if (process.env.PIPHIN_DEV === "1") handle("hub:devKey", async (id, key) => {
    const m = modules.mods.get(id);
    if (!m || !m.view) return false;
    m.view.webContents.focus();
    for (const type of ["keyDown", "keyUp"]) m.view.webContents.sendInputEvent({ type, keyCode: key, modifiers: ["control"] });
    return true;
  });
  // mídia compartilhada (tela Mídia do Hub)
  handle("hub:library", (filter) => library.list(filter || {}).map((x) => modules.publicItem(x)));
  handle("hub:libThumb", (id) => library.thumb(String(id)));
  handle("hub:openers", (kind) => modules.openers(String(kind)));
  handle("hub:openIn", (target, id) => { const it = library.get(id); if (!it) throw new Error("Item não encontrado"); return modules.openIn(target, it, null); });
  handle("hub:showMedia", (id) => { const it = library.get(id); if (it && fs.existsSync(it.path)) shell.showItemInFolder(it.path); return true; });
  handle("hub:pickDone", (id, ids) => {
    const done = picks.get(id);
    if (done) { picks.delete(id); done((Array.isArray(ids) ? ids : []).map((x) => library.get(x)).filter(Boolean)); }
    return true;
  });
  // arrastar um item da Mídia para fora (Explorer, WhatsApp, Discord, outro programa)
  ipcMain.on("hub:dragOut", (e, id) => {
    const it = library.get(id);
    if (!it || !fs.existsSync(it.path)) return;
    let icon = nativeImage.createFromPath(ICON).resize({ width: 48, height: 48 });
    const t = library.thumbs.get(id);
    if (t) { const img = nativeImage.createFromDataURL(t); if (!img.isEmpty()) icon = img.resize({ width: 96 }); }
    e.sender.startDrag({ file: it.path, icon });
  });
  // só em desenvolvimento: endereço das ferramentas da IA (para testar módulos pelo mesmo caminho do Piphin LLM)
  if (process.env.PIPHIN_DEV === "1") handle("hub:devToolsUrl", () => (tools ? tools.url : ""));
  handle("hub:closeModule", () => modules.hide());
  handle("hub:restartModule", async (id) => { const vis = modules.visible === id; await modules.restart(id); if (vis) await modules.show(id); });
  handle("hub:refresh", async (force) => { await hub.refresh({ force: !!force }); return null; });
  handle("hub:install", (id, opts) => hub.install(id, opts));
  handle("hub:cancel", (id) => hub.cancel(id));
  handle("hub:uninstall", (id, opts) => hub.uninstall(id, opts));
  handle("hub:launch", (id) => hub.launch(id));
  handle("hub:openFolder", async (id) => {
    const s = hub.status[id];
    if (!s || !s.dir) throw new Error("O app não está instalado");
    const err = await shell.openPath(s.dir);
    if (err) throw new Error(err);
  });
  handle("hub:openUrl", (url) => { if (/^https:\/\//.test(url)) return shell.openExternal(url); });
  handle("hub:locate", async (id) => {
    const a = hub.app(id);
    const r = await dialog.showOpenDialog(win, { title: `Onde está o ${a.name}?`, properties: ["openDirectory"] });
    if (r.canceled || !r.filePaths[0]) return false;
    await hub.locate(id, r.filePaths[0]);
    return true;
  });
  handle("hub:forget", (id) => hub.forget(id));
  handle("hub:pickFolder", async (title) => {
    const r = await dialog.showOpenDialog(win, { title: title || "Escolher pasta", properties: ["openDirectory", "createDirectory"] });
    return r.canceled ? null : r.filePaths[0];
  });
  handle("hub:setSettings", (patch) => {
    if (patch.githubToken === "••••") delete patch.githubToken; // valor mascarado: não mudou
    hub.setSettings(patch);
    if ("startWithWindows" in patch) applyStartWithWindows();
    return null;
  });
  handle("hub:hubShortcuts", () => hubShortcuts(true));
  handle("hub:addCustom", (def) => hub.addCustomApp(def));
  handle("hub:removeCustom", (id) => hub.removeCustomApp(id));
  handle("hub:folderSize", (id) => { const s = hub.status[id]; return s && s.dir ? U.folderSize(s.dir) : 0; });
  handle("hub:selfCheck", () => checkHubUpdate({ force: true, ask: true }));
  handle("hub:selfRestart", async () => {
    if (!hubUpdate || !hubUpdate.ready) throw new Error("Nenhuma atualização do Hub pronta");
    if (hub.jobs.size) throw new Error("Espere as instalações em andamento terminarem");
    await stopModules();
    selfupdate.restartNow(app);
  });
}

// Atualização do próprio Hub: verifica o GitHub, baixa sozinho e pergunta se pode reiniciar.
// Se a resposta for "Depois", a versão nova entra quando o Hub for fechado.
async function checkHubUpdate({ force = false, ask = true } = {}) {
  if (hubChecking || (hubUpdate && hubUpdate.ready)) return hubUpdate;
  hubChecking = true;
  try {
    const latest = await selfupdate.check(app, { force });
    if (!latest) return null;
    hubUpdate = { version: latest.version, notes: latest.notes, pct: 0, ready: false };
    send("hub:changed");
    await selfupdate.prepare(app, latest, ({ done, total }) => {
      hubUpdate.pct = total ? done / total : null;
      send("hub:selfProgress", hubUpdate.pct);
    });
    hubUpdate.ready = true;
    send("hub:changed");
    if (ask) askRestart();
    return hubUpdate;
  } catch (e) {
    if (hubUpdate) { hubUpdate.error = e.message; send("hub:changed"); }
    return hubUpdate;
  } finally {
    hubChecking = false;
  }
}

// Hub escondido perto do relógio: aplica a atualização sozinho, sem interromper (volta escondido)
async function restartHidden() {
  if (!hubUpdate || !hubUpdate.ready || hub.jobs.size) return;
  await stopModules();
  selfupdate.restartNow(app, { hidden: true });
}

async function askRestart() {
  if (!win || win.isDestroyed()) return;
  if (!win.isVisible()) return restartHidden();
  if (!win.isFocused() && Notification.isSupported()) {
    const n = new Notification({ title: "Piphin Hub", body: `A versão ${hubUpdate.version} do Hub está pronta. Clique para reiniciar.`, icon: ICON });
    n.on("click", () => { win.show(); win.focus(); });
    n.show();
  }
  if (hub.jobs.size) return; // não interrompe instalações: aplica ao fechar
  const notes = String(hubUpdate.notes || "").replace(/[*`]/g, "").trim().slice(0, 600);
  const r = await dialog.showMessageBox(win, {
    type: "info",
    title: "Atualização do Piphin Hub",
    message: `O Piphin Hub ${hubUpdate.version} foi baixado.`,
    detail: (notes ? notes + "\n\n" : "") + "Reiniciar agora para usar a versão nova? Se escolher \"Depois\", ela é aplicada quando você fechar o Hub.",
    buttons: ["Reiniciar agora", "Depois"],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  });
  if (r.response === 0 && !hub.jobs.size) { await stopModules(); selfupdate.restartNow(app); }
}

// Verificação periódica: avisa (ou atualiza, se ligado) os apps com versão nova
async function periodicCheck(first) {
  try {
    await hub.refresh({ force: !first });
    send("hub:changed");
    const pending = hub.snapshot().apps.filter((a) => a.status && a.status.updateAvailable);
    if (hub.settings.autoUpdate) {
      for (const a of pending) {
        try { await hub.install(a.id, { closeIfRunning: false }); } catch { /* aberto ou sem rede: fica para depois */ }
      }
    } else if (pending.length && !first && Notification.isSupported() && !(win && win.isFocused())) {
      const n = new Notification({ title: "Piphin Hub", body: `Atualização disponível: ${pending.map((a) => a.name).join(", ")}`, icon: ICON });
      n.on("click", () => { if (win) { win.show(); win.focus(); } });
      n.show();
    }
  } catch { /* sem rede */ }
}

// Atalhos do próprio Hub (Área de Trabalho e Menu Iniciar). Criados na primeira execução;
// depois só são corrigidos se a pasta do Hub mudar, para não voltarem se o usuário apagar.
function hubShortcuts(force) {
  if (!app.isPackaged && !force) return;
  const links = [
    path.join(app.getPath("desktop"), "Piphin Hub.lnk"),
    path.join(app.getPath("appData"), "Microsoft", "Windows", "Start Menu", "Programs", "Piphin Hub.lnk"),
  ];
  const opts = {
    target: process.execPath,
    cwd: path.dirname(process.execPath),
    description: "Piphin Hub: baixe, atualize e gerencie os apps da Piphin Studio",
    icon: path.join(__dirname, "icons", "hub.ico"),
    iconIndex: 0,
    appUserModelId: "studio.piphin.hub",
  };
  const first = !hub.state.hubShortcuts;
  for (const lnk of links) {
    const exists = fs.existsSync(lnk);
    try {
      if (first || force) shell.writeShortcutLink(lnk, exists ? "replace" : "create", opts);
      else if (exists && shell.readShortcutLink(lnk).target.toLowerCase() !== process.execPath.toLowerCase())
        shell.writeShortcutLink(lnk, "replace", opts);
    } catch { /* sem permissão na pasta */ }
  }
  if (first) { hub.state.hubShortcuts = true; hub.save(); }
}

// Hub extraído de um .zip baixado (marca Zone.Identifier): o Windows pode bloquear os atalhos do Hub.
// Só verificamos aqui; tirar a marca é decisão do usuário (botão na tela Início).
const ofs = require("original-fs");
const hubBlocked = () => app.isPackaged && process.platform === "win32" && zone.isMarked(process.execPath, ofs);

function unblockHub() {
  if (!app.isPackaged) throw new Error("Só funciona no Hub instalado");
  const r = zone.unblockDir(path.dirname(process.execPath), ofs);
  if (r.failed) throw new Error(`Não foi possível desbloquear ${r.failed} arquivo(s). Feche o Hub e tente de novo, ou extraia o .zip outra vez depois de marcar Desbloquear em Propriedades.`);
  return r;
}

function registerUiProtocol() {
  const root = path.join(__dirname, "web", "ui");
  protocol.handle("piphin", (req) => {
    const u = new URL(req.url);
    const file = path.normalize(path.join(root, decodeURIComponent(u.pathname)));
    if (u.host !== "ui" || !file.startsWith(root + path.sep) || !fs.existsSync(file)) return new Response("não encontrado", { status: 404 });
    return net.fetch(pathToFileURL(file).href);
  });
}

// pulso do sistema para a tela Início (uso de CPU e RAM, sem precisar de nenhum módulo)
let lastCpu = null;
function sysPulse() {
  const cpus = os.cpus();
  const t = cpus.reduce((a, c) => { for (const k in c.times) a.total += c.times[k]; a.idle += c.times.idle; return a; }, { total: 0, idle: 0 });
  let cpu = null;
  if (lastCpu) { const dt = t.total - lastCpu.total; cpu = dt > 0 ? Math.max(0, Math.min(100, (1 - (t.idle - lastCpu.idle) / dt) * 100)) : null; }
  lastCpu = t;
  const total = os.totalmem(), free = os.freemem();
  return { cpu, cpuName: (cpus[0] && cpus[0].model || "").trim(), cores: cpus.length, ramUsed: total - free, ramTotal: total, uptime: os.uptime(),
    user: os.userInfo().username, host: os.hostname() };
}

app.whenReady().then(async () => {
  if (!(await acquireInstance())) return app.exit(0);
  if (selfupdate.applyStagedOnStart(app)) return; // versão baixada e não aplicada: troca e reabre
  registerUiProtocol();
  selfupdate.cleanup(app);
  const userData = app.getPath("userData");
  modules = new ModuleHost({
    dir: path.join(userData, "modules"),
    dataDir: path.join(userData, "module-data"),
    logDir: path.join(userData, "logs"),
    hubVersion: app.getVersion(),
    getWindow: () => (win && !win.isDestroyed() ? win : null),
  });
  modules.on("changed", () => { send("hub:changed"); updateTray(); });
  library = new MediaLibrary({ file: path.join(userData, "midia.json"), nativeImage });
  modules.library = library;
  library.on("changed", () => { send("hub:libraryChanged"); modules.broadcast("library-changed", {}); });
  // um módulo pediu para escolher da Mídia: a janela aparece no Hub (por cima da tela do módulo)
  let pickSeq = 0;
  modules.picker = (m, opts) => new Promise((resolve) => {
    if (!win || win.isDestroyed()) return resolve([]);
    const id = ++pickSeq;
    picks.set(id, resolve);
    showWin();
    send("hub:pick", { id, from: m.manifest.name, kinds: [].concat(opts.kinds || opts.kind || []).filter(Boolean), multi: opts.multi !== false, title: String(opts.title || "") });
  });
  modules.on("keepAlive", () => { updateTray(); if (tray && !modules.keepAliveReasons().length && win && win.isVisible()) { tray.destroy(); tray = null; } });
  modules.on("focus", (id) => { showWin(); send("hub:openModule", id); });
  modules.on("shortcut", (k) => send("hub:shortcut", k));
  modules.on("startWithWindows", (on) => { hub.setSettings({ startWithWindows: on }); applyStartWithWindows(); send("hub:changed"); });
  hub = new Hub({ appDir: __dirname, userDir: userData, shell, desktopDir: app.getPath("desktop"), modules });
  hub.on("openModule", (id) => send("hub:openModule", id));
  applyStartWithWindows();
  hubShortcuts(false);
  hub.on("changed", () => send("hub:changed"));
  hub.on("progress", (p) => send("hub:progress", p));
  registerIpc();
  createWindow();
  // ferramentas dos módulos para a IA (antes de iniciar os módulos: eles recebem o endereço)
  tools = new ToolsServer({ modules, hubVersion: app.getVersion(), builtins: [{
    // a IA acha o que os módulos criaram ou baixaram (ex.: "coloque a música que eu baixei no vídeo")
    def: { name: "hub_media_library", title: "Piphin Hub: Mídia", annotations: { readOnlyHint: true },
      description: "[Piphin Hub] Lista a mídia dos módulos num lugar só: músicas baixadas no Piphin Música, sons e músicas do Piphin Som, prints e gravações do Piphin Captura, imagens do Piphin Foto e vídeos do Piphin Vídeo. Devolve o caminho de cada arquivo, para usar em outras ferramentas (ex.: video_import_media, som_import_audio, foto_open_image). can_use_in_videos=false: a licença não permite usar a música em vídeos.",
      inputSchema: { type: "object", properties: { kind: { type: "string", enum: ["audio", "video", "image"] }, query: { type: "string", description: "Palavras do nome, artista ou jogo" },
        from_module: { type: "string", description: "id do módulo (musica, som, captura, foto, video)" }, limit: { type: "integer", minimum: 1, maximum: 100 } } } },
    run: (a = {}) => {
      const list = library.list({ kind: a.kind, query: a.query, by: a.from_module, limit: a.limit || 25 });
      return { items: list.map((x) => ({ title: x.title, kind: x.kind, path: x.path, from: modules.publicItem(x).byName, type: x.sub, artist: x.artist, game: x.game,
        seconds: x.duration ? Math.round(x.duration) : undefined, license: x.license, credit: x.credit, can_use_in_videos: x.videoOk, added: x.addedAt.slice(0, 10) })),
        note: list.length ? undefined : "Nada na Mídia ainda com esse filtro." };
    },
  }] });
  modules.toolsUrl = await tools.start().catch(() => "");
  modules.startAll(); // os motores começam junto com o Hub (atalhos de macro funcionam desde já)
  if (hub.settings.checkOnStart) periodicCheck(true);
  else hub.refresh().catch(() => {});
  setInterval(() => periodicCheck(false), CHECK_EVERY);
  // o Hub sempre se mantém atualizado (mesmo com a verificação dos apps desligada)
  win.once("ready-to-show", () => setTimeout(() => checkHubUpdate({ force: true }), 3000));
  setInterval(() => checkHubUpdate({ force: true }), HUB_CHECK_EVERY);
});

// "Depois": aplica a versão baixada ao fechar
app.on("will-quit", () => {
  if (tools) tools.stop();
  if (hubUpdate && hubUpdate.ready) { try { selfupdate.swap(app); } catch { /* tenta de novo na próxima vez */ } }
});

// outra cópia foi aberta: se for mais nova, esta fecha e passa a vez; senão, só aparece
app.on("second-instance", (_e, _argv, _cwd, other) => {
  if (other && other.version && U.cmpVersion(other.version, app.getVersion()) > 0) { quitting = true; app.quit(); }
  else showWin();
});

// antes de sair, cada módulo desliga o que abriu
app.on("before-quit", (e) => {
  quitting = true;
  if (modulesStopped || !modules) return;
  e.preventDefault();
  stopModules().finally(() => app.quit());
});
app.on("window-all-closed", () => app.quit());
