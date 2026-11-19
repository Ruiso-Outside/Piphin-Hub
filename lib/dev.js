// Aba Desenvolvedor: os repositórios do catálogo que estão clonados no PC, com a versão no código, a última
// publicada e o que mudou desde então; e "Publicar", que troca a versão, faz o commit, envia e publica o Release.
// Usa o git e o GitHub CLI (gh) do próprio PC, com o login de quem desenvolve (nada de token guardado aqui).
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");
const U = require("./util");

function run(cmd, args, cwd, { onLine, env } = {}) {
  return new Promise((resolve, reject) => {
    const p = execFile(cmd, args, { cwd, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1", ...(env || {}) }, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) { err.message = (String(stderr || "").trim().split("\n").slice(-3).join(" ") || err.message); return reject(err); }
        resolve(String(stdout).trim());
      });
    if (onLine) {
      const feed = (d) => String(d).split(/\r?\n/).filter(Boolean).forEach(onLine);
      p.stdout.on("data", feed); p.stderr.on("data", feed);
    }
  });
}
const git = (cwd, ...args) => run("git", args, cwd);
const has = (cmd) => run(cmd, ["--version"], os.homedir()).then(() => true, () => false);

// owner/repo a partir do remote (https ou ssh)
function repoOf(url) {
  const m = /github\.com[/:]([^/]+)\/([^/]+?)(\.git)?\/?$/i.exec(url || "");
  return m ? `${m[1]}/${m[2]}` : null;
}

// Onde está a versão no código: "dev" do catálogo, ou o padrão de cada tipo
function versionSpec(entry, dir) {
  if (entry && entry.dev && entry.dev.versionFile) return { ...entry.dev, json: entry.dev.json || /\.json$/i.test(entry.dev.versionFile) && !entry.dev.versionPattern };
  if (fs.existsSync(path.join(dir, "package.json"))) return { versionFile: "package.json", json: true };
  if (fs.existsSync(path.join(dir, "VERSION"))) return { versionFile: "VERSION" };
  return null;
}

function readCodeVersion(dir, spec) {
  if (!spec) return "";
  let text;
  try { text = fs.readFileSync(path.join(dir, spec.versionFile), "utf8"); } catch { return ""; }
  if (spec.json) { try { return JSON.parse(text).version || ""; } catch { return ""; } }
  if (spec.versionPattern) { const m = new RegExp(spec.versionPattern).exec(text); return m ? m[1] : ""; }
  return text.split(/\r?\n/)[0].trim();
}

