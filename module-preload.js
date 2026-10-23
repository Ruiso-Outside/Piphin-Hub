// Ponte da interface de um módulo com o motor dele (e com o Hub).
//   piphin.invoke(canal, ...args)  -> { ok, data } | { ok:false, error }
//   piphin.on(canal, fn)           eventos enviados pelo motor (ctx.emit)
//   piphin.info                    { id, name, version, hubVersion, lang, locale }
// A tela é traduzida sozinha pelo Hub com o dicionário do módulo (i18n/<idioma>.json, veja lib/i18n.js).
const { contextBridge, ipcRenderer, webFrame } = require("electron");

try { const s = ipcRenderer.sendSync("mod:i18n"); if (s) webFrame.executeJavaScript(s); } catch { /* fica em português */ }

const listeners = new Map();
ipcRenderer.on("mod:event", (_e, ch, data) => {
  for (const fn of listeners.get(ch) || []) { try { fn(data); } catch (err) { console.error(err); } }
});

contextBridge.exposeInMainWorld("piphin", {
  info: ipcRenderer.sendSync("mod:info"),
  invoke: (ch, ...args) => ipcRenderer.invoke("mod:invoke", ch, args),
  on: (ch, fn) => {
    if (!listeners.has(ch)) listeners.set(ch, new Set());
    listeners.get(ch).add(fn);
    return () => listeners.get(ch).delete(fn);
  },
});
