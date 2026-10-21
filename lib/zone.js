// Marca "baixado da internet" (Zone.Identifier) que o Explorer copia do .zip para cada arquivo extraído.
// Com o Controle Inteligente de Aplicativos ligado, o Windows bloqueia os atalhos que apontam para um .exe marcado.
// No Hub, passe o "original-fs" do Electron: sem o suporte a .asar, um .asar é só um arquivo.
const path = require("path");

const ZONE = ":Zone.Identifier";

const isMarked = (file, fs = require("fs")) => fs.existsSync(file + ZONE);

// Igual a Propriedades → Desbloquear, em todos os arquivos dentro de root (e só nele)
function unblockDir(root, fs = require("fs")) {
  let count = 0, failed = 0;
  const walk = (dir) => {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      if (d.isSymbolicLink()) continue; // não segue links para fora da pasta
      const p = path.join(dir, d.name);
      if (d.isDirectory()) walk(p);
      else if (d.isFile() && fs.existsSync(p + ZONE)) {
        try { fs.unlinkSync(p + ZONE); count++; } catch { failed++; }
      }
    }
  };
  walk(root);
  return { count, failed };
}

module.exports = { isMarked, unblockDir };
