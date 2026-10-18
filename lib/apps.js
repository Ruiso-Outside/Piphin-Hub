// Núcleo do Hub: catálogo, detecção do que está instalado e as ações (instalar, atualizar, abrir...).
const fs = require("fs");
const os = require("os");
const path = require("path");
const { EventEmitter } = require("events");
const U = require("./util");
const sources = require("./sources");
const { download } = require("./download");

const DEFAULT_CATALOG_URL = "https://raw.githubusercontent.com/Ruiso-Outside/Piphin-Hub/main/catalog.json";

class Hub extends EventEmitter {
  constructor({ appDir, userDir, shell, desktopDir }) {
    super();
    this.appDir = appDir; // pasta do Hub (catálogo e ícones embutidos)
    this.userDir = userDir; // %APPDATA%\Piphin Hub
    this.shell = shell; // electron.shell (atalhos, lixeira, abrir)
    this.desktopDir = desktopDir || path.join(os.homedir(), "Desktop");
    this.stateFile = path.join(userDir, "state.json");
    this.cacheDir = path.join(process.env.LOCALAPPDATA || os.tmpdir(), "Piphin Hub", "downloads");
    this.state = U.readJson(this.stateFile, {});
    this.state.settings = {
      libraryDir: path.join(process.env.LOCALAPPDATA || os.homedir(), "Programs"),
      catalogUrl: DEFAULT_CATALOG_URL,
      desktopShortcuts: true,
      checkOnStart: true,
      autoUpdate: false,
      githubToken: "",
      ...(this.state.settings || {}),
    };
    this.state.installed = this.state.installed || {}; // id -> { dir, version, at }
    this.state.customApps = this.state.customApps || [];
    this.remote = U.readJson(path.join(userDir, "catalog-cache.json"), null);
    this.status = {}; // id -> status calculado
    this.jobs = new Map(); // id -> { abort, phase, pct, text }
  }

  save() { U.writeJson(this.stateFile, this.state); }
  get settings() { return this.state.settings; }

  setSettings(patch) {
    const allowed = ["libraryDir", "catalogUrl", "desktopShortcuts", "checkOnStart", "autoUpdate", "githubToken"];
    for (const k of allowed) if (k in patch) this.state.settings[k] = patch[k];
    this.save();
  }

  // ---------------------------------------------------------------- catálogo
  // Embutido < remoto (GitHub) < adicionados pelo usuário. O mesmo "id" sobrescreve.
  catalog() {
    const map = new Map();
    const add = (list, origin) => {
      for (const a of list || []) {
        if (!a || !a.id || !a.name || !a.source || !a.install) continue;
        map.set(a.id, { ...a, origin });
      }
    };
    add(U.readJson(path.join(this.appDir, "catalog.json"), {}).apps, "builtin");
    if (this.remote) add(this.remote.apps, "remote");
    add(this.state.customApps, "custom");
    return [...map.values()];
  }

  app(id) {
    const a = this.catalog().find((x) => x.id === id);
    if (!a) throw new Error("App não encontrado no catálogo: " + id);
    return a;
  }

  async refreshRemoteCatalog() {
    const url = this.settings.catalogUrl;
    if (!url) return;
    try {
      const data = await sources.getJson(url);
      if (data && Array.isArray(data.apps)) {
        this.remote = data;
        U.writeJson(path.join(this.userDir, "catalog-cache.json"), data);
      }
    } catch { /* sem internet ou catálogo ainda não publicado: fica o embutido/cache */ }
  }

