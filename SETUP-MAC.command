#!/bin/zsh
set -e
cd "${0:A:h}"

echo "AUTOBOT v0.11.1 Mac Setup"
echo "=========================="
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required. Install the current LTS release from https://nodejs.org and run this file again."
  read "?Press Return to close."
  exit 1
fi

echo "Installing AUTOBOT files..."
npm install

echo "Open OPEN-FIRST-AUTOBOT-SETUP-GUIDE.pdf for the complete copy-and-paste checklist."

DEVICE_CONFIG="$HOME/Library/Application Support/AUTOBOT/device.json"
if [[ ! -f "$DEVICE_CONFIG" ]]; then
  read "PAIR_CODE?Enter the enrollment or one-time code: "
  read "DEVICE_NAME?Enter this laptop's name, for example Laptop 01: "
  npm run device:pair -- \
    --controller=https://autobot-command-center.avgschnook.chatgpt.site \
    --code="$PAIR_CODE" \
    --name="$DEVICE_NAME"
fi

npm run device:install
open -a "Google Chrome" "chrome://extensions" || true
echo
echo "Chrome Extensions is opening. Turn on Developer mode, choose Load unpacked, and select:"
echo "$PWD/extension"
echo
echo "Keep this window open during testing. Press Control-C to stop the bridge."
npm run device
