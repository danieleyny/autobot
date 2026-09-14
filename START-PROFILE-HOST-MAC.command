#!/bin/zsh
cd "${0:A:h}" || exit 1
npm run profiles:launch
status=$?
if (( status != 0 )); then
  echo ""
  echo "AUTOBOT could not start. Review the message above."
  read -r "?Press Return to close."
fi
exit $status
