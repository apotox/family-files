#!/bin/bash
# One-time Pi diagnostic. Runs instead of normal boot, writes diag*.txt to the boot partition, then powers off.
# Enable by appending to /boot/firmware/cmdline.txt (same line):
#   systemd.run=/boot/firmware/diag.sh systemd.run_success_action=poweroff systemd.unit=kernel-command-line.target
# Undo: restore cmdline.txt from cmdline.txt.bak and delete diag.sh.
#
# Output (on the boot partition):
#   diag.txt            full report: system, power, temperature, memory, storage, services, Wi-Fi
#   diag-heartbeat.txt  every 3s: uptime, throttle/under-voltage flags, core volts, temperature, ARM clock
#   diag-dmesg.txt      live kernel log
D=/boot/firmware
OUT=$D/diag.txt
# each step gets a time limit and is flushed to the card right away, so a hang still leaves a partial report
step() { echo "== $1" >> $OUT; shift; timeout 30 "$@" >> $OUT 2>&1; echo "(exit $?)" >> $OUT; sync; }
sh() { step "$1" bash -c "$2"; }

: > $OUT; : > $D/diag-heartbeat.txt; : > $D/diag-dmesg.txt
( while true; do
    echo "$(cut -d' ' -f1 /proc/uptime)s $(vcgencmd get_throttled) $(vcgencmd measure_volts core) $(vcgencmd measure_temp) $(vcgencmd measure_clock arm)"
    sync; sleep 3
  done >> $D/diag-heartbeat.txt 2>&1 ) &
dmesg -w >> $D/diag-dmesg.txt 2>&1 &

echo "######## BASELINE (before Wi-Fi) ########" >> $OUT

# --- system
step model         cat /proc/device-tree/model
sh   cpuinfo       "grep -E 'model name|Hardware|Revision|Serial' /proc/cpuinfo"
step kernel        uname -a
step os            cat /etc/os-release
step firmware      vcgencmd version
step uptime        uptime

# --- power (get_throttled bits: 0x1 under-voltage now, 0x4 throttled now, 0x10000 under-voltage occurred, 0x40000 throttled occurred)
step throttled     vcgencmd get_throttled
sh   volts         "for v in core sdram_c sdram_i sdram_p; do echo \$v \$(vcgencmd measure_volts \$v); done"

# --- temperature & clocks
step temp          vcgencmd measure_temp
sh   temp-sysfs    "awk '{print \$1/1000 \" C\"}' /sys/class/thermal/thermal_zone0/temp"
sh   clocks        "for c in arm core sd uart emmc; do echo \$c \$(vcgencmd measure_clock \$c); done"
sh   mem-split     "vcgencmd get_mem arm; vcgencmd get_mem gpu"
step config        vcgencmd get_config int

# --- memory & cpu
step free          free -h
step loadavg       cat /proc/loadavg
sh   top           "top -bn1 | head -20"

# --- storage
step lsblk         lsblk -f
step df            df -h
sh   sdcard-info   "cd /sys/block/mmcblk0/device && for f in name manfid oemid date serial; do echo \$f \$(cat \$f); done"
step mounts        findmnt -t ext4,vfat

# --- services & first-boot setup
step failed-units  systemctl --failed --no-pager
step cloud-init    cloud-init status --long
step hostname      hostnamectl
sh   users         "ls -la /home; getent passwd 1000"

echo "######## WI-FI ########" >> $OUT
sh   wifi-driver   "lsmod | grep -E 'brcm|cfg80211'"
step rfkill        rfkill list
step reg           iw reg get
step start-nm      systemctl start NetworkManager
sleep 90
step heartbeat-ok  uptime
step rfkill-after  rfkill list
step iw-dev        iw dev
step link          iw dev wlan0 link
step nm-general    nmcli general status
step nmcli-dev     nmcli dev
step connections   nmcli -f NAME,TYPE,DEVICE,AUTOCONNECT con show
step visible-nets  nmcli -f SSID,CHAN,SIGNAL,SECURITY dev wifi list
step ip            ip addr
step route         ip route
step dns           cat /etc/resolv.conf
sh   ping-gw       "ping -c3 -W2 \$(ip route | awk '/default/{print \$3; exit}')"
step ping-inet     ping -c3 -W2 1.1.1.1
sh   nm-log        "journalctl -b -u NetworkManager -u wpa_supplicant --no-pager | tail -80"

echo "######## AFTER ########" >> $OUT
step throttled-end vcgencmd get_throttled
step temp-end      vcgencmd measure_temp
sh   warnings      "journalctl -b -p warning --no-pager | tail -100"
echo "== done" >> $OUT; sync
true
