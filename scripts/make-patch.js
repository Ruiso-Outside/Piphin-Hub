// Gera dist/hub-app-<versão>.zip: só os arquivos do Hub (pasta resources\app),
// usado pela atualização automática do próprio Hub.
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const root = path.join(__dirname, "..");
const pkg = require(path.join(root, "package.json"));
// "pasta/**" vira a pasta; "pasta/*.json" vira os arquivos; "!arquivo" fica de fora
const skip = new Set(pkg.build.files.filter((f) => f.startsWith("!")).map((f) => f.slice(1)));
const files = pkg.build.files.filter((f) => !f.startsWith("!")).map((f) => f.replace(/\/\*\*$/, "")).flatMap((f) => {
  if (!f.includes("*")) return [f];
  const dir = path.posix.dirname(f), re = new RegExp("^" + path.posix.basename(f).replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
  return fs.readdirSync(path.join(root, dir)).filter((n) => re.test(n)).map((n) => dir + "/" + n);
}).filter((f) => !skip.has(f));
const out = path.join(root, "dist", `hub-app-${pkg.version}.zip`);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.rmSync(out, { force: true });

// o package.json que vai no pacote é o mesmo que o electron-builder grava (sem build/devDependencies)
const stage = path.join(root, "dist", "patch-stage");
fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });
for (const f of files) fs.cpSync(path.join(root, f), path.join(stage, f), { recursive: true });
const slim = { name: pkg.name, productName: pkg.productName, version: pkg.version, description: pkg.description, main: pkg.main, author: pkg.author };
fs.writeFileSync(path.join(stage, "package.json"), JSON.stringify(slim, null, 2));

const tar = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");
execFileSync(tar, ["-a", "-c", "-f", out, "-C", stage, "."], { stdio: "inherit" });
fs.rmSync(stage, { recursive: true, force: true });
console.log("pacote de atualização:", out);
