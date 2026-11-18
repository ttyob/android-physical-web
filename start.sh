#!/bin/sh
set -eu

if [ ! -f "$WS_SCRCPY_CONFIG" ]; then
  mkdir -p "$(dirname "$WS_SCRCPY_CONFIG")"
  cp /app/default-config.json "$WS_SCRCPY_CONFIG"
fi

adb start-server

if [ "${IOS_ENABLED:-true}" != "false" ] && [ "${IOS_ENABLED:-true}" != "0" ]; then
  mkdir -p /var/lib/lockdown
  chmod 700 /var/lib/lockdown
  usbmuxd --foreground --user root &
fi

exec node /app/gateway.js
