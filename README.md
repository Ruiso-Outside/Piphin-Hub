# Piphin Hub

Central dos apps da **Piphin Studio** no PC: baixa, instala, atualiza, abre e desinstala todos os softwares a partir de uma tela só. Os apps vêm dos **Releases do GitHub** e a lista de apps fica num catálogo (`catalog.json`), então dá para adicionar apps novos (AutoClick, Macro...) sem mexer no código.

## Instalar
1. Antes de extrair, clique com o botão direito no `.zip` baixado, escolha **Propriedades**, marque **Desbloquear** e clique em **OK**.
2. Extraia `Piphin-Hub-X.Y.Z-win-x64.zip` numa pasta fixa (ex.: `F:\Softwares\Piphin Hub`).
3. Abra o **`Piphin Hub.exe`**.

Igual ao Piphin LLM: o `.exe` é o do Electron oficial, sem modificações, por isso o **Controle Inteligente de Aplicativos** do Windows não bloqueia o `.exe`. Mas, se o `.zip` não for desbloqueado antes de extrair, cada arquivo fica marcado como "baixado da internet" e o Windows bloqueia os **atalhos** do Hub (Área de Trabalho e Menu Iniciar) com a mensagem "Uma política de Controle de Aplicativo bloqueou este arquivo". Nesse caso a tela Início mostra um aviso com o botão **Desbloquear arquivos do Hub**, que tira a marca só dos arquivos da pasta do Hub (o mesmo que Propriedades → Desbloquear). Os dados do Hub ficam em `%APPDATA%\Piphin Hub`.

## O que ele faz
- **Biblioteca**: apps instalados, com botão **Abrir**. Instalações feitas antes do Hub são encontradas pelos atalhos do Menu Iniciar/Área de Trabalho (ou pelo botão **Já tenho instalado...**).
- **Explorar**: todos os apps do catálogo, com **Instalar**.
- **Atualizações**: compara a versão instalada com o último Release do GitHub. **Atualizar tudo** de uma vez. Ao abrir e a cada 6 horas o Hub verifica de novo (e avisa com uma notificação).
- **Detalhes** (clique num card): novidades da versão, pasta, espaço em disco, abrir pasta, reinstalar, desinstalar.
- Downloads conferidos por **SHA-256** (o GitHub publica o hash de cada arquivo). Se o app estiver aberto, o Hub pergunta antes de fechá-lo.
- Atualização **sem perder dados**: a versão nova é extraída ao lado, as pastas marcadas em `keep` são mantidas, e se algo falhar a versão anterior volta.
- **Mídia**: tudo que os módulos criam ou baixam num lugar só, pronto para usar em qualquer módulo (veja abaixo).
- **O próprio Hub se atualiza sozinho**: ao abrir e a cada hora ele consulta os Releases de `Ruiso-Outside/Piphin-Hub`, baixa a versão nova em segundo plano (conferindo o SHA-256) e pergunta se pode reiniciar. Se você escolher "Depois", ela entra quando o Hub for fechado. Só a pasta `resources\app` é trocada; se algo falhar, a versão atual continua.

## Módulos
Módulos são partes do Piphin que rodam **dentro do Hub**, com uma área própria na janela e um item em **Módulos** na barra lateral. Como usam o Electron do próprio Hub, cada um tem poucos KB (o Piphin Macro tem 120 KB como módulo, contra 146 MB como app separado). Instalar, atualizar e remover um módulo não reinicia o Hub.

- O motor de cada módulo roda num **processo separado**: se ele travar, o Hub e os outros módulos continuam funcionando (o card mostra "parou" e há o botão **Reiniciar módulo**).
- Os motores começam junto com o Hub. Quando um módulo precisa continuar trabalhando (ex.: atalhos de macro ligados), fechar a janela só esconde o Hub no ícone perto do relógio; **Sair** pelo menu do ícone fecha tudo.
- Ao sair, cada módulo desliga o que abriu (ganchos de teclado, processos auxiliares).
- Removido um módulo, os dados dele continuam no PC.

### Fazer um módulo
Um módulo é um `.zip` publicado no Release do repositório dele, com:

```
module.json      { "id", "name", "version", "main": "backend.js", "ui": "web/index.html", "icon", "accent", "minHub": "1.1.0" }
backend.js       motor (Node.js), opcional
web/             interface
```

**Motor** (`backend.js`): exporta `activate(ctx)` (e, se quiser, `deactivate()`).

