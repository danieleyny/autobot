#!/bin/zsh
set -e
cd "${0:A:h}"

echo "AUTOBOT v0.13.0 Multi-Profile Host Setup"
echo "========================================"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required. Install the current LTS release from https://nodejs.org and run this file again."
  read "?Press Return to close."
  exit 1
fi

npm install

HOST_CONFIG="$HOME/Library/Application Support/AUTOBOT/profile-host.json"
if [[ -f "$HOST_CONFIG" ]]; then
  echo "Existing profile-host pairings found. Updating the worker extensions without changing them."
  npm run profiles:setup
else
  read "PAIR_CODE?Enter the 48-hour enrollment code: "
  read "HOST_NAME?Enter this computer's name, for example Studio Mac 1: "
  read "WORKER_COUNT?How many Chrome workers on this computer? Enter 1-4: "
  npm run profiles:setup -- \
    --controller=https://autobot-profile-host-beta.avgschnook.chatgpt.site \
    --code="$PAIR_CODE" \
    --name="$HOST_NAME" \
    --workers="$WORKER_COUNT"
fi

npm run profiles:install
echo
echo "In each numbered Chrome window, load the matching numbered extension folder shown above."
echo "Sign each profile into its own POSH account once. Keep this window open during the first session."
npm run profiles:host
