// Atalhos de programas: .lnk no Windows (Menu Iniciar e Área de Trabalho), .desktop no Linux
// (~/.local/share/applications e a pasta da Área de Trabalho) e o "abrir ao entrar" do Linux (~/.config/autostart).
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");

const IS_WIN = process.platform === "win32";
const home = os.homedir();
const dataHome = () => process.env.XDG_DATA_HOME || path.join(home, ".local", "share");
const configHome = () => process.env.XDG_CONFIG_HOME || path.join(home, ".config");

// pasta do Menu Iniciar (Windows) ou dos aplicativos do menu (Linux)
const menuDir = () => (IS_WIN ? path.join(process.env.APPDATA || "", "Microsoft", "Windows", "Start Menu", "Programs") : path.join(dataHome(), "applications"));

// Área de Trabalho do Linux: a do user-dirs.dirs (ex.: "Área de Trabalho"), senão ~/Desktop
function linuxDesktopDir() {
  try {
    const m = /^XDG_DESKTOP_DIR="?([^"\n]+)"?/m.exec(fs.readFileSync(path.join(configHome(), "user-dirs.dirs"), "utf8"));
    if (m) return m[1].replace(/^\$HOME/, home);
  } catch { /* sem o arquivo */ }
  return path.join(home, "Desktop");
}

// nome de arquivo .desktop seguro a partir do nome do app
const slug = (name) => { const s = String(name).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""); return s.startsWith("piphin-") ? s : "piphin-" + s; };
const fileName = (name) => (IS_WIN ? name + ".lnk" : slug(name) + ".desktop");

// aspas do campo Exec do .desktop (especificação freedesktop)
const execQuote = (s) => (/^[\w./+-]+$/.test(s) ? s : '"' + String(s).replace(/(["`$\\])/g, "\\$1") + '"');

function desktopEntry({ name, target, args = [], icon, description, cwd, wmClass }) {
  return ["[Desktop Entry]", "Type=Application", `Name=${name}`, description ? `Comment=${String(description).replace(/\n/g, " ")}` : null,
    `Exec=${[target, ...args].map(execQuote).join(" ")}`, cwd ? `Path=${cwd}` : null, icon ? `Icon=${icon}` : null,
    "Terminal=false", "Categories=Utility;", wmClass ? `StartupWMClass=${wmClass}` : null, "X-Piphin=1", ""].filter((l) => l !== null).join("\n");
}

// Cria ou atualiza o atalho. o = { name, target, args, icon, iconPng, description, cwd, appUserModelId, wmClass }
function write(shell, file, o) {
  if (IS_WIN) {
    const opts = { target: o.target, cwd: o.cwd || path.dirname(o.target), description: o.description || o.name, icon: o.icon || o.target, iconIndex: 0,
      ...(o.args && o.args.length ? { args: o.args.join(" ") } : {}), ...(o.appUserModelId ? { appUserModelId: o.appUserModelId } : {}) };
    return shell.writeShortcutLink(file, fs.existsSync(file) ? "replace" : "create", opts);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, desktopEntry({ ...o, icon: o.iconPng || o.icon }), { mode: 0o755 });
  // GNOME/Zorin: atalho da Área de Trabalho só abre se for marcado como confiável
  if (path.dirname(file) === linuxDesktopDir()) execFile("gio", ["set", file, "metadata::trusted", "true"], () => {});
  return true;
}

// Para onde o atalho aponta (null se não for possível ler)
function readTarget(shell, file) {
  if (IS_WIN) return shell.readShortcutLink(file).target;
  const m = /^Exec=(.*)$/m.exec(fs.readFileSync(file, "utf8"));
  if (!m) return null;
  const e = m[1].trim();
  const q = /^"((?:\\.|[^"])*)"/.exec(e);
  return q ? q[1].replace(/\\(.)/g, "$1") : e.split(/\s+/)[0];
}

// "Abrir ao entrar" no Linux (o Electron só faz isso no Windows e no macOS)
function setLinuxAutostart(id, on, o) {
  const file = path.join(configHome(), "autostart", id + ".desktop");
  if (!on) { try { fs.rmSync(file, { force: true }); } catch { /* já não existe */ } return; }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, desktopEntry(o) + "X-GNOME-Autostart-enabled=true\n");
}

module.exports = { IS_WIN, menuDir, linuxDesktopDir, fileName, write, readTarget, setLinuxAutostart, desktopEntry };
