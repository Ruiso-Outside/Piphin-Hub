const { contextBridge, ipcRenderer } = require("electron");

const call = (ch) => (...args) => ipcRenderer.invoke(ch, ...args);

contextBridge.exposeInMainWorld("hub", {
  snapshot: call("hub:snapshot"),
  refresh: call("hub:refresh"),
  install: call("hub:install"),
  cancel: call("hub:cancel"),
  uninstall: call("hub:uninstall"),
  launch: call("hub:launch"),
  openFolder: call("hub:openFolder"),
  openUrl: call("hub:openUrl"),
  locate: call("hub:locate"),
  forget: call("hub:forget"),
  pickFolder: call("hub:pickFolder"),
  setSettings: call("hub:setSettings"),
  hubShortcuts: call("hub:hubShortcuts"),
  addCustom: call("hub:addCustom"),
  removeCustom: call("hub:removeCustom"),
  folderSize: call("hub:folderSize"),
  selfUpdate: call("hub:selfUpdate"),
  onChanged: (fn) => ipcRenderer.on("hub:changed", () => fn()),
  onProgress: (fn) => ipcRenderer.on("hub:progress", (_e, p) => fn(p)),
  onSelfProgress: (fn) => ipcRenderer.on("hub:selfProgress", (_e, p) => fn(p)),
});
