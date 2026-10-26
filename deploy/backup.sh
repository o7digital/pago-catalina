#!/usr/bin/env bash
set -euo pipefail
# Run as root from a daily timer/cron. SQLite's backup API includes pending WAL data.
backup_dir=/var/backups/pago-catalina
install -d -m 700 "$backup_dir"
backup_path="$backup_dir/catalina-$(date -u +%Y%m%dT%H%M%SZ).sqlite"
/usr/bin/node --input-type=module - "$backup_path" <<'JS'
import { DatabaseSync, backup } from 'node:sqlite';
const db = new DatabaseSync('/var/lib/pago-catalina/catalina.sqlite', { readOnly: true });
await backup(db, process.argv[2]);
db.close();
JS
chmod 600 "$backup_path"
find "$backup_dir" -name 'catalina-*.sqlite' -mtime +14 -delete
