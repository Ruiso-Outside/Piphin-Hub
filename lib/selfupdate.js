// Atualização do próprio Hub: troca só a pasta resources\app (o .exe do Electron não muda,
// então o Controle Inteligente de Aplicativos continua aceitando).
const fs = require("fs");
const path = require("path");
const U = require("./util");
const sources = require("./sources");
const { download } = require("./download");

const SOURCE = { type: "github", repo: "Ruiso-Outside/Piphin-Hub", asset: "^hub-app-.*\\.zip$" };

async function check(app) {
  if (!app.isPackaged) return null;
  try {
    const latest = await sources.latest({ source: SOURCE });
    return U.cmpVersion(latest.version, app.getVersion()) > 0 ? latest : null;
  } catch { return null; }
}

async function apply(app, latest, onProgress) {
  const appDir = app.getAppPath(); // ...\resources\app
  const tmp = path.join(app.getPath("temp"), "piphin-hub-" + latest.version + ".zip");
  await download(latest.url, tmp, { sha256: latest.sha256, onProgress });
  const staging = appDir + ".new";
  const old = appDir + ".old";
  fs.rmSync(staging, { recursive: true, force: true });
  fs.rmSync(old, { recursive: true, force: true });
  await U.extractZip(tmp, staging);
  fs.rmSync(tmp, { force: true });
  if (!fs.existsSync(path.join(staging, "package.json")) || !fs.existsSync(path.join(staging, "main.js")))
    throw new Error("Pacote de atualização inválido");
  fs.renameSync(appDir, old);
  try { fs.renameSync(staging, appDir); } catch (e) { fs.renameSync(old, appDir); throw e; }
  app.relaunch();
  app.exit(0);
}

// a pasta antiga fica para trás até a próxima abertura
function cleanup(app) {
  if (!app.isPackaged) return;
  fs.rm(app.getAppPath() + ".old", { recursive: true, force: true }, () => {});
}

module.exports = { check, apply, cleanup, SOURCE };
