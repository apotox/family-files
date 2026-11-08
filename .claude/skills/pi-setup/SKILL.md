---
name: pi-setup
description: Set up Family Files on a Raspberry Pi Zero W from scratch, from a blank microSD card to an HTTPS site with nightly Google Drive backups, or fix an existing install. Use when the user asks to install, set up, flash, deploy, update or troubleshoot Family Files on a Raspberry Pi; to get a Pi onto Wi-Fi or reachable over SSH; to add HTTPS or the backup; or when a Pi "won't come online", "keeps rebooting" or "shows in the router but has no connection".
---

# Set up Family Files on a Raspberry Pi Zero W

You run on the user's computer and reach the Pi over SSH. The README in the repo root is the human version of this guide; this skill adds the order of work, the checks to run after each step, and the failures that happened in real installs.

Some steps need hands or a browser: buying the hardware, flashing the card with Raspberry Pi Imager, plugging things in, router settings, Google sign-in, and typing passwords. **Give the user one clear instruction, end your turn, and continue when they reply.** Don't wait in long polling loops: run one quick check and let the user say when to look again.

## Ground rules

- **Never print or echo a secret**: the family password, the Wi-Fi password, Cloudflare tokens, or rclone/Google tokens.
  - Secrets go from the user's keyboard straight to a file on the Pi (`read -rs`), never through your tool output.
  - `rclone authorize` prints a base64 blob that *is* the Google token. A `grep -v token` does not hide it. Write that output to a file and only ever extract the auth URL from it.
- **The Pi Zero W is slow** (a single ARMv6 core).
  - `apt full-upgrade` can take 30–60 minutes, and `npm test` takes about 40 seconds on it.
  - Use long command timeouts and run upgrades in the background.
- **Confirm before outward-facing changes**: creating DNS records or rebooting.
- **Use Debian/Raspberry Pi OS packages** (`apt`): `nodejs`, `acme.sh` and `rclone` all come from apt.
  - Official Node.js builds, nvm and NodeSource don't support ARMv6.
  - Prefer apt over piping install scripts from GitHub.

## 0. Ask first (once, all together)

1. Which Pi do they have? Zero W, Zero 2 W or another model. Everything below also works on newer Pis.
2. What Wi-Fi do they have? The network name, and whether a **2.4 GHz WPA2** network exists. The Zero W can't do 5 GHz or WPA3-only.
3. Do they own a domain with its DNS at Cloudflare? HTTPS is mandatory, because Web Crypto only works on secure pages.
4. Do they want the nightly Google Drive backup?
5. The hostname and username they'd like. Defaults: `familyfiles` and their own first name.

## 1. Hardware

Make sure they have:
- A Pi Zero W.
- A 32 GB or larger A1/A2 microSD card. The card is the family's storage, so size it accordingly.
- A **5 V 2.5 A wall adapter**.
- A card reader.

**Power is the #1 cause of "it doesn't work".** Power banks and laptop USB ports brown out the Pi the moment Wi-Fi starts.

## 2. Flash the card

- **Find the card.** On macOS run `diskutil list external physical`; on Linux run `lsblk -o NAME,SIZE,MODEL,TRAN`. Only ever touch the disk that matches the card's size and model.
- **If the card or reader misbehaves** (a format stuck at "Waiting for partitions to activate", or Imager saying "No valid storage device"), suspect the reader first. Swap readers before anything else.
- **Have the user flash it** with Raspberry Pi Imager:
  - Device: *Raspberry Pi Zero*. OS: *Raspberry Pi OS Lite (32-bit)*.
  - In *Edit settings*, set the hostname, username and password, Wi-Fi and its **country**, the locale, and **SSH with public-key auth**.
  - Give them the key: `cat ~/.ssh/id_ed25519.pub`. Create one first with `ssh-keygen -t ed25519` if it's missing.
- **Check the card after flashing** (it mounts as `bootfs`):
  - `network-config` names the SSID: `grep -A1 access-points /Volumes/bootfs/network-config | tail -1`. Don't print the password line.
  - `user-data` has the user and the SSH key.
  - Fix typos now, while the card is in the computer.

## 3. First boot and finding the Pi

