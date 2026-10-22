// Roda o motor (backend) de um módulo num processo separado (utilityProcess do Electron).
// Se o módulo travar ou cair, o Hub e os outros módulos continuam funcionando.
//
// O módulo exporta  activate(ctx)  e, opcionalmente,  deactivate().  O ctx oferece:
//   ctx.id, ctx.version, ctx.dir, ctx.dataDir            identificação e pastas
//   ctx.handle(canal, fn)                                responde a piphin.invoke(canal, ...) da interface
//   ctx.emit(canal, dados)                               envia um evento para a interface (piphin.on)
//   ctx.onStop(fn)                                       limpeza antes de o módulo ser parado
//   ctx.host.saveDialog(opts) / openDialog(opts)         janelas de arquivo do Windows
//   ctx.host.notify(titulo, texto)                       notificação
//   ctx.host.focus()                                     traz o Hub (e este módulo) para a frente
//   ctx.host.windowBounds()                              posição da janela do Hub
//   ctx.host.keepAlive(ligado, motivo)                   fechar a janela só esconde o Hub (ex.: atalhos ativos)
//   ctx.host.messageBox({ message, detail, buttons })    pergunta ao usuário; devolve o índice do botão
//   ctx.host.openPath(pasta) / showItem(arquivo)         abre uma pasta / mostra um arquivo no Explorer
//   ctx.host.registerHotkey(atalho) / unregisterHotkey   atalho global; ao apertar chega o evento "hotkey"
//   ctx.host.openWindow(nome, { url | file, width, height, frame, transparent, alwaysOnTop, skipTaskbar, ... })
//   ctx.host.showWindow(nome, { placement: "cursor-top" }) / hideWindow / setWindowBounds / windowState
//   ctx.host.sendToWindow(nome, canal, dados)            evento para uma janela extra (piphin.on)
//   ctx.host.captureScreen({ hide: [janelas] })          print do monitor do mouse (JPEG em base64)
//   ctx.host.readClipboard()                             { text, image (PNG em base64) }
//   ctx.host.writeClipboardImage(pngBase64)              copia uma imagem
//   ctx.host.displays() / cursorPoint()                  monitores ({ id, label, bounds, scaleFactor, primary, underCursor }) e posição do mouse
//   captureScreen aceita format: "png", maxWidth: 0 (tamanho real) e display: id
//   ctx.host.listCaptureSources({ types }) / setCaptureSource({ id, audio })  (precisa de "permissions": ["screenCapture"])
//                                                        escolhe o monitor/janela (e o som do PC) do próximo getDisplayMedia da tela
//   openWindow aceita contentProtection (a janela não aparece em prints e gravações), x e y
//   ctx.host.setStartWithWindows(ligado) / getStartWithWindows()
//   ctx.host.on(evento, fn)                              "hotkey", "window-blur", "window-show", "window-hide",
//                                                        "view-shown" / "view-hidden" (a tela do módulo apareceu / sumiu)
//   openWindow aceita também clickThrough (cliques passam através) e topLevel: "screen-saver" (acima de jogos);
//   showWindow aceita placement "top-left" | "top-right" | "bottom-left" | "bottom-right" e focus: false
//   ctx.handle("tool:<nome>", fn)                     ferramenta para a IA declarada no module.json ("tools"); veja lib/tools-server.js
//   ctx.log(...)                                        registro em <dados do Hub>\logs\<id>.log
const fs = require("fs");
const path = require("path");

const port = process.parentPort;
const DIR = process.env.PIPHIN_MODULE_DIR;
const manifest = JSON.parse(fs.readFileSync(path.join(DIR, "module.json"), "utf8").replace(/^﻿/, ""));
const handlers = new Map();
const stops = [];
const pending = new Map();
const hostListeners = new Map();
let seq = 0;
let mod = null;

const post = (m) => port.postMessage(m);
const callHost = (fn, ...args) => new Promise((resolve, reject) => {
  const id = ++seq;
  pending.set(id, { resolve, reject });
  post({ t: "call", id, fn, args });
});