| `ctx` | Para quê |
|---|---|
| `ctx.handle(canal, fn)` | responde às chamadas da interface |
| `ctx.emit(canal, dados)` | envia eventos para a interface |
| `ctx.onStop(fn)` | limpeza antes de o módulo parar |
| `ctx.dataDir`, `ctx.dir`, `ctx.version` | pasta de dados do módulo, pasta do módulo, versão |
| `ctx.host.saveDialog/openDialog(opts)` | janelas de arquivo do Windows |
| `ctx.host.notify(título, texto)`, `ctx.host.focus()` | notificação; trazer o módulo para a frente |
| `ctx.host.keepAlive(ligado, motivo)` | manter o Hub rodando escondido ao fechar a janela |
| `ctx.host.messageBox({ message, detail, buttons })` | pergunta ao usuário (devolve o índice do botão) |
| `ctx.host.openPath(pasta)`, `ctx.host.showItem(arquivo)` | abrir pasta / mostrar arquivo no Explorer |
| `ctx.host.registerHotkey(atalho)`, `unregisterHotkey` | atalho global; ao apertar, chega o evento `hotkey` |
| `ctx.host.openWindow(nome, { url ou file, width, height, frame, transparent, alwaysOnTop, ... })` | janela extra (ex.: pergunta rápida do LLM), também com `window.piphin` |
| `ctx.host.showWindow(nome, { placement: "cursor-top" })`, `hideWindow`, `setWindowBounds`, `windowState`, `sendToWindow` | controle das janelas extras |
| `ctx.host.captureScreen({ hide, format, maxWidth, display })`, `ctx.host.readClipboard()`, `ctx.host.writeClipboardImage(png)` | print de um monitor (JPEG até 1920 px por padrão; `format: "png", maxWidth: 0` no tamanho real); ler e copiar |
| `ctx.host.displays()`, `ctx.host.cursorPoint()` | monitores (posição, escala, principal, o do mouse) e a posição do mouse |
| `ctx.host.listCaptureSources({ types })`, `ctx.host.setCaptureSource({ id, audio })` | monitores e janelas para gravar (com miniatura) e a fonte do próximo `getDisplayMedia` das páginas do módulo, com o som do PC se `audio`; precisa de `"permissions": ["screenCapture"]` no module.json (Hub 1.6.0) |
| `openWindow` com `contentProtection`, `x`, `y` | janela que não aparece em prints e gravações; posição |
| `ctx.host.setStartWithWindows(ligado)` | liga "Iniciar com o Windows" do Hub |
| `ctx.host.on(evento, fn)` | `hotkey`, `window-blur`, `window-show`, `window-hide`, `view-shown` / `view-hidden` (a tela do módulo apareceu / sumiu: bom para ligar e desligar o que só serve enquanto alguém olha) |
| janelas de overlay | `openWindow` com `clickThrough: true` (cliques passam) e `topLevel: "screen-saver"` (acima de jogos); `showWindow` com `placement: "top-left"`, `"top-right"`, `"bottom-left"` ou `"bottom-right"` e `focus: false`; `setWindowOpacity` |
| `ctx.log(...)` | registro em `%APPDATA%\Piphin Hub\logs\<id>.log` |

| `ctx.host.library.add(itens)` / `sync(itens)` / `remove(caminhos)` | põe na **Mídia** o que o módulo criou ou baixou (Hub 1.7.0); `sync` troca a lista inteira do módulo |
| `ctx.host.library.list({ kind, kinds, by, query, tag, game, limit })`, `thumb(id)` | o que todos os módulos criaram; miniatura (JPEG em data URL) |
| `ctx.host.library.pick({ kinds, multi, title })` | janela **Escolher da mídia** do Hub; devolve os itens escolhidos |
| `ctx.host.openers(kind)`, `ctx.host.openIn(id, { path })` | módulos que abrem o tipo de arquivo e "Abrir no ..." (quem recebe ganha o evento `open-file`) |

Atalhos e janelas extras são liberados sozinhos quando o módulo para.

### Mídia: um módulo usando o que o outro fez (Hub 1.7.0)
O Hub guarda um índice (`midia.json`) do que os módulos criam ou baixam; os arquivos ficam onde o módulo salvou.
A tela **Mídia** mostra tudo junto (tocar, ver, abrir em outro módulo, mostrar na pasta, **arrastar para qualquer programa**) e o Início mostra o que foi criado por último.

- **Pôr na Mídia**: `ctx.host.library.add({ path, title, sub: "Efeito sonoro", duration, license, credit, videoOk, cover, game, tags })` (`kind` sai da extensão: `audio`, `video` ou `image`).
  Quem mantém uma lista própria (Piphin Música, Piphin Captura) usa `sync(lista)` ao abrir e a cada mudança: o que sumiu da lista sai da Mídia. Arquivo apagado sai sozinho.
- **Usar da Mídia**: `await ctx.host.library.pick({ kinds: ["audio"], multi: true })` abre a janela do Hub por cima do módulo e devolve os itens (`path`, `title`, `credit`, `byName`...).
- **Abrir no ...**: o módulo declara no `module.json` o que sabe abrir, `"opens": ["image"]`. Outro módulo (ou a tela Mídia) chama `ctx.host.openIn("foto", { path })`: o Hub mostra o módulo e o motor dele recebe `ctx.host.on("open-file", ({ path, kind, title, fromName }) => ...)`.
- **Mudou**: todos os motores recebem o evento `library-changed`.
- **IA**: a ferramenta `hub_media_library` (do próprio Hub) lista a Mídia com o caminho de cada arquivo, para a IA usar nas ferramentas dos módulos ("coloque a música que eu baixei no vídeo").
- Num Hub antigo `ctx.host.library` não existe: teste antes (`const lib = ctx.host.library || null`) e esconda o que depende dela.

