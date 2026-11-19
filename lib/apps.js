// Núcleo do Hub: catálogo, detecção do que está instalado e as ações (instalar, atualizar, abrir...).
const fs = require("fs");
const os = require("os");
const path = require("path");
const { EventEmitter } = require("events");
const U = require("./util");
const sources = require("./sources");
const { download } = require("./download");
const SC = require("./shortcuts");
const SI = require("./script-install");
const GH = require("./github-auth");
const { spawn } = require("child_process");

// Entradas do catálogo podem ter uma versão por sistema: "linux": { source, install, ... } substitui os campos no Linux,
// e "platforms": ["win32"] esconde o app/módulo nos outros sistemas (Hubs antigos, só de Windows, ignoram os dois).
const PLATFORM_KEY = process.platform === "win32" ? "win" : process.platform;
function forPlatform(a) {
  if (!a) return null;
  const o = a[PLATFORM_KEY] && typeof a[PLATFORM_KEY] === "object" ? { ...a, ...a[PLATFORM_KEY] } : a;
  if (Array.isArray(o.platforms) && !o.platforms.includes(process.platform)) return null;
  return o;
}

const DEFAULT_CATALOG_URL = "https://raw.githubusercontent.com/Ruiso-Outside/ArasakaCentral/main/catalog.json";

class Hub extends EventEmitter {
  constructor({ appDir, userDir, shell, desktopDir, modules }) {
    super();
    this.appDir = appDir; // pasta do Hub (catálogo e ícones embutidos)
    this.userDir = userDir; // %APPDATA%\Piphin Hub (Linux: ~/.config/Piphin Hub)
    this.shell = shell; // electron.shell (atalhos, lixeira, abrir)
    this.desktopDir = desktopDir || path.join(os.homedir(), "Desktop");
    this.modules = modules || null; // ModuleHost (lib/modules.js); ausente nos testes sem interface
    this.modulesDir = modules ? modules.dir : path.join(userDir, "modules");
    this.stateFile = path.join(userDir, "state.json");
    this.cacheDir = path.join(U.cacheDir(), "Piphin Hub", "downloads");
    this.state = U.readJson(this.stateFile, {});
    this.state.settings = {
      libraryDir: U.programsDir(),
      catalogUrl: DEFAULT_CATALOG_URL,
      desktopShortcuts: true,
      checkOnStart: true,
      autoUpdate: false,
      githubToken: "",
      githubAuth: null, // login pelo "Entrar com GitHub": { login, refreshToken, expiresAt, refreshExpiresAt }
      startWithWindows: false,
      language: "auto", // "auto" = idioma do Windows; ou um código de lib/i18n.js
      ...(this.state.settings || {}),
    };
    this.state.installed = this.state.installed || {}; // id -> { dir, version, at }
    this.state.customApps = this.state.customApps || [];
    this.state.previous = this.state.previous || {}; // id -> { version, at }: a versão de antes da última atualização
    this.state.skipped = this.state.skipped || {}; // id -> versão que a pessoa voltou e não quer receber de novo
    this.prevDir = path.join(userDir, "previous");
    this.remote = U.readJson(path.join(userDir, "catalog-cache.json"), null);
    this.status = {}; // id -> status calculado
    this.jobs = new Map(); // id -> { abort, phase, pct, text }
    this.unavailableModules = new Set(); // módulos ainda sem Release: mostra o app separado no lugar
  }

  save() { U.writeJson(this.stateFile, this.state); }
  get settings() { return this.state.settings; }

  setSettings(patch) {
    const allowed = ["libraryDir", "catalogUrl", "desktopShortcuts", "checkOnStart", "autoUpdate", "githubToken", "startWithWindows", "language", "devMode", "devWorkspace"];
    for (const k of allowed) if (k in patch) this.state.settings[k] = patch[k];
    if ("githubToken" in patch) this.state.settings.githubAuth = null; // token colado à mão substitui o login
    this.save();
  }

