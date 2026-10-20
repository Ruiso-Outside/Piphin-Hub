// Atualização automática do próprio Hub, igual à do Piphin LLM: consulta o Release do GitHub,
// baixa em segundo plano, confere o SHA-256 e deixa pronto em resources\app.new.
// A troca (só a pasta resources\app; o .exe do Electron não muda, então o Controle Inteligente
// de Aplicativos continua aceitando) acontece ao reiniciar agora ou ao fechar o Hub.
const fs = require("fs");
const path = require("path");
const U = require("./util");
const sources = require("./sources");
const { download } = require("./download");

const SOURCE = { type: "github", repo: "Ruiso-Outside/Piphin-Hub", asset: "^hub-app-.*\\.zip$" };

const appDir = (app) => app.getAppPath(); // ...\resources\app
const stagingDir = (app) => appDir(app) + ".new";
const oldDir = (app) => appDir(app) + ".old";

async function check(app, { force } = {}) {
  if (!app.isPackaged) return null;
  try {
    const latest = await sources.latest({ source: SOURCE }, { force });
    return U.cmpVersion(latest.version, app.getVersion()) > 0 ? latest : null;
  } catch { return null; }
}

// Baixa e extrai ao lado; devolve a versão pronta para aplicar
async function prepare(app, latest, onProgress) {
  const staging = stagingDir(app);
  const ready = U.readJson(path.join(staging, "package.json"), null);
  if (ready && ready.version === latest.version && fs.existsSync(path.join(staging, "main.js"))) return latest.version;

  const tmp = path.join(app.getPath("temp"), "piphin-hub-" + latest.version + ".zip");
  await download(latest.url, tmp, { sha256: latest.sha256, onProgress });
  fs.rmSync(staging, { recursive: true, force: true });
  try {
    await U.extractZip(tmp, staging);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  const pkg = U.readJson(path.join(staging, "package.json"), null);
  if (!pkg || pkg.version !== latest.version || !fs.existsSync(path.join(staging, "main.js"))) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw new Error("Pacote de atualização inválido");
  }
  return pkg.version;
}

// Troca resources\app pela versão baixada; se algo falhar, a versão atual continua
function swap(app) {
  const dir = appDir(app), staging = stagingDir(app), old = oldDir(app);
  if (!fs.existsSync(path.join(staging, "main.js"))) return false;
  fs.rmSync(old, { recursive: true, force: true });
  fs.renameSync(dir, old);
  try { fs.renameSync(staging, dir); } catch (e) { fs.renameSync(old, dir); throw e; }
  return true;
}

// hidden: volta escondido perto do relógio (atualização aplicada sem interromper ninguém)
function restartNow(app, { hidden = false } = {}) {
  if (!swap(app)) return;
  const args = process.argv.slice(1).filter((a) => a !== "--hidden");
  app.relaunch({ args: hidden ? [...args, "--hidden"] : args });
  app.exit(0);
}

// Ao abrir: se ficou uma versão baixada e não aplicada (ex.: o PC desligou com o Hub aberto), aplica agora
function applyStagedOnStart(app) {
  if (!app.isPackaged) return false;
  const staged = U.readJson(path.join(stagingDir(app), "package.json"), null);
  if (!staged || U.cmpVersion(staged.version, app.getVersion()) <= 0) return false;
  try { restartNow(app, { hidden: process.argv.includes("--hidden") }); return true; }
  catch { return false; } // não deu para trocar: segue na versão atual
}

// Ao abrir: apaga a versão anterior e downloads incompletos ou já ultrapassados
function cleanup(app) {
  if (!app.isPackaged) return;
  fs.rm(oldDir(app), { recursive: true, force: true }, () => {});
  const staged = U.readJson(path.join(stagingDir(app), "package.json"), null);
  if (!staged || U.cmpVersion(staged.version, app.getVersion()) <= 0) fs.rm(stagingDir(app), { recursive: true, force: true }, () => {});
}

module.exports = { check, prepare, swap, restartNow, applyStagedOnStart, cleanup, SOURCE };
