#!/bin/zsh
# 더블클릭하면 설치, 샘플 생성, 앱 실행까지 한 번에 진행합니다.
cd "$(dirname "$0")" || exit 1
if ! command -v npm >/dev/null 2>&1; then
  [ -s "$HOME/.nvm/nvm.sh" ] && source "$HOME/.nvm/nvm.sh"
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "Node.js(npm)를 찾지 못했습니다. https://nodejs.org 에서 설치한 뒤 다시 실행해 주세요."
  read -k1 "?아무 키나 누르면 닫습니다"; exit 1
fi
echo "▶ node $(node -v)"
[ -d node_modules ] || npm install --no-audit --no-fund || { read -k1 "?설치 실패. 아무 키나 누르면 닫습니다"; exit 1; }
[ -f sample/sample-chat.txt ] || npm run sample
npm start
