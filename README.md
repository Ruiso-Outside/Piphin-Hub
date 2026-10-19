# Piphin Hub

Central dos apps da **Piphin Studio** no PC: baixa, instala, atualiza, abre e desinstala todos os softwares a partir de uma tela só. Os apps vêm dos **Releases do GitHub** e a lista de apps fica num catálogo (`catalog.json`), então dá para adicionar apps novos (AutoClick, Macro...) sem mexer no código.

## Instalar
1. Extraia `dist\Piphin-Hub-X.Y.Z-win-x64.zip` numa pasta fixa (ex.: `F:\Softwares\Piphin Hub`).
2. Abra o **`Piphin Hub.exe`**.

Igual ao Piphin LLM: o `.exe` é o do Electron oficial, sem modificações, por isso o **Controle Inteligente de Aplicativos** do Windows não bloqueia. Os dados do Hub ficam em `%APPDATA%\Piphin Hub`.

## O que ele faz
- **Biblioteca**: apps instalados, com botão **Abrir**. Instalações feitas antes do Hub são encontradas pelos atalhos do Menu Iniciar/Área de Trabalho (ou pelo botão **Já tenho instalado...**).
- **Explorar**: todos os apps do catálogo, com **Instalar**.
- **Atualizações**: compara a versão instalada com o último Release do GitHub. **Atualizar tudo** de uma vez. Ao abrir e a cada 6 horas o Hub verifica de novo (e avisa com uma notificação).
- **Detalhes** (clique num card): novidades da versão, pasta, espaço em disco, abrir pasta, reinstalar, desinstalar.
- Downloads conferidos por **SHA-256** (o GitHub publica o hash de cada arquivo). Se o app estiver aberto, o Hub pergunta antes de fechá-lo.
- Atualização **sem perder dados**: a versão nova é extraída ao lado, as pastas marcadas em `keep` são mantidas, e se algo falhar a versão anterior volta.
- **O próprio Hub se atualiza sozinho**: ao abrir e a cada hora ele consulta os Releases de `Ruiso-Outside/Piphin-Hub`, baixa a versão nova em segundo plano (conferindo o SHA-256) e pergunta se pode reiniciar. Se você escolher "Depois", ela entra quando o Hub for fechado. Só a pasta `resources\app` é trocada; se algo falhar, a versão atual continua.

## Adicionar um app novo
Há dois jeitos:

**1. Pela tela (só neste PC):** Explorar → **Adicionar app**. Informe o repositório do GitHub (ou uma pasta local com os `.zip`/`.exe`, útil para testar antes de publicar), o padrão do arquivo do Release e o nome do `.exe`.

**2. No catálogo (para todos os PCs):** acrescente uma entrada em `catalog.json`. Se o catálogo estiver publicado em `Ruiso-Outside/Piphin-Hub` (branch `main`), todos os Hubs recebem o app novo na próxima verificação, sem precisar atualizar o Hub.

```json
{
  "id": "autoclick",
  "name": "AutoClicker Pro",
  "description": "Cliques automáticos com rotas personalizadas.",
  "category": "Produtividade",
  "icon": "icons/autoclick.png",
  "accent": "#f472b6",
  "source": { "type": "github", "repo": "Ruiso-Outside/AutoClick", "asset": "win-x64\\.zip$" },
  "install": { "type": "portable", "folder": "AutoClicker Pro", "exe": "AutoClicker Pro.exe" }
}
```

### Campos
| Campo | Significado |
|---|---|
| `id` | Identificador único (minúsculas, sem espaço) |
| `icon` | Caminho dentro do Hub (`icons/...`) ou URL `https://` |
| `accent` | Cor do card |
| `source.type` | `github` (Releases) ou `local` (pasta, com `path`) |
| `source.asset` | Expressão regular que escolhe o arquivo do Release |
| `source.prerelease` | `true` para aceitar pré-lançamentos |
| `install.type` | `portable` (.zip extraído numa pasta) ou `installer` (.exe de instalação) |
| `install.exe` | Executável do app, relativo à pasta de instalação |
| `install.folder` | (portable) nome da pasta dentro da *Pasta dos apps* |
| `install.keep` | (portable) arquivos/pastas mantidos entre versões (ex.: `["config", "data"]`) |
| `install.versionFile` | JSON com `"version"` para ler a versão real (apps que se atualizam sozinhos) |
| `install.shortcutName` / `shortcutAliases` | Nome do atalho criado / nomes antigos usados para achar instalações existentes |
| `install.silentArgs` | (installer) argumentos de instalação silenciosa (ex.: `["/silent"]`, `["/S"]` no NSIS) |
| `install.dirArg` | (installer) argumento de pasta, com `{dir}` (ex.: `"/dir={dir}"`) |
| `install.uninstallKey` | (installer) chave em `...\CurrentVersion\Uninstall\` para versão, pasta e desinstalador |
| `install.selfUpdating` | O app também se atualiza sozinho (só informativo) |

A versão de cada Release vem da **tag** (`v1.2.3`). Para o Hub reconhecer um app novo, basta publicar um Release com o arquivo (`.zip` portátil de preferência: sem instalador, o Controle Inteligente de Aplicativos não atrapalha).

## Desenvolvimento
```
npm install
npm start          # roda o Hub
npm run check      # teste rápido sem interface: catálogo, detecção e GitHub
npm run icon       # redesenha icons/hub.png e hub.ico
npm run dist       # gera dist\Piphin-Hub-X-win-x64.zip e dist\hub-app-X.zip
```

### Publicar uma versão do Hub
1. Aumente `"version"` no `package.json`, faça o commit e rode `npm run dist`.
2. Rode `npm run release -- notas.md` (o arquivo de notas é opcional). Ele envia o código, cria a tag `vX.Y.Z` e o Release com `Piphin-Hub-X.Y.Z-win-x64.zip` (instalação nova) e `hub-app-X.Y.Z.zip` (atualização automática). Usa a variável `GH_TOKEN` ou, sem ela, o login do GitHub salvo no Git.

Em até uma hora, todos os Hubs abertos baixam a versão nova e perguntam se podem reiniciar.

## Estrutura
| Arquivo | Conteúdo |
|---|---|
| `main.js` / `preload.js` | Janela, ponte com a interface, verificação periódica |
| `lib/apps.js` | Catálogo, detecção e ações (instalar, atualizar, desinstalar, abrir) |
| `lib/sources.js` | Consulta dos Releases do GitHub / pasta local |
| `lib/download.js` | Download com progresso, cancelamento e SHA-256 |
| `lib/selfupdate.js` | Atualização do próprio Hub |
| `lib/util.js` | Registro, processos, versões, extração de `.zip` |
| `web/` | Interface |
| `catalog.json` | Apps que vêm com o Hub |