  // ---------------------------------------------------------------- catálogo
  // Embutido < remoto (GitHub) < adicionados pelo usuário. O mesmo "id" sobrescreve,
  // e um módulo substitui o app separado de mesmo id (ex.: Piphin Macro), a não ser que o módulo
  // ainda não tenha sido publicado e não esteja instalado: aí continua aparecendo o app separado.
  catalog({ all = false, appsOnly = false } = {}) {
    const map = new Map();
    const add = (list, origin, kind) => {
      for (const raw of list || []) {
        const a = forPlatform(raw);
        if (!a || !a.id || !a.name || !a.source || (kind === "theme" && !a.install)) continue;
        if (kind === "theme") { map.set(a.id, { ...a, kind, origin }); continue; }
        if (kind === "module") {
          if (appsOnly || (!all && this.unavailableModules.has(a.id) && map.has(a.id))) continue;
          map.set(a.id, { ...a, kind, install: { ...(a.install || {}), type: "module" }, origin });
        }
        else if (a.install) map.set(a.id, { ...a, kind: a.install.type === "module" ? "module" : "app", origin });
      }
    };
    const builtin = U.readJson(path.join(this.appDir, "catalog.json"), {});
    add(builtin.apps, "builtin");
    if (this.remote) add(this.remote.apps, "remote");
    add(builtin.modules, "builtin", "module");
    if (this.remote) add(this.remote.modules, "remote", "module");
    // temas do sistema (Hub 1.11.0): instalados pelo script do próprio tema; Hubs antigos ignoram a lista
    add(builtin.themes, "builtin", "theme");
    if (this.remote) add(this.remote.themes, "remote", "theme");
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
    if (inst.type === "module") {
      const dir = path.join(this.modulesDir, app.id);
      const mf = U.readJson(path.join(dir, "module.json"), null);
      if (!mf) return { installed: false };
      const st = this.modules ? this.modules.status().find((m) => m.id === app.id) : null;
      return { installed: true, dir, version: U.cleanVersion(mf.version), moduleState: st ? st.state : "stopped", moduleError: st ? st.error : null };
    }
    const rec = this.state.installed[app.id];
    if (inst.type === "script") return this.detectScript(app, rec);
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

  // App/tema com instalador próprio: "detect" diz se está instalado (vale também para o que foi instalado fora
  // da Central), "versionFile" diz a versão, e a pasta do pacote fica guardada para desinstalar depois
  detectScript(app, rec) {
    const inst = app.install;
    const mark = SI.expandPath(inst.detect);
    if (!mark || !fs.existsSync(mark)) return { installed: false };
    const pkgDir = rec && rec.dir && fs.existsSync(rec.dir) ? rec.dir : null;
    const version = SI.readVersion(inst) || (rec && rec.version) || "";
    const exe = SI.expandPath(inst.launch);
    const verFile = SI.expandPath(inst.versionFile);
    return { installed: true, dir: pkgDir || (verFile && fs.existsSync(verFile) ? path.dirname(verFile) : path.dirname(mark)), pkgDir, exe: exe && fs.existsSync(exe) ? exe : null, version };
  }

  shortcutDirs() {
    if (!U.IS_WIN) return [SC.menuDir(), SC.linuxDesktopDir()];
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
    if (U.IS_WIN && !this.shell.readShortcutLink) return null;
    const names = [...new Set([app.install.shortcutName, app.name, ...(app.install.shortcutAliases || [])].filter(Boolean))];
    for (const d of this.shortcutDirs()) {
      for (const n of names) {
        const lnk = path.join(d, SC.fileName(n));
        if (!fs.existsSync(lnk)) continue;
        try {
          const t = SC.readTarget(this.shell, lnk);
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

  // ---------------------------------------------------------------- login do GitHub
  githubClientId() {
    const builtin = U.readJson(path.join(this.appDir, "catalog.json"), {});
    return (this.remote && this.remote.auth && this.remote.auth.githubClientId) || (builtin.auth && builtin.auth.githubClientId) || "";
  }

  async loginStart() {
    const clientId = this.githubClientId();
    if (!clientId) throw new Error("O login pelo GitHub ainda não está disponível. Use um token em Avançado.");
    if (this.loginCtrl) this.loginCtrl.abort();
    const dev = await GH.startDevice(clientId);
    const ctrl = (this.loginCtrl = new AbortController());
    GH.pollDevice(clientId, dev, ctrl.signal).then(async (t) => {
      const user = await GH.getUser(t.token).catch(() => ({}));
      this.state.settings.githubToken = t.token;
      this.state.settings.githubAuth = { login: user.login || "", refreshToken: t.refreshToken, expiresAt: t.expiresAt, refreshExpiresAt: t.refreshExpiresAt };
      this.save();
      this.emit("login", { ok: true, login: user.login || "" });
      this.refresh({ force: true }).catch(() => {});
    }).catch((e) => { if (e.message !== "Cancelado") this.emit("login", { ok: false, error: e.message }); })
      .finally(() => { if (this.loginCtrl === ctrl) this.loginCtrl = null; });
    return { userCode: dev.user_code, url: dev.verification_uri, expiresIn: dev.expires_in };
  }

  loginCancel() { if (this.loginCtrl) this.loginCtrl.abort(); this.loginCtrl = null; }

  logout() {
    this.state.settings.githubToken = "";
    this.state.settings.githubAuth = null;
    this.save();
    return this.refresh({ force: true });
  }

  // GitHub App com tokens que expiram: renova uns minutos antes
  async ensureToken() {
    const a = this.settings.githubAuth;
    if (!a || !a.refreshToken || !a.expiresAt || a.expiresAt - Date.now() > 5 * 60 * 1000) return;
    try {
      const t = await GH.refresh(this.githubClientId(), a.refreshToken);
      this.state.settings.githubToken = t.token;
      this.state.settings.githubAuth = { ...a, refreshToken: t.refreshToken || a.refreshToken, expiresAt: t.expiresAt, refreshExpiresAt: t.refreshExpiresAt || a.refreshExpiresAt };
      this.save();
    } catch { /* sem rede ou login expirado: os apps restritos ficam indisponíveis até entrar de novo */ }
  }

  async refresh({ force = false, ids } = {}) {
    await this.ensureToken();
    if (force || !this.remote) await this.refreshRemoteCatalog();
    const apps = this.catalog({ all: true }).filter((a) => !ids || ids.includes(a.id));
    const check = async (a) => {
      const s = { id: a.id };
      try { Object.assign(s, await this.detect(a)); } catch (e) { s.installed = false; s.detectError = e.message; }
      if (a.private && !this.settings.githubToken) { s.locked = true; s.latestError = "Acesso restrito"; return s; }
      try {
        s.latest = await sources.latest(a, { token: this.settings.githubToken, force });
      } catch (e) {
        s.latestError = e.message;
        if (a.private && (e.status === 404 || e.status === 401 || e.status === 403)) s.locked = true; // o token não tem acesso
      }
      s.updateAvailable = !!(s.installed && s.latest && U.cmpVersion(s.latest.version, s.version) > 0 && s.latest.version !== this.state.skipped[a.id]);
      if (s.installed && s.latest && s.latest.version === this.state.skipped[a.id] && U.cmpVersion(s.latest.version, s.version) > 0) s.skippedVersion = s.latest.version;
      return s;
    };
    await Promise.all(apps.map(async (a) => {
      let s = await check(a);
      const fallback = a.kind === "module" && this.catalog({ appsOnly: true }).find((x) => x.id === a.id && x.kind === "app");
      if (fallback && !s.installed && s.latestError) { this.unavailableModules.add(a.id); s = await check(fallback); }
      else this.unavailableModules.delete(a.id);
      this.status[a.id] = s;
    }));
    this.emit("changed");
    return this.snapshot();
  }

  snapshot() {
    return {
      settings: { ...this.settings, githubToken: this.settings.githubToken && !this.settings.githubAuth ? "••••" : "", githubAuth: undefined,
        githubLogin: this.settings.githubAuth ? this.settings.githubAuth.login || "conectado" : "", githubLoginAvailable: !!this.githubClientId() },
      system: this.system || (this.system = SI.osRelease()),
      // apps de acesso restrito só aparecem para quem tem acesso ao repositório (ou já instalou)
      apps: this.catalog().filter((a) => !a.private || (this.status[a.id] && (!this.status[a.id].locked || this.status[a.id].installed))).map((a) => ({
        ...a,
        iconUrl: this.iconUrl(a),
        status: this.status[a.id] || null,
        previous: this.state.previous[a.id] && fs.existsSync(path.join(this.prevDir, a.id)) ? this.state.previous[a.id] : null,
        job: this.jobs.has(a.id) ? { ...this.jobs.get(a.id), abort: undefined } : null,
      })),
    };
  }

  iconUrl(a) {
    if (!a.icon) return null;
    if (/^(https?|data):/.test(a.icon)) return a.icon;
    const p = path.isAbsolute(a.icon) ? a.icon : path.join(this.appDir, a.icon);
    return fs.existsSync(p) ? require("url").pathToFileURL(p).href : null;
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
    } catch (e) {
      if (e && e.message !== "Cancelado") (this.lastErrors || (this.lastErrors = {}))[id] = { msg: e.message, at: new Date().toISOString() };
      throw e;
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
      await this.ensureToken();
      this.progress(id, { phase: "check", text: "Consultando a versão mais recente..." });
      const latest = await sources.latest(app, { token: this.settings.githubToken, force: true });
      const cur = await this.detect(app);
      delete this.state.skipped[id];
      if (cur.installed && app.install.type !== "module" && app.install.type !== "script") await this.ensureClosed(app, cur.exe, closeIfRunning);
      const pkg = await this.fetchPackage(app, latest, signal);
      try {
        if (app.install.type === "module") await this.installModule(app, latest, pkg.file);
        else if (app.install.type === "portable") await this.installPortable(app, latest, pkg.file, cur);
        else if (app.install.type === "installer") await this.installInstaller(app, latest, pkg.file, cur);
        else if (app.install.type === "script") await this.installScript(app, latest, pkg.file, signal);
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
    if (/\.(zip|tar\.gz|tgz|tar\.xz)$/i.test(file)) await U.extractZip(file, staging);
    else { fs.mkdirSync(staging, { recursive: true }); fs.copyFileSync(file, path.join(staging, inst.exe)); }
    if (!fs.existsSync(path.join(staging, inst.exe))) {
      fs.rmSync(staging, { recursive: true, force: true });
      throw new Error(`O pacote não contém ${inst.exe}`);
    }
    if (!U.IS_WIN) try { fs.chmodSync(path.join(staging, inst.exe), 0o755); } catch { /* sistema de arquivos sem permissões */ }

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
    if (fs.existsSync(old)) this.keepPrevious(app.id, old, cur.version || (this.state.installed[app.id] || {}).version);

    this.state.installed[app.id] = { dir: target, version: latest.version, at: new Date().toISOString() };
    this.save();
    this.createShortcuts(app, path.join(target, inst.exe));
  }

  // Pacote com instalador próprio: extrai numa pasta da biblioteca (que fica, para desinstalar e reinstalar)
  // e roda o script; num terminal quando ele pede senha (sudo) ou faz perguntas
  async extractPackage(app, file, { keepOld = false } = {}) {
    const target = path.join(this.settings.libraryDir, app.install.folder || app.id);
    const staging = target + ".hub-new";
    fs.rmSync(staging, { recursive: true, force: true });
    this.progress(app.id, { phase: "extract", pct: null, text: "Extraindo arquivos..." });
    await U.extractZip(file, staging);
    if (!SI.scriptPath(staging, app.install.script)) {
      fs.rmSync(staging, { recursive: true, force: true });
      throw new Error(`O pacote não contém ${app.install.script}`);
    }
    const old = target + ".hub-old";
    fs.rmSync(old, { recursive: true, force: true });
    if (keepOld && fs.existsSync(target)) fs.renameSync(target, old);
    else fs.rmSync(target, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.renameSync(staging, target);
    return keepOld ? { dir: target, old: fs.existsSync(old) ? old : null } : target;
  }

  async runPackageScript(app, dir, rel, args, terminal, signal, text = "Instalando...") {
    const file = SI.scriptPath(dir, rel);
    if (!file) throw new Error(`O pacote não contém ${rel}`);
    this.progress(app.id, terminal && !U.IS_WIN
      ? { phase: "terminal", pct: null, text: "Siga no terminal que abriu (ele pode pedir a sua senha)..." }
      : { phase: "install", pct: null, text });
    await SI.runScript({ cwd: dir, file, args: args || [], terminal, title: app.name, signal, workDir: path.join(this.cacheDir, "..", "scripts") });
  }

  async installScript(app, latest, file, signal) {
    const inst = app.install;
    const before = this.detectScript(app, this.state.installed[app.id]);
    const { dir, old } = await this.extractPackage(app, file, { keepOld: true });
    try {
      await this.runPackageScript(app, dir, inst.script, inst.args, !!inst.terminal, signal);
    } catch (e) { // o instalador falhou: a pasta do pacote volta a ser a de antes
      if (old) { fs.rmSync(dir, { recursive: true, force: true }); fs.renameSync(old, dir); }
      throw e;
    }
    const now = this.detectScript(app, { dir, version: latest.version });
    if (!now.installed) throw new Error("O instalador terminou, mas o app não foi encontrado.");
    if (old) this.keepPrevious(app.id, old, before.installed ? before.version : "");
    this.state.installed[app.id] = { dir, version: latest.version, at: new Date().toISOString() };
    this.save();
  }

  // Guarda a pasta da versão que estava instalada (só a última), para "Voltar para a versão anterior"
  keepPrevious(id, dir, version) {
    const dest = path.join(this.prevDir, id);
    try {
      fs.rmSync(dest, { recursive: true, force: true });
      fs.mkdirSync(this.prevDir, { recursive: true });
      try { fs.renameSync(dir, dest); }
      catch (e) { if (e.code !== "EXDEV") throw e; fs.cpSync(dir, dest, { recursive: true }); fs.rmSync(dir, { recursive: true, force: true }); }
      this.state.previous[id] = { version: U.cleanVersion(version) || "?", at: new Date().toISOString() };
    } catch {
      fs.rm(dir, { recursive: true, force: true }, () => {});
      delete this.state.previous[id];
    }
    this.save();
  }

  // Troca a versão instalada pela anterior (e a atual vira a "anterior", para dar para desfazer)
  rollback(id, { closeIfRunning = false } = {}) {
    const app = this.app(id);
    const prevPath = path.join(this.prevDir, id);
    const prev = this.state.previous[id];
    if (!prev || !fs.existsSync(prevPath)) throw new Error("Não há versão anterior guardada");
    return this.runJob(id, async (signal) => {
      const cur = await this.detect(app);
      if (!cur.installed) throw new Error("O app não está instalado");
      const latest = this.status[id] && this.status[id].latest;
      const type = app.install.type;
      const swapDir = async (target) => { // pasta atual <-> pasta guardada
        const tmp = prevPath + ".swap";
        fs.rmSync(tmp, { recursive: true, force: true });
        fs.renameSync(target, tmp);
        try { fs.renameSync(prevPath, target); } catch (e) { fs.renameSync(tmp, target); throw e; }
        fs.renameSync(tmp, prevPath);
      };
      this.progress(id, { phase: "apply", text: `Voltando para a v${prev.version}...` });
      if (type === "module") {
        const wasVisible = this.modules && this.modules.visible === id;
        if (this.modules) await this.modules.stop(id);
        await swapDir(cur.dir);
        if (this.modules) { await this.modules.start(id).catch(() => {}); if (wasVisible) this.emit("openModule", id); }
      } else if (type === "portable") {
        await this.ensureClosed(app, cur.exe, closeIfRunning);
        await swapDir(cur.dir);
        this.createShortcuts(app, path.join(cur.dir, app.install.exe));
      } else if (type === "script") {
        await this.runPackageScript(app, prevPath, app.install.script, app.install.args, !!app.install.terminal, signal);
        const pkg = cur.pkgDir || path.join(this.settings.libraryDir, app.install.folder || app.id);
        if (fs.existsSync(pkg)) await swapDir(pkg);
        else { fs.renameSync(prevPath, pkg); }
      } else throw new Error("Este tipo de app não guarda a versão anterior");
      const was = cur.version;
      this.state.installed[id] = { ...(this.state.installed[id] || {}), dir: type === "script" ? (cur.pkgDir || path.join(this.settings.libraryDir, app.install.folder || app.id)) : cur.dir, version: prev.version, at: new Date().toISOString() };
      if (fs.existsSync(prevPath)) this.state.previous[id] = { version: was || "?", at: new Date().toISOString() };
      else delete this.state.previous[id];
      // não oferecer de novo a versão de que a pessoa acabou de sair
      if (latest && U.cmpVersion(latest.version, prev.version) > 0) this.state.skipped[id] = latest.version;
      this.save();
      return { version: prev.version };
    }).finally(() => this.refresh({ ids: [id] }).catch(() => {}));
  }

  // Módulo: extrai ao lado, para o módulo, troca a pasta e inicia de novo (sem reiniciar o Hub)
  async installModule(app, latest, file) {
    const target = path.join(this.modulesDir, app.id);
    const staging = target + ".hub-new";
    const old = target + ".hub-old";
    fs.rmSync(staging, { recursive: true, force: true });
    fs.rmSync(old, { recursive: true, force: true });
    this.progress(app.id, { phase: "extract", pct: null, text: "Extraindo o módulo..." });
    await U.extractZip(file, staging);
    const mf = U.readJson(path.join(staging, "module.json"), null);
    if (!mf || mf.id !== app.id) {
      fs.rmSync(staging, { recursive: true, force: true });
      throw new Error("O pacote não é o módulo " + app.name);
    }
    if (Array.isArray(mf.platforms) && !mf.platforms.includes(process.platform)) {
      fs.rmSync(staging, { recursive: true, force: true });
      throw new Error(`Esta versão do ${app.name} ainda não funciona neste sistema.`);
    }
    const hubVersion = this.modules ? this.modules.hubVersion : null;
    if (mf.minHub && hubVersion && U.cmpVersion(hubVersion, mf.minHub) < 0) {
      fs.rmSync(staging, { recursive: true, force: true });
      throw new Error(`Este módulo precisa da Arasaka Central ${mf.minHub}. Atualize a Central primeiro.`);
    }
    this.progress(app.id, { phase: "apply", text: "Aplicando..." });
    const wasVisible = this.modules && this.modules.visible === app.id;
    if (this.modules) await this.modules.stop(app.id);
    for (let i = 0; fs.existsSync(target); i++) { // processos do módulo podem levar um instante para soltar os arquivos
      try { fs.renameSync(target, old); }
      catch (e) { if (i >= 9) { if (this.modules) await this.modules.start(app.id).catch(() => {}); throw e; } await new Promise((r) => setTimeout(r, 700)); }
    }
    try { fs.renameSync(staging, target); }
    catch (e) { if (fs.existsSync(old)) fs.renameSync(old, target); throw e; }
    if (fs.existsSync(old)) {
      const oldMf = U.readJson(path.join(old, "module.json"), null);
      this.keepPrevious(app.id, old, oldMf && oldMf.version);
    }
    this.state.installed[app.id] = { dir: target, version: mf.version, at: new Date().toISOString() };
    this.save();
    if (this.modules) {
      await this.modules.start(app.id).catch(() => {});
      if (wasVisible) this.emit("openModule", app.id);
    }
  }

  async installInstaller(app, latest, file, cur) {
    const inst = app.install;
    if (!U.IS_WIN) throw new Error("Instaladores .exe só funcionam no Windows");
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
    const name = SC.fileName(app.install.shortcutName || app.name);
    // Linux: ícone em PNG (o do catálogo, se houver, ou o que o pacote trouxer em inst.iconPng)
    const iconPng = !U.IS_WIN ? [app.install.iconPng && path.join(path.dirname(exe), app.install.iconPng), app.icon && !/^(https?|data):/.test(app.icon) && (path.isAbsolute(app.icon) ? app.icon : path.join(this.appDir, app.icon))]
      .find((p) => p && fs.existsSync(p)) : undefined;
    const opts = { name: app.install.shortcutName || app.name, target: exe, cwd: path.dirname(exe), description: app.description || app.name, iconPng };
    try { SC.write(this.shell, path.join(SC.menuDir(), name), opts); } catch { /* sem permissão */ }
    if (this.settings.desktopShortcuts) {
      try { SC.write(this.shell, path.join(this.desktopDir, name), opts); } catch { /* idem */ }
    }
  }

  removeShortcuts(app) {
    const name = SC.fileName(app.install.shortcutName || app.name);
    for (const p of [path.join(SC.menuDir(), name), path.join(this.desktopDir, name)])
      try { fs.rmSync(p, { force: true }); } catch { /* ignora */ }
  }

  uninstall(id, { closeIfRunning = false } = {}) {
    const app = this.app(id);
    return this.runJob(id, async (signal) => {
      const cur = await this.detect(app);
      if (!cur.installed) throw new Error("O app não está instalado");
      if (app.install.type === "module") {
        this.progress(id, { phase: "uninstall", text: "Removendo o módulo..." });
        if (this.modules) await this.modules.stop(id);
        // processos auxiliares do módulo podem levar um instante para soltar os arquivos
        for (let i = 0; ; i++) {
          try { await this.shell.trashItem(cur.dir); break; } // os dados do módulo ficam onde estão
          catch (e) { if (i >= 9) throw e; await new Promise((r) => setTimeout(r, 700)); }
        }
        delete this.state.installed[id];
        this.forgetPrevious(id);
        this.save();
        return;
      }
      if (app.install.type === "script") {
        const inst = app.install;
        if (!inst.uninstall) throw new Error("Este app não tem desinstalador");
        let dir = cur.pkgDir;
        if (!dir || !SI.scriptPath(dir, inst.uninstall)) { // instalado fora da Central: baixa o pacote para ter o desinstalador
          this.progress(id, { phase: "check", text: "Consultando a versão mais recente..." });
          const latest = await sources.latest(app, { token: this.settings.githubToken, force: true });
          const pkg = await this.fetchPackage(app, latest, signal);
          try { dir = await this.extractPackage(app, pkg.file); } finally { if (pkg.temp) fs.rm(pkg.file, { force: true }, () => {}); }
        }
        await this.runPackageScript(app, dir, inst.uninstall, inst.uninstallArgs, inst.uninstallTerminal ?? !!inst.terminal, signal, "Desinstalando...");
        fs.rm(dir, { recursive: true, force: true }, () => {});
        delete this.state.installed[id];
        this.forgetPrevious(id);
        this.save();
        return;
      }
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
      this.forgetPrevious(id);
      this.save();
    });
  }

  async launch(id) {
    const app = this.app(id);
    if (app.install.type === "module") { this.emit("openModule", id); return; }
    const cur = await this.detect(app);
    if (!cur.installed) throw new Error("O app não está instalado");
    if (app.install.type === "script" && !cur.exe) throw new Error(`${app.name} não abre como um programa`);
    if (!U.IS_WIN) { // no Linux, abrir um executável pelo xdg-open pode abrir num editor de texto
      const p = spawn(cur.exe, [], { cwd: path.dirname(cur.exe), detached: true, stdio: "ignore" });
      await new Promise((res, rej) => { p.once("error", rej); p.once("spawn", res); });
      p.unref();
      return;
    }
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

  // Relatório de erro: versão, sistema, último erro e o fim dos logs, sem dados pessoais. A pessoa revisa
  // na tela antes de abrir a issue no GitHub (nada é enviado sozinho).
  report(id, { hubVersion } = {}) {
    const app = this.app(id);
    const s = this.status[id] || {};
    const sys = SI.osRelease();
    const scrub = (t) => {
      let x = String(t || "");
      const home = os.homedir(), user = os.userInfo().username, host = os.hostname();
      if (home) x = x.split(home).join("~");
      if (user && user.length > 2) x = x.replace(new RegExp(`\\b${user.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g"), "<usuario>");
      if (host && host.length > 2) x = x.split(host).join("<pc>");
      return x.replace(/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, "[token removido]")
        .replace(/\b([0-9a-f]{2}[:-]){5}[0-9a-f]{2}\b/gi, "[MAC removido]")
        .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "[e-mail removido]");
    };
    const tail = (file, n = 60) => {
      try { const lines = fs.readFileSync(file, "utf8").split(/\r?\n/); return lines.slice(-n).join("\n").trim(); } catch { return ""; }
    };
    const logs = [];
    if (app.kind === "module" && this.modules && this.modules.logDir) logs.push(path.join(this.modules.logDir, id + ".log"));
    for (const p of [].concat(app.logs || [])) { // arquivo ou pasta (pega o arquivo mais novo)
      const f = SI.expandPath(p);
      try {
        if (fs.statSync(f).isDirectory()) {
          const newest = fs.readdirSync(f).map((n) => path.join(f, n)).filter((x) => fs.statSync(x).isFile()).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
          if (newest) logs.push(newest);
        } else logs.push(f);
      } catch { /* não existe */ }
    }
    const err = (this.lastErrors || {})[id];
    const lines = [
      "### O que aconteceu", "", "<!-- Conte o que você estava fazendo e o que deu errado -->", "", "",
      "### Informações", "",
      `- App: ${app.name} (\`${id}\`, ${app.kind === "module" ? "módulo" : app.kind === "theme" ? "tema" : "app"})`,
      `- Versão instalada: ${s.installed ? s.version || "?" : "não instalado"}${s.latest ? ` · mais recente: ${s.latest.version}` : ""}`,
      `- Arasaka Central: ${hubVersion || "?"}`,
      `- Sistema: ${sys.name || process.platform} (${os.release()}, ${process.arch})`,
    ];
    if (s.moduleState === "crashed" || s.moduleError) lines.push(`- Estado do módulo: parou${s.moduleError ? ` (${s.moduleError})` : ""}`);
    if (err) lines.push(`- Último erro na Central (${err.at.slice(0, 16).replace("T", " ")}): ${err.msg}`);
    if (s.latestError) lines.push(`- Consulta de versão: ${s.latestError}`);
    for (const f of logs) {
      const t = tail(f);
      if (t) lines.push("", `<details><summary>Log: ${path.basename(f)} (fim)</summary>`, "", "\`\`\`", t, "\`\`\`", "</details>");
    }
    const body = scrub(lines.join("\n"));
    const repo = app.source && app.source.type === "github" ? app.source.repo : null;
    return { title: `[${app.name}] `, body, repo };
  }

  forgetPrevious(id) {
    try { fs.rmSync(path.join(this.prevDir, id), { recursive: true, force: true }); } catch { /* em uso: fica para a próxima */ }
    delete this.state.previous[id];
    delete this.state.skipped[id];
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
  if (!exe) throw new Error(U.IS_WIN ? "Informe o nome do executável (ex.: MeuApp.exe)" : "Informe o nome do executável (ex.: meuapp)");
  const asset = String(d.asset || "").trim();
  try { new RegExp(asset); } catch { throw new Error("O padrão do arquivo não é uma expressão regular válida"); }
  let source;
  const defAsset = U.IS_WIN ? "\\.(zip|exe)$" : "\\.(zip|tar\\.gz|tgz|AppImage)$";
  if (d.sourceType === "local") {
    if (!d.localPath || !fs.existsSync(d.localPath)) throw new Error("A pasta local não existe");
    source = { type: "local", path: d.localPath, asset: asset || defAsset };
  } else {
    const repo = String(d.repo || "").trim().replace(/^https?:\/\/github\.com\//i, "").replace(/\/+$/, "").replace(/\.git$/, "");
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("Repositório inválido (use dono/repositório)");
    source = { type: "github", repo, asset: asset || defAsset };
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