  // ---------------------------------------------------------------- detecção
  async detect(app) {
    const inst = app.install;
    const rec = this.state.installed[app.id];
    let dir = null, version = "", uninstall = null;

    if (inst.type === "installer" && inst.uninstallKey) {
      const e = await U.uninstallEntry(inst.uninstallKey);
      if (e) {
        dir = e.InstallLocation || (e.DisplayIcon ? path.dirname(e.DisplayIcon.replace(/,\d+$/, "").replace(/"/g, "")) : null);
        version = U.cleanVersion(e.DisplayVersion);
        uninstall = e.QuietUninstallString || e.UninstallString || null;
      }
    }
    if (!dir && rec && rec.dir) dir = rec.dir;
    if (!dir && inst.type === "portable") {
      const def = path.join(this.settings.libraryDir, inst.folder || app.name);
      if (fs.existsSync(path.join(def, inst.exe))) dir = def;
    }
    if (!dir) dir = this.findByShortcut(app); // instalado antes do Hub existir

    const exe = dir ? path.join(dir, inst.exe) : null;
    if (!exe || !fs.existsSync(exe)) return { installed: false };

    // a versão real pode mudar sem o Hub (apps que se atualizam sozinhos)
    if (inst.versionFile) {
      const v = U.readJson(path.join(dir, inst.versionFile), null);
      if (v && v.version) version = U.cleanVersion(v.version);
    }
    if (!version && rec && rec.dir === dir) version = rec.version;
    if (!version) version = await U.exeVersion(exe);
    return { installed: true, dir, exe, version, uninstall };
  }

  shortcutDirs() {
    const pd = process.env.ProgramData || "C:\\ProgramData";
    return [
      path.join(process.env.APPDATA || "", "Microsoft", "Windows", "Start Menu", "Programs"),
      path.join(pd, "Microsoft", "Windows", "Start Menu", "Programs"),
      this.desktopDir,
      path.join(process.env.PUBLIC || "C:\\Users\\Public", "Desktop"),
    ];
  }

  // Procura um atalho do app (Menu Iniciar / Área de Trabalho) que aponte para o executável
  findByShortcut(app) {
    if (!this.shell.readShortcutLink) return null;
    const names = [...new Set([app.install.shortcutName, app.name, ...(app.install.shortcutAliases || [])].filter(Boolean))];
    for (const d of this.shortcutDirs()) {
      for (const n of names) {
        const lnk = path.join(d, n + ".lnk");
        if (!fs.existsSync(lnk)) continue;
        try {
          const t = this.shell.readShortcutLink(lnk).target;
          if (t && path.basename(t).toLowerCase() === app.install.exe.toLowerCase() && fs.existsSync(t)) {
            const dir = path.dirname(t);
            this.state.installed[app.id] = { dir, version: "", at: new Date().toISOString(), found: "shortcut" };
            this.save();
            return dir;
          }
        } catch { /* atalho quebrado */ }
      }
    }
    return null;
  }

  async refresh({ force = false, ids } = {}) {
    if (force || !this.remote) await this.refreshRemoteCatalog();
    const apps = this.catalog().filter((a) => !ids || ids.includes(a.id));
    await Promise.all(apps.map(async (a) => {
      const s = { id: a.id };
      try { Object.assign(s, await this.detect(a)); } catch (e) { s.installed = false; s.detectError = e.message; }
      try {
        s.latest = await sources.latest(a, { token: this.settings.githubToken, force });
      } catch (e) { s.latestError = e.message; }
      s.updateAvailable = !!(s.installed && s.latest && U.cmpVersion(s.latest.version, s.version) > 0);
      this.status[a.id] = s;
    }));
    this.emit("changed");
    return this.snapshot();
  }

  snapshot() {
    return {
      settings: { ...this.settings, githubToken: this.settings.githubToken ? "••••" : "" },
      apps: this.catalog().map((a) => ({
        ...a,
        iconUrl: this.iconUrl(a),
        status: this.status[a.id] || null,
        job: this.jobs.has(a.id) ? { ...this.jobs.get(a.id), abort: undefined } : null,
      })),
    };
  }

  iconUrl(a) {
    if (!a.icon) return null;
    if (/^(https?|data):/.test(a.icon)) return a.icon;
    const p = path.isAbsolute(a.icon) ? a.icon : path.join(this.appDir, a.icon);
    return fs.existsSync(p) ? "file:///" + p.replace(/\\/g, "/") : null;
  }

  // ---------------------------------------------------------------- tarefas
  progress(id, patch) {
    const j = this.jobs.get(id);
    if (!j) return;
    Object.assign(j, patch);
    this.emit("progress", { id, phase: j.phase, pct: j.pct, text: j.text });
  }

  async runJob(id, fn) {
    if (this.jobs.has(id)) throw new Error("Já existe uma tarefa em andamento para este app");
    const ctrl = new AbortController();
    this.jobs.set(id, { abort: ctrl, phase: "start", pct: null, text: "Preparando..." });
    this.emit("changed");
    try {
      return await fn(ctrl.signal);
    } finally {
      this.jobs.delete(id);
      await this.refresh({ ids: [id] }).catch(() => {});
    }
  }

  cancel(id) {
    const j = this.jobs.get(id);
    if (j) j.abort.abort();
  }

  async fetchPackage(app, latest, signal) {
    if (latest.path) return { file: latest.path, temp: false }; // origem local: usa direto
    fs.mkdirSync(this.cacheDir, { recursive: true });
    const dest = path.join(this.cacheDir, latest.fileName);
    const mb = (n) => (n / 1048576).toFixed(1);
    await download(latest.url, dest, {
      signal,
      sha256: latest.sha256,
      token: this.settings.githubToken,
      onProgress: ({ done, total, speed }) => this.progress(app.id, {
        phase: "download",
        pct: total ? done / total : null,
        text: `Baixando ${mb(done)} de ${mb(total)} MB` + (speed ? ` · ${mb(speed)} MB/s` : ""),
      }),
    });
    return { file: dest, temp: true };
  }

  // Fecha o app antes de trocar os arquivos (o renderer já confirmou com o usuário)
  async ensureClosed(app, exe, closeIfRunning) {
    const pids = await U.runningPids(exe || app.install.exe);
    if (!pids.length) return;
    if (!closeIfRunning) throw Object.assign(new Error(`${app.name} está aberto`), { code: "RUNNING" });
    this.progress(app.id, { phase: "close", pct: null, text: `Fechando ${app.name}...` });
    await U.killPids(pids);
    for (let i = 0; i < 20 && (await U.runningPids(exe || app.install.exe)).length; i++) await new Promise((r) => setTimeout(r, 300));
    if ((await U.runningPids(exe || app.install.exe)).length)
      throw new Error(`Não foi possível fechar o ${app.name}. Feche-o manualmente e tente de novo.`);
  }

  install(id, { closeIfRunning = false } = {}) {
    const app = this.app(id);
    return this.runJob(id, async (signal) => {
      this.progress(id, { phase: "check", text: "Consultando a versão mais recente..." });
      const latest = await sources.latest(app, { token: this.settings.githubToken, force: true });
      const cur = await this.detect(app);
      if (cur.installed) await this.ensureClosed(app, cur.exe, closeIfRunning);
      const pkg = await this.fetchPackage(app, latest, signal);
      try {
        if (app.install.type === "portable") await this.installPortable(app, latest, pkg.file, cur);
        else if (app.install.type === "installer") await this.installInstaller(app, latest, pkg.file, cur);
        else throw new Error("Tipo de instalação desconhecido: " + app.install.type);
      } finally {
        if (pkg.temp) fs.rm(pkg.file, { force: true }, () => {});
      }
      return { version: latest.version };
    });
  }

  async installPortable(app, latest, file, cur) {
    const inst = app.install;
    const target = cur.installed ? cur.dir : path.join(this.settings.libraryDir, inst.folder || app.name);
    const staging = target + ".hub-new";
    const old = target + ".hub-old";
    fs.rmSync(staging, { recursive: true, force: true });
    fs.rmSync(old, { recursive: true, force: true });

    this.progress(app.id, { phase: "extract", pct: null, text: "Extraindo arquivos..." });
    if (/\.zip$/i.test(file)) await U.extractZip(file, staging);
    else { fs.mkdirSync(staging, { recursive: true }); fs.copyFileSync(file, path.join(staging, inst.exe)); }
    if (!fs.existsSync(path.join(staging, inst.exe))) {
      fs.rmSync(staging, { recursive: true, force: true });
      throw new Error(`O pacote não contém ${inst.exe}`);
    }

    this.progress(app.id, { phase: "apply", text: "Aplicando..." });
    if (fs.existsSync(target)) {
      // pastas/arquivos do usuário que ficam de uma versão para outra
      for (const keep of inst.keep || []) {
        const from = path.join(target, keep);
        if (fs.existsSync(from)) {
          fs.rmSync(path.join(staging, keep), { recursive: true, force: true });
          fs.mkdirSync(path.dirname(path.join(staging, keep)), { recursive: true });
          fs.renameSync(from, path.join(staging, keep));
        }
      }
      fs.renameSync(target, old);
    }
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.renameSync(staging, target);
    } catch (e) {
      if (fs.existsSync(old)) fs.renameSync(old, target); // volta a versão anterior
      throw e;
    }
    fs.rm(old, { recursive: true, force: true }, () => {});

    this.state.installed[app.id] = { dir: target, version: latest.version, at: new Date().toISOString() };
    this.save();
    this.createShortcuts(app, path.join(target, inst.exe));
  }

  async installInstaller(app, latest, file, cur) {
    const inst = app.install;
    const args = [...(inst.silentArgs || [])];
    if (inst.dirArg && cur.installed && cur.dir) args.push(inst.dirArg.replace("{dir}", cur.dir));
    this.progress(app.id, { phase: "install", pct: null, text: "Instalando..." });
    try {
      await U.run(file, args, { timeout: 15 * 60 * 1000 });
    } catch (e) {
      throw new Error(blockedHint(e) || `O instalador terminou com erro (código ${e.code ?? "?"})`);
    }
    const now = await this.detect(app);
    if (!now.installed) throw new Error("O instalador terminou, mas o app não foi encontrado.");
    this.state.installed[app.id] = { dir: now.dir, version: now.version || latest.version, at: new Date().toISOString() };
    this.save();
  }

  createShortcuts(app, exe) {
    const name = (app.install.shortcutName || app.name) + ".lnk";
    const opts = { target: exe, cwd: path.dirname(exe), description: app.description || app.name, icon: exe, iconIndex: 0 };
    const start = path.join(process.env.APPDATA, "Microsoft", "Windows", "Start Menu", "Programs", name);
    try { this.shell.writeShortcutLink(start, fs.existsSync(start) ? "update" : "create", opts); } catch { /* sem permissão */ }
    if (this.settings.desktopShortcuts) {
      const desk = path.join(this.desktopDir, name);
      try { this.shell.writeShortcutLink(desk, fs.existsSync(desk) ? "update" : "create", opts); } catch { /* idem */ }
    }
  }

  removeShortcuts(app) {
    const name = (app.install.shortcutName || app.name) + ".lnk";
    for (const p of [path.join(process.env.APPDATA, "Microsoft", "Windows", "Start Menu", "Programs", name), path.join(this.desktopDir, name)])
      try { fs.rmSync(p, { force: true }); } catch { /* ignora */ }
  }

  uninstall(id, { closeIfRunning = false } = {}) {
    const app = this.app(id);
    return this.runJob(id, async () => {
      const cur = await this.detect(app);
      if (!cur.installed) throw new Error("O app não está instalado");
      await this.ensureClosed(app, cur.exe, closeIfRunning);
      this.progress(id, { phase: "uninstall", text: "Desinstalando..." });
      if (app.install.type === "installer" && cur.uninstall) {
        const cmd = U.splitCommand(cur.uninstall);
        await U.run(cmd.file, cmd.args, { timeout: 10 * 60 * 1000 });
        // o desinstalador pode se copiar para a pasta temporária e terminar antes de apagar tudo
        for (let i = 0; i < 30 && fs.existsSync(cur.exe); i++) await new Promise((r) => setTimeout(r, 500));
      } else {
        // vai para a Lixeira (dá para recuperar)
        await this.shell.trashItem(cur.dir);
        this.removeShortcuts(app);
      }
      delete this.state.installed[id];
      this.save();
    });
  }

  async launch(id) {
    const app = this.app(id);
    const cur = await this.detect(app);
    if (!cur.installed) throw new Error("O app não está instalado");
    const err = await this.shell.openPath(cur.exe);
    if (err) throw new Error(blockedHint({ message: err }) || err);
  }

  // Aponta uma instalação que já existia (feita fora do Hub)
  async locate(id, dir) {
    const app = this.app(id);
    if (!fs.existsSync(path.join(dir, app.install.exe)))
      throw new Error(`Essa pasta não contém ${app.install.exe}`);
    this.state.installed[id] = { dir, version: "", at: new Date().toISOString() };
    this.save();
    const v = await this.detect(app);
    this.state.installed[id].version = v.version || "";
    this.save();
    await this.refresh({ ids: [id] });
  }

  forget(id) {
    delete this.state.installed[id];
    this.save();
    return this.refresh({ ids: [id] });
  }

  // ---------------------------------------------------------------- apps do usuário
  addCustomApp(def) {
    const a = normalizeCustom(def);
    this.state.customApps = this.state.customApps.filter((x) => x.id !== a.id).concat(a);
    this.save();
    return this.refresh({ ids: [a.id] });
  }

  removeCustomApp(id) {
    this.state.customApps = this.state.customApps.filter((x) => x.id !== id);
    delete this.status[id];
    this.save();
    this.emit("changed");
  }
}

function normalizeCustom(d) {
  const name = String(d.name || "").trim();
  if (!name) throw new Error("Informe o nome do app");
  const id = String(d.id || name).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const exe = String(d.exe || "").trim();
  if (!exe) throw new Error("Informe o nome do executável (ex.: MeuApp.exe)");
  const asset = String(d.asset || "").trim();
  try { new RegExp(asset); } catch { throw new Error("O padrão do arquivo não é uma expressão regular válida"); }
  let source;
  if (d.sourceType === "local") {
    if (!d.localPath || !fs.existsSync(d.localPath)) throw new Error("A pasta local não existe");
    source = { type: "local", path: d.localPath, asset: asset || "\\.(zip|exe)$" };
  } else {
    const repo = String(d.repo || "").trim().replace(/^https?:\/\/github\.com\//i, "").replace(/\/+$/, "").replace(/\.git$/, "");
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("Repositório inválido (use dono/repositório)");
    source = { type: "github", repo, asset: asset || "\\.(zip|exe)$" };
  }
  const install = d.installType === "installer"
    ? { type: "installer", exe, silentArgs: String(d.silentArgs || "").match(/"[^"]*"|\S+/g) || [], uninstallKey: d.uninstallKey || undefined }
    : { type: "portable", exe, folder: name };
  return { id, name, description: String(d.description || ""), category: String(d.category || "Outros"), icon: d.icon || undefined, source, install };
}

function blockedHint(e) {
  const m = String((e && (e.message || e.stderr)) || "");
  if (/4551|Application Control|Controle de Aplicativo|bloque/i.test(m) || (e && e.code === "EACCES"))
    return "O Windows bloqueou este programa (Controle Inteligente de Aplicativos). Ele precisa de assinatura digital para rodar com essa proteção ligada.";
  return null;
}

module.exports = { Hub };
