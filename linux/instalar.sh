#!/usr/bin/env bash
# Arasaka Central no Linux: prepara a pasta extraída e abre a Central (ele cria o atalho no menu de aplicativos).
# Uso: bash instalar.sh     (rode de dentro da pasta extraída; deixe a pasta onde ela está)
set -e
cd "$(dirname "$(readlink -f "$0")")"
DIR="$(pwd)"

chmod +x piphin-hub chrome_crashpad_handler 2>/dev/null || true
chmod +x resources/app/linux/*.sh 2>/dev/null || true

# Ubuntu 24.04 e derivados (Zorin 18, Mint 22...) bloqueiam o sandbox do Chromium para apps fora da loja.
# A correção é dar ao chrome-sandbox o dono root com o bit SUID (é o que o pacote .deb do Chrome faz).
needs_suid=0
if [ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null)" = "1" ] || [ "$(cat /proc/sys/kernel/unprivileged_userns_clone 2>/dev/null)" = "0" ]; then
  needs_suid=1
fi
if [ "$needs_suid" = "1" ] && [ -f chrome-sandbox ]; then
  if [ "$(stat -c %u:%a chrome-sandbox)" != "0:4755" ]; then
    echo "O sistema pede permissão de administrador uma vez para o sandbox de segurança da Central (chrome-sandbox)."
    sudo chown root:root chrome-sandbox && sudo chmod 4755 chrome-sandbox
  fi
fi

for tool in unzip tar; do
  command -v "$tool" >/dev/null 2>&1 || echo "Aviso: instale o $tool (sudo apt install $tool) para a Central extrair os apps."
done

echo "Abrindo a Arasaka Central de $DIR"
nohup "$DIR/piphin-hub" >/dev/null 2>&1 &
