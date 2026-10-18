// Piphin Hub: processo principal do Electron.
const { app, BrowserWindow, ipcMain, shell, dialog, Notification, nativeImage } = require("electron");
const path = require("path");
const { Hub } = require("./lib/apps");
const U = require("./lib/util");
const selfupdate = require("./lib/selfupdate");

app.setAppUserModelId("studio.piphin.hub");
if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

const ICON = path.join(__dirname, "icons", "hub.png");
let win = null;
let hub = null;
let hubUpdate = null; // versão nova do próprio Hub
const CHECK_EVERY = 6 * 60 * 60 * 1000;

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
  handle("hub:addCustom", (def) => hub.addCustomApp(def));
  handle("hub:removeCustom", (id) => hub.removeCustomApp(id));
  handle("hub:folderSize", (id) => { const s = hub.status[id]; return s && s.dir ? U.folderSize(s.dir) : 0; });
  handle("hub:selfUpdate", async () => {
    if (!hubUpdate) return null;
    await selfupdate.apply(app, hubUpdate, ({ done, total }) => send("hub:selfProgress", total ? done / total : null));
  });
}

// Verificação periódica: avisa (ou atualiza, se ligado) os apps com versão nova
async function periodicCheck(first) {
  try {
    await hub.refresh({ force: !first });
    hubUpdate = await selfupdate.check(app);
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

app.whenReady().then(() => {
  selfupdate.cleanup(app);
  hub = new Hub({ appDir: __dirname, userDir: app.getPath("userData"), shell, desktopDir: app.getPath("desktop") });
  hub.on("changed", () => send("hub:changed"));
  hub.on("progress", (p) => send("hub:progress", p));
  registerIpc();
  createWindow();
  if (hub.settings.checkOnStart) periodicCheck(true);
  else hub.refresh().catch(() => {});
  setInterval(() => periodicCheck(false), CHECK_EVERY);
});

app.on("second-instance", () => { if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } });
app.on("window-all-closed", () => app.quit());
