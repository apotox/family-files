#!/bin/sh
# Nightly backup of the encrypted store to Google Drive, via the rclone remote "gdrive" (scope drive.file:
# it can only see what it created). Everything copied is already ciphertext; config.json holds the salt,
# so data/ plus the family password is all a restore needs:
#   rclone copy gdrive:FamilyFilesBackup/current ~/app/data
# Files deleted or replaced here are kept in deleted/<date> on Drive rather than vanishing from the backup.
# cron: 30 2 * * * flock -n /tmp/family-backup.lock /path/to/app/backup.sh
set -eu
cd "$(dirname "$0")"
exec rclone sync data gdrive:FamilyFilesBackup/current \
  --backup-dir "gdrive:FamilyFilesBackup/deleted/$(date +%F)" \
  --exclude '*.part' --exclude '*.tmp' \
  --log-file "$HOME/family-files-backup.log" --log-level NOTICE