- **Booting:** the user inserts the card and plugs in power. The first boot takes about 5 minutes on a Zero W.
- **Look for it** with one quick check, not a loop:
  ```sh
  ping -c2 familyfiles.local || dns-sd -G v4 familyfiles.local   # macOS; Linux: avahi-resolve -n familyfiles.local
  arp -a | grep -i -e b8:27:eb -e dc:a6:32 -e e4:5f:1 -e d8:3a:dd -e 2c:cf:67 -e 28:cd:c1   # Raspberry Pi MAC prefixes
  ```
  Also ask the user to check the router's device list.
- **If it isn't found**, work down the [troubleshooting](#troubleshooting) table. Don't re-flash blindly.
- **The macOS gotcha:** ping works from Terminal, but your tools get "No route to host". The editor or terminal app lacks **macOS Local Network permission** (System Settings → Privacy & Security → Local Network). The user enables it and restarts the app.

## 4. SSH

Add a host alias so every later command is short:

```sh
cat >> ~/.ssh/config <<'EOF'

Host pi
  HostName familyfiles.local
  User <user>
  IdentityFile ~/.ssh/id_ed25519
EOF
ssh -o BatchMode=yes pi 'hostname; uname -m; cat /proc/device-tree/model; vcgencmd get_throttled'
```

- `get_throttled` must be `throttled=0x0`. Anything else means the power supply is too weak; fix that before going on.
- If Imager wasn't given a key, copy it once with `ssh-copy-id`. The user types the password.

## 5. Update

```sh
ssh pi 'sudo apt update && sudo DEBIAN_FRONTEND=noninteractive apt full-upgrade -y' # long; run in background
ssh pi 'sudo reboot'    # ask first
```

- **If sudo asks for a password after the upgrade:** the NOPASSWD rule can disappear. Ask the user to run `sudo visudo -f /etc/sudoers.d/010_pi-nopasswd` interactively, or to run sudo commands themselves.

## 6. Install the app

```sh
ssh pi 'sudo apt install -y nodejs git && node -v'          # expect v20.x
ssh pi 'git clone https://github.com/apotox/family-files.git ~/family-files && cd ~/family-files && npm test'   # prints "ok"
```

The **family password**: the user must type it themselves. In Claude Code they can run it with the `!` prefix:

```sh
ssh -t pi 'cd ~/family-files && read -rsp "Family password: " P && echo && printf %s "$P" | node server.js set-password; unset P'
```

- Recommend a long passphrase: it is the encryption key. It can't be changed once files exist, and there is no recovery.

## 7. HTTPS (domain + Cloudflare + Let's Encrypt DNS-01)

