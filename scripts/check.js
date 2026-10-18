// Teste rápido sem interface: lê o catálogo, detecta o que está instalado e consulta o GitHub.
// Uso: npm run check
const os = require("os");
const path = require("path");
const fs = require("fs");
const { Hub } = require("../lib/apps");

const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "hub-check-"));
const shell = { writeShortcutLink: () => true, trashItem: async () => {}, openPath: async () => "" };
const hub = new Hub({ appDir: path.join(__dirname, ".."), userDir, shell });

hub.refresh({ force: true }).then((snap) => {
  for (const a of snap.apps) {
    const s = a.status || {};
    console.log(`\n${a.name} [${a.id}] (${a.install.type}, ${a.origin})`);
    console.log("  instalado:", s.installed ? `v${s.version} em ${s.dir}` : "não");
    console.log("  mais recente:", s.latest ? `v${s.latest.version} · ${s.latest.fileName} · ${(s.latest.size / 1048576).toFixed(1)} MB · sha256 ${s.latest.sha256 ? "sim" : "não"}` : s.latestError);
    if (s.updateAvailable) console.log("  >> atualização disponível");
  }
  fs.rmSync(userDir, { recursive: true, force: true });
}).catch((e) => { console.error(e); process.exit(1); });
