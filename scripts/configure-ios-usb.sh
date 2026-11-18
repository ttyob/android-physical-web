#!/bin/sh
set -eu

if [ "$#" -ne 0 ] || [ "$(id -u)" -ne 0 ]; then
  printf '%s\n' '用法：在 Linux 宿主机以 root 执行 sh scripts/configure-ios-usb.sh' >&2
  exit 1
fi

# Only the container should own the Apple USB interface. The distribution's
# hotplug rule otherwise resets the USB configuration and starts a competing daemon.
rule=/etc/udev/rules.d/39-usbmuxd.rules
if { [ -e "$rule" ] || [ -L "$rule" ]; } && [ "$(readlink "$rule" || true)" != /dev/null ]; then
  printf '%s\n' "保留已有自定义规则：$rule；请先检查该规则。" >&2
  exit 1
fi

command -v systemctl >/dev/null
command -v udevadm >/dev/null
systemctl mask --now usbmuxd.service
mkdir -p /etc/udev/rules.d
if [ ! -L "$rule" ]; then
  ln -s /dev/null "$rule"
fi
udevadm control --reload-rules
printf '%s\n' '已关闭宿主机 usbmuxd 自动接管，由项目容器管理 iPhone USB。'
printf '%s\n' '接下来执行 docker compose up -d --force-recreate physical-web。'
