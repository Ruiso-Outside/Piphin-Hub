// Piphin Hub: processo principal do Electron.
const { app, BrowserWindow, ipcMain, shell, dialog, Notification, nativeImage, Tray, Menu } = require("electron");
const fs = require("fs");
const path = require("path");
const { Hub } = require("./lib/apps");
const U = require("./lib/util");
const selfupdate = require("./lib/selfupdate");
const { Macros } = require("./lib/macro");

app.setAppUserModelId("studio.piphin.hub");
if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

const ICON = path.join(__dirname, "icons", "hub.png");
let win = null;
let hub = null;
let hubUpdate = null; // atualização do próprio Hub: { version, notes, pct, ready, error }
let hubChecking = false;
let macros = null;
let tray = null;
let trayHinted = false;
let quitting = false;
const CHECK_EVERY = 6 * 60 * 60 * 1000; // apps
const HUB_CHECK_EVERY = 60 * 60 * 1000; // o próprio Hub (1 consulta, pacote pequeno)

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 860,
    minHeight: 560,
    backgroundColor: "#0b0a12",
    title: "Piphin Hub",
    icon: nativeImage.createFromPath(ICON),
    titleBarStyle: "hidden",
    titleBarOverlay: { color: "#0b0a12", symbolColor: "#c4b5fd", height: 40 },
    show: false,
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, sandbox: true },
  });
  win.removeMenu();
  // com macros ligadas, fechar a janela só esconde (os atalhos continuam funcionando na bandeja)
  win.on("close", (e) => {
    if (quitting || !macros || !macros.settings.keepInTray || !macros.hasActiveHotkeys()) return;
    e.preventDefault();
    win.hide();
    showTray();
  });
  win.loadFile(path.join(__dirname, "web", "index.html"));
  win.once("ready-to-show", () => win.show());
  // links externos abrem no navegador
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//.test(url)) shell.openExternal(url); return { action: "deny" }; });
  win.webContents.on("will-navigate", (e, url) => { if (!url.startsWith("file:")) { e.preventDefault(); if (/^https:\/\//.test(url)) shell.openExternal(url); } });
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
  handle("hub:snapshot", () => ({ ...hub.snapshot(), hubVersion: app.getVersion(), hubUpdate }));
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
    return null;
  });
  handle("hub:hubShortcuts", () => hubShortcuts(true));
  handle("hub:addCustom", (def) => hub.addCustomApp(def));
  handle("hub:removeCustom", (id) => hub.removeCustomApp(id));
  handle("hub:folderSize", (id) => { const s = hub.status[id]; return s && s.dir ? U.folderSize(s.dir) : 0; });
  handle("hub:selfCheck", () => checkHubUpdate({ force: true, ask: true }));
  registerMacroIpc();
  handle("hub:selfRestart", () => {
    if (!hubUpdate || !hubUpdate.ready) throw new Error("Nenhuma atualização do Hub pronta");
    if (hub.jobs.size) throw new Error("Espere as instalações em andamento terminarem");
    selfupdate.restartNow(app);
  });
}

// ------------------------------------------------------------------ macros
function registerMacroIpc() {
  handle("macro:snapshot", () => macros.snapshot());
  handle("macro:start", () => macros.start());
  handle("macro:save", (def) => macros.saveMacro(def));
  handle("macro:delete", (id) => macros.deleteMacro(id));
  handle("macro:run", (id, opts) => macros.run(id, { once: !!(opts && opts.once) }));
  handle("macro:test", (id) => macros.test(id));
  handle("macro:stop", (id) => macros.stop(id));
  handle("macro:stopAll", () => macros.stopAll());
  handle("macro:settings", (patch) => macros.setSettings(patch));
  handle("macro:pause", (on) => macros.setHotkeysPaused(on));
  handle("macro:recStart", (opts) => macros.startRecording(opts));
  handle("macro:recStop", () => macros.stopRecording("button", win ? win.getBounds() : null));
  handle("macro:lab", (on, moves) => macros.setLab(on, moves));
  // posição do mouse, cor do pixel ou processo em foco, depois de alguns segundos (para dar tempo de ir ao jogo)
  handle("macro:capture", async (kind, delay) => {
    await macros.start();
    if (delay) await new Promise((r) => setTimeout(r, delay * 1000));
    if (kind === "fg") return { process: (await macros.engine.ask("fg"))[0] };
    const [x, y, color] = await macros.engine.ask("pix", "", "");
    return { x: +x, y: +y, color };
  });
  handle("macro:export", async (ids) => {
    const list = macros.list.filter((m) => ids.includes(m.id));
    const r = await dialog.showSaveDialog(win, { title: "Exportar macros", defaultPath: (list.length === 1 ? list[0].name : "macros") + ".piphin-macro.json",
      filters: [{ name: "Macros do Piphin", extensions: ["json"] }] });
    if (r.canceled || !r.filePath) return false;
    U.writeJson(r.filePath, { schema: 1, macros: list });
    return true;
  });
  handle("macro:import", async () => {
    const r = await dialog.showOpenDialog(win, { title: "Importar macros", properties: ["openFile"], filters: [{ name: "Macros do Piphin", extensions: ["json"] }] });
    if (r.canceled || !r.filePaths[0]) return 0;
    return macros.importMacros(U.readJson(r.filePaths[0], null));
  });
}

function initMacros() {
  macros = new Macros({ userDir: app.getPath("userData") });
  let batch = [];
  let flushing = null;
  macros.on("changed", () => { send("macro:changed"); updateTray(); });
  macros.on("loop", (l) => send("macro:loop", l));
  macros.on("recorded", (r) => { send("macro:recorded", r); if (win && !win.isVisible()) win.show(); });
  macros.on("notice", (n) => {
    send("macro:notice", n);
    if (n.kind === "panic" && win && !win.isFocused() && Notification.isSupported()) new Notification({ title: "Piphin Macro", body: n.text, icon: ICON }).show();
  });
  // eventos do analisador vão em lotes (o mouse pode gerar centenas por segundo)
  macros.on("input", (e) => {
    batch.push(e);
    if (!flushing) flushing = setTimeout(() => { send("macro:input", batch); batch = []; flushing = null; }, 50);
  });
  macros.boot();
}

// Ícone na bandeja: aparece quando a janela é escondida com macros ligadas
function showTray() {
  if (tray) return;
  tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }));
  tray.on("click", () => { win.show(); win.focus(); });
  updateTray();
  if (!trayHinted) {
    trayHinted = true;
    tray.displayBalloon({ title: "Piphin Hub", content: "As macros continuam ativas aqui na bandeja. Clique no ícone para abrir o Hub.", iconType: "info" });
  }
}

