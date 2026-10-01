import { IMAGES } from './compose.js';
import { PGBOUNCER_RELOAD_CRON, STORAGE_SYNC_CRON } from './cron.js';

export interface RcloneConfOptions {
  garage: { keyId: string; keySecret: string; endpoint: string };
  b2: { endpoint: string; region: string; keyId: string; keySecret: string };
}

export function renderRcloneConf(o: RcloneConfOptions): string {
  return `[garage]
type = s3
provider = Other
env_auth = false
access_key_id = ${o.garage.keyId}
secret_access_key = ${o.garage.keySecret}
endpoint = ${o.garage.endpoint}
region = garage
force_path_style = true
no_check_bucket = true

[b2]
type = s3
provider = Other
env_auth = false
access_key_id = ${o.b2.keyId}
secret_access_key = ${o.b2.keySecret}
endpoint = ${o.b2.endpoint}
region = ${o.b2.region}
force_path_style = true
no_check_bucket = true
`;
}

export interface ReloadCronOptions {
  certsDir: string;
  pgbouncerContainer: string;
}

/** /etc/cron.d/dbm-pgbouncer-reload: fix cert ownership for uid 70 (pgbouncer) and reload. RELOAD is non-disruptive. */
export function renderPgbouncerReloadCron(o: ReloadCronOptions): string {
  return `SHELL=/bin/sh
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
${PGBOUNCER_RELOAD_CRON} root chown -R 70:70 ${o.certsDir} 2>/dev/null; chmod -R go-rwx ${o.certsDir} 2>/dev/null; docker kill -s HUP ${o.pgbouncerContainer} >/dev/null 2>&1
`;
}

export interface StorageSyncCronOptions {
  network: string;
  rcloneConfDir: string;
  storageBucket: string;
}

/** /etc/cron.d/dbm-storage-sync: mirror every Garage bucket the read-only key can see, plus metadata snapshots. */
export function renderStorageSyncCron(o: StorageSyncCronOptions): string {
  const run = `docker run --rm --network ${o.network} -v ${o.rcloneConfDir}/rclone.conf:/config/rclone/rclone.conf:ro -v dbm-garage-snapshots:/snapshots:ro ${IMAGES.rclone}`;
  return `SHELL=/bin/sh
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
${STORAGE_SYNC_CRON} root ${run} sync garage: b2:${o.storageBucket}/storage --fast-list --transfers 4 >>/var/log/dbm-storage-sync.log 2>&1; ${run} copy /snapshots b2:${o.storageBucket}/garage-meta >>/var/log/dbm-storage-sync.log 2>&1
`;
}