function writeCodeVersion(dir, spec, version) {
  const file = path.join(dir, spec.versionFile);
  let text = fs.readFileSync(file, "utf8");
  if (spec.json) {
    const m = /("version"\s*:\s*")[^"]*(")/.exec(text);
    if (!m) throw new Error(`${spec.versionFile} não tem "version"`);
    text = text.replace(m[0], m[1] + version + m[2]);
  } else if (spec.versionPattern) {
    const re = new RegExp(spec.versionPattern);
    const m = re.exec(text);
    if (!m) throw new Error(`Não achei a versão em ${spec.versionFile}`);
    text = text.replace(m[0], m[0].replace(m[1], version));
  } else text = version + "\n";
  fs.writeFileSync(file, text);
}

const moduleScript = (entry) => (entry && entry.dev && entry.dev.moduleScript) || path.join("scripts", "make-module.js");

class Dev {
  constructor({ hub, execPath }) {
    this.hub = hub;           // catálogo e status
    this.execPath = execPath; // o próprio Electron, para rodar os scripts dos módulos (ELECTRON_RUN_AS_NODE)
    this.busy = new Map();
  }

  roots() {
    const ws = this.hub.settings.devWorkspace || path.join(os.homedir(), "piphin");
    return [ws, os.homedir()];
  }

  // Repositórios clonados que pertencem ao catálogo (e a própria Central e o kit)
  async scan() {
    const entries = this.hub.catalog({ all: true });
    const byRepo = new Map();
    for (const e of entries) if (e.source && e.source.type === "github") byRepo.set(e.source.repo.toLowerCase(), e);
    const seen = new Set(), out = [], found = [];
    for (const root of this.roots()) {
      let names = [];
      try { names = fs.readdirSync(root); } catch { continue; }
      for (const n of names) {
        const dir = path.join(root, n);
        if (seen.has(dir) || !fs.existsSync(path.join(dir, ".git"))) continue;
        seen.add(dir);
        const remote = await git(dir, "remote", "get-url", "origin").catch(() => "");
        const repo = repoOf(remote);
        if (!repo) continue;
        const entry = byRepo.get(repo.toLowerCase());
        const isHub = /\/ArasakaCentral$/i.test(repo), isKit = /\/ArasakaKit$/i.test(repo);
        if (!entry && !isHub && !isKit) continue;
        found.push([dir, repo, entry, { isHub, isKit }]);
      }
    }
    // tags novas do GitHub (Releases criados por lá), em paralelo e sem travar se estiver sem rede
    await Promise.all(found.map(([dir]) => run("git", ["fetch", "-q", "--tags", "--no-recurse-submodules"], dir).catch(() => {})));
    for (const f of found) out.push(await this.info(...f));
    return out.sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
  }

  async info(dir, repo, entry, { isHub, isKit } = {}) {
    const spec = versionSpec(entry, dir);
    const code = readCodeVersion(dir, spec);
    const tag = await git(dir, "describe", "--tags", "--abbrev=0").catch(() => "");
    const range = tag ? `${tag}..HEAD` : "HEAD";
    const log = await git(dir, "log", range, "--pretty=%s", "-n", "50").catch(() => "");
    const commits = log ? log.split("\n") : [];
    const dirty = (await git(dir, "status", "--porcelain").catch(() => "")).split("\n").filter(Boolean).length;
    const ahead = Number(await git(dir, "rev-list", "--count", "@{u}..HEAD").catch(() => "0")) || 0;
    const branch = await git(dir, "branch", "--show-current").catch(() => "");
    const st = entry && this.hub.status[entry.id];
    const kind = isHub ? "hub" : isKit ? "kit" : entry && entry.dev && entry.dev.release === "gh-release" ? "ghrelease" : fs.existsSync(path.join(dir, ".github", "workflows", "release.yml")) ? "tag"
      : entry && entry.dev && entry.dev.release === "manual" ? "manual"
      : entry && entry.kind === "module" && fs.existsSync(path.join(dir, moduleScript(entry))) ? "module" : "none";
    return {
      dir, repo, id: entry ? entry.id : null, name: entry ? entry.name : isHub ? "Arasaka Central" : "Arasaka Kit",
      kindLabel: entry ? entry.kind : isHub ? "central" : "kit",
      code, tag: tag.replace(/^v/, ""), published: st && st.latest ? st.latest.version : tag.replace(/^v/, ""),
      commits, dirty, ahead, branch, versionFile: spec ? spec.versionFile : null, release: kind,
      canPublish: !!spec && (kind === "tag" || kind === "module" || kind === "kit" || kind === "ghrelease"),
      why: !spec ? "Não sei onde fica a versão no código" : kind === "manual" ? (entry.dev.note || "Publique pelo processo próprio deste projeto") : kind === "hub" ? "A Central se publica pelo processo próprio dela (pacote do Linux + hub-app)" : kind === "none" ? "O repositório não tem workflow de Release nem script de módulo" : "",
    };
  }

  async publish(dir, { version, notes }, onLine) {
    if (this.busy.has(dir)) throw new Error("Já tem uma publicação em andamento neste repositório");
    this.busy.set(dir, true);
    const say = (t) => onLine && onLine(t);
    try {
      version = U.cleanVersion(version);
      if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("Versão inválida (use X.Y.Z)");
      if (!(await has("git"))) throw new Error("O git não está instalado");
      const remote = await git(dir, "remote", "get-url", "origin");
      const repo = repoOf(remote);
      const entry = this.hub.catalog({ all: true }).find((e) => e.source && e.source.repo && e.source.repo.toLowerCase() === String(repo).toLowerCase());
      const inf = await this.info(dir, repo, entry, { isKit: /\/ArasakaKit$/i.test(repo) });
      if (!inf.canPublish) throw new Error(inf.why || "Este repositório não pode ser publicado por aqui");
      if (inf.dirty) throw new Error(`Há ${inf.dirty} arquivo(s) alterados sem commit. Faça o commit (ou descarte) antes de publicar.`);
      if (inf.branch && inf.branch !== "main") throw new Error(`Você está no branch ${inf.branch}. Publique a partir do main.`);
      const tagName = "v" + version;
      if ((await git(dir, "tag", "--list", tagName)) === tagName) throw new Error(`A tag ${tagName} já existe`);
      if ((inf.release === "module" || inf.release === "ghrelease") && !(await has("gh"))) throw new Error("Para publicar módulos, instale o GitHub CLI (gh) e rode: gh auth login");

      say(`> git pull`);
      await run("git", ["pull", "--ff-only", "-q"], dir, { onLine: say });
      if (inf.code !== version) {
        say(`> versão ${inf.code || "?"} -> ${version} em ${inf.versionFile}`);
        writeCodeVersion(dir, versionSpec(entry, dir), version);
        await git(dir, "add", inf.versionFile);
        await run("git", ["commit", "-q", "-m", `Versão ${version}`], dir, { onLine: say });
      }
      say("> git push");
      await run("git", ["push", "-q", "origin", "HEAD"], dir, { onLine: say });

      let url = `https://github.com/${repo}/releases`;
      if (inf.release === "tag" || inf.release === "kit") {
        say(`> tag ${tagName}`);
        await run("git", ["tag", "-a", tagName, "-m", `${inf.name} ${tagName}\n\n${notes || ""}`.trim()], dir);
        await run("git", ["push", "-q", "origin", tagName], dir, { onLine: say });
        url = inf.release === "tag" ? `https://github.com/${repo}/actions` : url;
        say(inf.release === "tag" ? "■ Tag enviada: o GitHub roda os testes e publica o Release em alguns minutos." : "■ Tag enviada.");
      } else if (inf.release === "ghrelease") { // o Release publicado dispara os workflows que montam os pacotes
        say(`> gh release create ${tagName}`);
        await run("gh", ["release", "create", tagName, "-R", repo, "--target", "main", "--title", `${inf.name} ${version}`, "--notes", notes || `Versão ${version}`], dir, { onLine: say });
        url = `https://github.com/${repo}/actions`;
        say("■ Release criado: os workflows do GitHub montam e anexam os pacotes em alguns minutos.");
      } else if (inf.release === "module") {
        say("> montando o módulo (scripts/make-module.js)");
        await run(this.execPath, [path.join(dir, moduleScript(entry))], dir, { onLine: say, env: { ELECTRON_RUN_AS_NODE: "1" } });
        const dist = path.join(dir, (entry.dev && entry.dev.dist) || "dist");
        const zip = fs.readdirSync(dist).find((f) => /^piphin-module-.*\.zip$/.test(f) && f.includes(version));
        if (!zip) throw new Error("O script não gerou o .zip do módulo em dist/");
        say(`> gh release create ${tagName} ${zip}`);
        await run("gh", ["release", "create", tagName, "-R", repo, "--target", "main", "--title", `${inf.name} ${version}`, "--notes", notes || `Versão ${version}`, path.join(dist, zip)], dir, { onLine: say });
        url = `https://github.com/${repo}/releases/tag/${tagName}`;
        say("■ Release publicado. A Central oferece a atualização na próxima verificação.");
      }
      return { url, version };
    } finally {
      this.busy.delete(dir);
    }
  }
}

module.exports = { Dev, repoOf, readCodeVersion, writeCodeVersion };