function updateTray() {
  if (!tray || !macros) return;
  const running = Object.keys(macros.running).length;
  tray.setToolTip(`Piphin Hub · macros ${macros.settings.armed ? "ligadas" : "desligadas"}${running ? ` · ${running} em execução` : ""}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Abrir o Piphin Hub", click: () => { win.show(); win.focus(); } },
    { type: "separator" },
    { label: "Atalhos de macro ligados", type: "checkbox", checked: !!macros.settings.armed, click: (i) => macros.setSettings({ armed: i.checked }) },
    { label: "Parar todas as macros", enabled: running > 0, click: () => macros.stopAll() },
    { type: "separator" },
    { label: "Sair", click: () => { quitting = true; app.quit(); } },
  ]));
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

async function askRestart() {
  if (!win || win.isDestroyed()) return;
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
  if (r.response === 0 && !hub.jobs.size) selfupdate.restartNow(app);
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

app.whenReady().then(() => {
  selfupdate.cleanup(app);
  hub = new Hub({ appDir: __dirname, userDir: app.getPath("userData"), shell, desktopDir: app.getPath("desktop") });
  hubShortcuts(false);
  hub.on("changed", () => send("hub:changed"));
  hub.on("progress", (p) => send("hub:progress", p));
  initMacros();
  registerIpc();
  createWindow();
  if (hub.settings.checkOnStart) periodicCheck(true);
  else hub.refresh().catch(() => {});
  setInterval(() => periodicCheck(false), CHECK_EVERY);
  // o Hub sempre se mantém atualizado (mesmo com a verificação dos apps desligada)
  win.once("ready-to-show", () => setTimeout(() => checkHubUpdate({ force: true }), 3000));
  setInterval(() => checkHubUpdate({ force: true }), HUB_CHECK_EVERY);
});

// "Depois": aplica a versão baixada ao fechar
app.on("before-quit", () => { quitting = true; });
app.on("will-quit", () => {
  if (macros) macros.shutdown();
  if (hubUpdate && hubUpdate.ready) { try { selfupdate.swap(app); } catch { /* tenta de novo na próxima vez */ } }
});

app.on("second-instance", () => { if (win) { if (!win.isVisible()) win.show(); if (win.isMinimized()) win.restore(); win.show(); win.focus(); } });
app.on("window-all-closed", () => app.quit());
