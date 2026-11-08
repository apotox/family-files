#!/bin/bash
# One-time Pi Wi-Fi fix. Runs instead of normal boot (via systemd.run in cmdline.txt), then:
#   creates the NetworkManager Wi-Fi profile from network-config, enables SSH, tests the connection,
#   writes wifi-fix.txt to the boot partition, restores the normal cmdline.txt, and powers off.
# Enable by appending to /boot/firmware/cmdline.txt (same line):
#   systemd.run=/boot/firmware/wifi-fix.sh systemd.run_success_action=poweroff systemd.unit=kernel-command-line.target
D=/boot/firmware
OUT=$D/wifi-fix.txt
step() { echo "== $1" >> $OUT; shift; timeout 60 "$@" >> $OUT 2>&1; echo "(exit $?)" >> $OUT; sync; }
sh() { step "$1" bash -c "$2"; }

: > $OUT
SSID=$(grep -A1 'access-points:' $D/network-config | tail -1 | sed -E 's/^ *"?([^":]*)"?:.*/\1/')
PSK=$(grep -m1 'password:' $D/network-config | sed -E 's/.*password: *"?([^"]*)"?.*/\1/')
echo "ssid=$SSID psk-length=${#PSK}" >> $OUT

# why cloud-init didn't create it (for the record)
sh   netplan-files  "ls -la /etc/netplan/ /run/NetworkManager/system-connections/ /etc/NetworkManager/system-connections/"
sh   cloud-init-log "grep -iE 'netplan|network|error|warn' /var/log/cloud-init.log | tail -40"

# the fix: a plain WPA2 profile that autoconnects on every boot
step start-nm   systemctl start NetworkManager
sleep 15
step add-wifi   nmcli con add type wifi ifname wlan0 con-name "$SSID" ssid "$SSID" \
                  wifi-sec.key-mgmt wpa-psk wifi-sec.psk "$PSK" connection.autoconnect yes
step up         nmcli con up "$SSID"
sleep 10
step ip         ip -4 addr show wlan0
sh   ping-gw    "ping -c3 -W2 \$(ip route | awk '/default/{print \$3; exit}')"
step ping-inet  ping -c3 -W2 1.1.1.1

# SSH on at every boot (cloud-init's runcmd may never have run)
step ssh-enable systemctl enable ssh
step ssh-state  systemctl is-enabled ssh

# back to a normal boot next time
cp $D/cmdline.txt.bak $D/cmdline.txt
step cmdline    cat $D/cmdline.txt
echo "== done" >> $OUT; sync
true