const logFile = path.join(process.env.PIPHIN_LOG_DIR, manifest.id + ".log");
function log(...args) {
  const line = `[${new Date().toISOString()}] ` + args.map((a) => (a instanceof Error ? a.stack : typeof a === "string" ? a : JSON.stringify(a))).join(" ") + "\n";
  try { fs.mkdirSync(path.dirname(logFile), { recursive: true }); fs.appendFileSync(logFile, line); } catch { /* sem disco */ }
}

const ctx = {
  id: manifest.id,
  version: manifest.version,
  dir: DIR,
  dataDir: process.env.PIPHIN_MODULE_DATA,
  handle: (ch, fn) => handlers.set(ch, fn),
  emit: (ch, data) => post({ t: "emit", ch, data }),
  onStop: (fn) => stops.push(fn),
  log,
  host: {
    saveDialog: (opts) => callHost("saveDialog", opts),
    openDialog: (opts) => callHost("openDialog", opts),
    notify: (title, body) => callHost("notify", title, body),
    focus: () => callHost("focus"),
    windowBounds: () => callHost("windowBounds"),
    keepAlive: (on, reason) => callHost("keepAlive", !!on, reason || ""),
    messageBox: (opts) => callHost("messageBox", opts),
    openPath: (p) => callHost("openPath", p),
    showItem: (p) => callHost("showItem", p),
    reloadView: () => callHost("reloadView"),
    registerHotkey: (acc) => callHost("registerHotkey", acc),
    unregisterHotkey: (acc) => callHost("unregisterHotkey", acc),
    openWindow: (name, opts) => callHost("openWindow", name, opts),
    showWindow: (name, opts) => callHost("showWindow", name, opts),
    hideWindow: (name) => callHost("hideWindow", name),
    setWindowBounds: (name, b) => callHost("setWindowBounds", name, b),
    setWindowOpacity: (name, v) => callHost("setWindowOpacity", name, v),
    windowState: (name) => callHost("windowState", name),
    sendToWindow: (name, ch, data) => callHost("sendToWindow", name, ch, data),
    reloadWindows: () => callHost("reloadWindows"),
    captureScreen: (opts) => callHost("captureScreen", opts),
    readClipboard: () => callHost("readClipboard"),
    writeClipboardImage: (b64) => callHost("writeClipboardImage", b64),
    displays: () => callHost("displays"),
    cursorPoint: () => callHost("cursorPoint"),
    listCaptureSources: (opts) => callHost("listCaptureSources", opts),
    setCaptureSource: (opts) => callHost("setCaptureSource", opts),
    getStartWithWindows: () => callHost("getStartWithWindows"),
    setStartWithWindows: (on) => callHost("setStartWithWindows", !!on),
    on: (name, fn) => {
      if (!hostListeners.has(name)) hostListeners.set(name, []);
      hostListeners.get(name).push(fn);
    },
  },
};

async function stop() {
  for (const fn of stops.reverse()) { try { await fn(); } catch (e) { log("onStop", e); } }
  try { if (mod && mod.deactivate) await mod.deactivate(); } catch (e) { log("deactivate", e); }
  process.exit(0);
}

port.on("message", async ({ data: m }) => {
  if (m.t === "invoke") {
    const fn = handlers.get(m.ch);
    if (!fn) return post({ t: "res", id: m.id, ok: false, error: `O módulo não responde a "${m.ch}"` });
    try { post({ t: "res", id: m.id, ok: true, data: await fn(...(m.args || [])) }); }
    catch (e) { post({ t: "res", id: m.id, ok: false, error: (e && e.message) || String(e) }); }
  } else if (m.t === "ret") {
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    m.ok ? p.resolve(m.data) : p.reject(new Error(m.error));
  } else if (m.t === "hostEvent") {
    for (const fn of hostListeners.get(m.name) || []) { try { await fn(m.data); } catch (e) { log("evento " + m.name, e); } }
  } else if (m.t === "stop") {
    stop();
  }
});

process.on("uncaughtException", (e) => log("erro não tratado", e));
process.on("unhandledRejection", (e) => log("promessa rejeitada", e));

(async () => {
  try {
    if (manifest.main) {
      mod = require(path.join(DIR, manifest.main));
      if (mod.activate) await mod.activate(ctx);
    }
    post({ t: "ready" });
  } catch (e) {
    log("activate", e);
    post({ t: "failed", error: (e && e.message) || String(e) });
  }
})();