Hoje: o **Piphin Música** põe as músicas baixadas (com licença e crédito), o **Piphin Som** as músicas exportadas e os efeitos sonoros, o **Piphin Captura** os prints e gravações (com o jogo aberto, pelo Piphin Jogos), o **Piphin Foto** as imagens exportadas e o **Piphin Vídeo** os vídeos exportados.
O Vídeo usa tudo isso e, ao exportar, entrega o texto dos créditos das músicas para a descrição; o Som importa áudios; o Foto abre prints; o Música toca o que veio do Som; o Jogos mostra os prints e gravações de cada jogo.

Se a interface vem de um servidor local do próprio módulo (como o Piphin LLM), declare o endereço em `"allowOrigins": ["http://127.0.0.1:8765"]` no `module.json`; qualquer outro endereço abre no navegador.

**Interface**: uma página comum (sem barra de título; a barra lateral já é a do Hub) com `window.piphin`:
`piphin.invoke(canal, ...args)` → `{ ok, data }` ou `{ ok: false, error }`, `piphin.on(canal, fn)` e `piphin.info`.

**No catálogo**, módulos ficam em `"modules"` (o Hub antigo ignora essa lista). Um módulo com o mesmo `id` de um app separado substitui o app no Hub:
```json
"modules": [{ "id": "macro", "name": "Piphin Macro", "category": "Jogos", "icon": "icons/macro.png",
  "source": { "type": "github", "repo": "Ruiso-Outside/Piphin-Macro", "asset": "^piphin-module-macro-.*\\.zip$" } }]
```
Exemplos completos: `module/` e `scripts/make-module.js` no repositório do Piphin Macro, `desktop/module/` e `desktop/scripts/make-module.js` no do Piphin LLM, e `module/`, `src/InfoHardware.Engine` e `build-module.ps1` no do InfoHardware (motor .NET que roda dentro do PowerShell do Windows, com administrador pelo UAC: o jeito de usar código .NET sem criar um `.exe` que o Controle Inteligente de Aplicativos bloquearia).

Enquanto um módulo ainda não tem Release (e não está instalado), o Hub continua mostrando o app separado de mesmo `id`, se houver.

Em **Configurações → Iniciar com o Windows**, o Hub abre escondido no ícone perto do relógio quando o PC liga, para os atalhos dos módulos funcionarem desde o início.

## Piphin UI (kit de interface)
O Hub e os módulos usam o mesmo visual. O kit fica em `web/ui/` e o Hub o serve para as páginas dos módulos pelo endereço `piphin://ui/`:

| Arquivo | Conteúdo |
|---|---|
| `piphin://ui/tokens.css` | Cores, camadas, forma e tipografia (variáveis `--p-*`, mais os nomes antigos `--bg`, `--panel`, `--accent`... para CSS já existente) |
| `piphin://ui/kit.css` | Tokens + componentes: `.btn` (`primary`, `ghost`, `danger`, `sm`, `icon`), `.card`, `.card-title`, `.set`, `.switch`, `.seg`, `.chip`, `.badge`, `.dot`, `kbd`, `table.table`, `.kv`, `.progress`, `.spin`, `.p-empty`, `.p-banner`, `.modal`, `.toast`, `.p-subnav` (abas do módulo), `.p-head` (cabeçalho da página) |
| `piphin://ui/icons.css` | Ícones Lucide (ISC): `<i class="i i-cpu"></i>`. Lista em `scripts/make-ui-icons.js`; `npm run ui-icons` gera de novo |

Uma página de módulo usa assim (a CSP precisa liberar `piphin:` em `style-src`):
```html
<link rel="stylesheet" href="piphin://ui/kit.css">
<link rel="stylesheet" href="piphin://ui/icons.css">
<style>:root { --p-module: #e879f9; } /* cor do módulo: realces e abas */</style>
```
Módulos com CSS próprio grande (como o Piphin LLM) podem carregar só `tokens.css` para adotar a paleta.

### Atalhos do Hub
- `Ctrl+K`: paleta de comandos (abrir módulos, instalar, atualizar, ir para telas)
- `Ctrl+1` … `Ctrl+9`: ir direto para um módulo · `Ctrl+,`: Configurações

Funcionam também com o foco dentro de um módulo. Um módulo pode ficar com alguns desses atalhos para ele: `"reservedKeys": ["ctrl+1", "ctrl+2"]` no `module.json` (o Piphin LLM reserva `Ctrl+1…4` para os modos dele).

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