1. **Fix the IP:** the user creates a DHCP reservation in the router for the Pi. Get the IP with `ssh pi hostname -I`.
2. **Create the DNS record:** an A record such as `files.example.com` pointing at the Pi's LAN IP, with the proxy **off** (DNS only). Confirm with the user before creating it. Check it with `dig +short files.example.com @1.1.1.1`.
3. **Allow it in the router:** if `dig @1.1.1.1` works but `dig files.example.com` (the router's DNS) returns nothing, the router's **DNS rebind protection** is blocking it. The user adds the name as an exception (FRITZ!Box, Speedport and others have this setting).
4. **Create a Cloudflare token:** the user creates one with the *Edit zone DNS* template, **limited to that one zone**, and types it into the Pi:
   ```sh
   ssh -t pi 'mkdir -p ~/.secrets && chmod 700 ~/.secrets && read -rsp "Cloudflare token: " T && echo && printf %s "$T" > ~/.secrets/cf-token && chmod 600 ~/.secrets/cf-token; unset T'
   ```
5. **Get the certificate:**
   ```sh
   ssh pi 'sudo apt install -y acme.sh && mkdir -p ~/family-files/certs && export CF_Token="$(cat ~/.secrets/cf-token)" \
     && acme.sh --home ~/.acme.sh --issue --dns dns_cf -d files.example.com --server letsencrypt \
     && acme.sh --home ~/.acme.sh --install-cert -d files.example.com \
          --fullchain-file ~/family-files/certs/fullchain.pem --key-file ~/family-files/certs/key.pem'
   ```
   acme.sh stores the token in `~/.acme.sh/account.conf` for renewals.
6. **Schedule the renewal**, then check that `crontab -l` shows it. Writing a crontab under `set -e` with `grep -v` on an empty crontab can silently produce an empty one.
   ```sh
   ssh pi '(crontab -l 2>/dev/null; echo "17 3 * * * /usr/bin/acme.sh --cron --home \$HOME/.acme.sh > /dev/null") | crontab - && crontab -l'
   ```
   The server re-reads its certificate every 12 hours, so no restart hook is needed.

## 8. Run as a service

Use the systemd unit from README step 6. Run that `sudo tee … <<EOF` block over `ssh pi 'sh -s'` so `$USER` and `$HOME` expand on the Pi. Then:

```sh
ssh pi 'sudo systemctl enable --now family-files && sleep 8 && systemctl is-active family-files'
curl -s -o /dev/null -w '%{http_code}\n' https://files.example.com/      # 200 from the user's computer
```

Then the user opens the URL, logs in, uploads a photo, and checks that its thumbnail appears.

## 9. Nightly backup (optional)

```sh
ssh pi 'sudo apt install -y rclone'
```

1. **Start the sign-in on the Pi in the background**, with the callback port forwarded to this computer. The output goes to a file on the Pi, never to you:
   ```sh
   ssh -o ExitOnForwardFailure=yes -L 53682:127.0.0.1:53682 pi \
     'mkdir -p ~/.secrets && umask 077 && rclone authorize drive eyJzY29wZSI6ImRyaXZlLmZpbGUifQ --auth-no-open-browser > ~/.secrets/rclone-auth.txt 2>&1'
   ```
   The argument is base64url, *without padding*, of `{"scope":"drive.file"}`. That scope lets rclone see only the files it creates. With padding, rclone 1.60 fails with "illegal base64 data".
2. **Open the sign-in page:** read only the URL, open it for the user, and end your turn. The user chooses the account and clicks **Allow**; the background command exits when they're done.
   ```sh
   open "$(ssh pi 'grep -o "http://127.0.0.1:53682/auth?state=[A-Za-z0-9_-]*" ~/.secrets/rclone-auth.txt')"
   ```
3. **Create the remote without printing the token:**
   ```sh
   ssh pi 'sh -s' <<'EOF'
   set -eu; umask 077; cd ~/.secrets
   node -e 'const t=require("fs").readFileSync("rclone-auth.txt","utf8");process.stdout.write(JSON.parse(Buffer.from(t.split("--->")[1].split("<---")[0].trim(),"base64url")).token)' > tok.json
   rclone config create gdrive drive scope=drive.file token="$(cat tok.json)" --non-interactive > /dev/null
   rm -f tok.json rclone-auth.txt
   rclone lsd gdrive: > /dev/null && echo connected
   EOF
   ```
4. **Schedule it and run it once:**
   ```sh
   ssh pi '(crontab -l; echo "30 2 * * * flock -n /tmp/family-backup.lock $HOME/family-files/backup.sh") | crontab - \
     && ~/family-files/backup.sh && rclone size gdrive:FamilyFilesBackup/current && du -sb ~/family-files/data'
   ```
   The byte count on Drive should match `data/`, apart from `.part` and `.tmp` files.

## 10. Harden (always do this)

Run these in order. Each block can be sent with `ssh pi 'sh -s' <<'EOF' … EOF`.

1. **Automatic updates.**
   - The default rules only allow Debian origins. Raspberry Pi OS updates come from `o=Raspbian` and `o=Raspberry Pi Foundation`, so without the extra file below it upgrades nothing.
   - Check the origins first: `apt-cache policy | grep -oE "o=[^,]+,a=[^,]+,n=[^,]+,l=[^,]+" | sort -u`.
   ```sh
   sudo DEBIAN_FRONTEND=noninteractive apt-get install -y unattended-upgrades
   sudo tee /etc/apt/apt.conf.d/52unattended-upgrades-raspbian > /dev/null <<'C'
   Unattended-Upgrade::Origins-Pattern {
     "origin=Raspbian,codename=${distro_codename},label=Raspbian";
     "origin=Raspberry Pi Foundation,codename=${distro_codename},label=Raspberry Pi Foundation";
   };
   C
   printf 'APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";\n' | sudo tee /etc/apt/apt.conf.d/20auto-upgrades > /dev/null
   sudo unattended-upgrade --dry-run --debug 2>&1 | grep "Allowed origins"   # must include Raspbian
   systemctl is-enabled apt-daily.timer apt-daily-upgrade.timer
   ```
2. **SSH with keys only.** A mistake here locks you out, and the only way back is the SD card. So first open a fallback master connection.
   - Keep the socket path short: a unix socket path must stay under 104 bytes, and long scratch paths fail.
   - The drop-in is named `01-` because sshd takes the *first* value it reads, and Imager/cloud-init leave a `50-cloud-init.conf` that may say `PasswordAuthentication yes`.
   ```sh
   ssh -o ControlMaster=yes -o ControlPath=~/.ssh/pi-safety.sock -o ControlPersist=600 -fN pi
   ssh -o ControlPath=~/.ssh/pi-safety.sock pi 'printf "PasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitRootLogin no\n" \
     | sudo tee /etc/ssh/sshd_config.d/01-keys-only.conf > /dev/null && sudo sshd -t && sudo systemctl reload ssh'
   ssh -o ControlPath=none -o BatchMode=yes pi true && echo key-login-ok        # MUST pass
   ssh -o ControlPath=none -o PubkeyAuthentication=no -o BatchMode=yes pi true  # expect "Permission denied (publickey)"
   ssh -o ControlPath=~/.ssh/pi-safety.sock -O exit pi
   ```
   If the key login fails, remove the drop-in through the fallback socket and reload sshd before doing anything else.
3. **Remove the copies of the Wi-Fi password.** It sits in plain text in:
   - `/boot/firmware/network-config`
   - `/var/log/cloud-init.log`
   - `/var/lib/cloud/instances/*`
   - macOS Spotlight files on the boot partition, if the card was ever mounted on a Mac

   No human input is needed: read the password from the NetworkManager profile into a private temp file and match against that file.
   - **Gotcha:** `sudo grep -f <(…)` silently matches nothing, because sudo closes the inherited descriptor. Use a real file.
   ```sh
   umask 077; T=$(mktemp)
   CON=$(nmcli -g NAME,TYPE con show | awk -F: '$2=="802-11-wireless"{print $1; exit}')
   sudo nmcli -s -g 802-11-wireless-security.psk con show "$CON" > "$T"
   sudo touch /etc/cloud/cloud-init.disabled && sudo cloud-init clean
   sudo rm -rf /boot/firmware/network-config /boot/firmware/.Spotlight-V100 /boot/firmware/.fseventsd
   sudo env T="$T" perl -pi -e 'BEGIN { open my $f, "<", $ENV{T} or die; chomp($p = <$f>) } s/\Q$p\E/[REDACTED]/g' /var/log/cloud-init.log
   sudo grep -rlFf "$T" /boot/firmware /var/log /var/lib /etc /run /home 2>/dev/null   # only the .nmconnection may remain
   rm -f "$T"; nmcli -g NAME,STATE con show --active                                  # Wi-Fi must still be activated
   ```
4. **Bluetooth off.**
   ```sh
   sudo systemctl disable --now bluetooth.service
   grep -q '^dtoverlay=disable-bt' /boot/firmware/config.txt || echo 'dtoverlay=disable-bt' | sudo tee -a /boot/firmware/config.txt
   ```
   The overlay takes effect after a reboot, so ask before rebooting. `hciuart.service` doesn't exist on the Zero W image; ignore that error.
5. **Shrink the Cloudflare token's reach.** A zone token on the Pi can rewrite every record on that domain. If the user hosts anything else there, propose acme.sh DNS alias mode (`--challenge-alias <spare-domain>`) so the Pi only holds a token for a spare zone.
6. **Tell the user** never to forward a router port to the Pi.

The app itself locks out an IP address after 5 wrong tokens in a row (1 s, doubling, up to 15 min; it answers 429). Restarting the service clears all lockouts.

## Done when

- [ ] `ssh pi vcgencmd get_throttled` prints `0x0`.
- [ ] `ssh pi 'cd ~/family-files && npm test'` prints `ok`.
- [ ] `systemctl is-active family-files` prints `active`, and the service is enabled.
- [ ] The HTTPS URL returns 200 from another device. The user has logged in, uploaded a file, and seen it listed.
- [ ] `crontab -l` has the acme.sh renewal (and the backup, if chosen).
- [ ] The backup has run once, and the sizes match.
- [ ] Hardening is done:
  - The `unattended-upgrade` dry run lists the Raspbian origins.
  - `sudo sshd -T` shows `passwordauthentication no`.
  - Searching the system for the Wi-Fi password finds only the `.nmconnection` file.
  - `bluetooth.service` is disabled.
- [ ] The user knows the family password can't be recovered, and that `git pull && sudo systemctl restart family-files` updates the app.

## Troubleshooting

| Symptom | Check / fix |
|---|---|
| Never appears in the router | **Power first**: use a 2.5 A wall adapter. Then check that the Wi-Fi is 2.4 GHz WPA2, and the country and SSID in `network-config`. |
| Appears, then vanishes; the green LED stops | Undervoltage: the Pi resets when the Wi-Fi radio starts. Swap the power supply. |
| Appears in the router with **0 bytes** of traffic, or never gets an IP | NetworkManager has no Wi-Fi profile. On some trixie images cloud-init/netplan writes empty `90-NM-*.yaml` files. Fix it with `scripts/wifi-fix.sh` (below). |
| You can't tell what's going on | Boot once with `scripts/diag.sh` (below) and read the report it leaves on the card. |
| ping works but your tools get "No route to host" (macOS) | Local Network permission for the editor or terminal app. |
| The page says "must be opened over https" | The user opened it via the IP address or `http://`. Use the HTTPS name. |
| The name doesn't resolve at home | Router DNS rebind protection (step 7.3). |
| "Too many wrong passwords" (HTTP 429) | The per-IP lockout. Wait it out, or `sudo systemctl restart family-files` to clear it. Don't leave scripted logins with a bad token running. |
| "Wrong password" for everyone | Check the stored config with `ssh pi cat ~/family-files/data/config.json`; it must hold a salt and a verifier, never the password. Passwords are case-sensitive. |

### One-time boot scripts (when SSH is impossible)

These scripts run *instead of* a normal boot. They write their report to the boot partition, then power the Pi off. Use this when you can't log in to the Pi at all.

1. With the card in the computer (`bootfs` mounted):
   ```sh
   B=/Volumes/bootfs            # Linux: wherever the FAT partition mounted
   cp .claude/skills/pi-setup/scripts/diag.sh "$B/"     # or wifi-fix.sh
   cp "$B/cmdline.txt" "$B/cmdline.txt.bak"
   # append to the SAME single line of cmdline.txt:
   sed -i '' '1 s|$| systemd.run=/boot/firmware/diag.sh systemd.run_success_action=poweroff systemd.unit=kernel-command-line.target|' "$B/cmdline.txt"
   ```
   On Linux, use `sed -i` instead of `sed -i ''`.
2. The user ejects the card, boots the Pi, and waits until the LED stays **off** (about 2–3 minutes), then puts the card back in the computer.
3. Read the report:
   - `diag.sh` writes `diag.txt`, `diag-heartbeat.txt` (power, temperature and clock every 3 s, which shows where it died) and `diag-dmesg.txt`.
   - `wifi-fix.sh` writes `wifi-fix.txt` and restores `cmdline.txt` by itself. After `diag.sh`, restore it yourself: `cp cmdline.txt.bak cmdline.txt`.
4. Afterwards, delete the scripts, their reports and `cmdline.txt.bak` from the boot partition.

**About `wifi-fix.sh`:** it reads the SSID and password from `network-config`, creates a WPA2 NetworkManager profile that connects automatically, enables SSH, pings the router and the internet, and logs only the password's *length*.

## Updating an existing install

```sh
ssh pi 'cd ~/family-files && git pull && npm test && sudo systemctl restart family-files'
```
