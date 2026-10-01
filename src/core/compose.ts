export const IMAGES = {
  postgres18: 'postgres:18',
  postgres17: 'postgres:17',
  pgbouncer: 'edoburu/pgbouncer:v1.26.0-p0',
  garage: 'dxflrs/garage:v2.4.1',
  certsDumper: 'ldez/traefik-certs-dumper:v2.11.4',
  rclone: 'rclone/rclone:1',
} as const;

export function postgresImage(major: 17 | 18): string {
  return major === 18 ? IMAGES.postgres18 : IMAGES.postgres17;
}

export interface GarageComposeOptions {
  network: string;
  garageConfDir: string;
  adminPort: number;
}

export function renderGarageCompose(o: GarageComposeOptions): string {
  return `services:
  garage:
    image: ${IMAGES.garage}
    container_name: dbm-garage
    restart: unless-stopped
    entrypoint: ["/garage"]
    command: ["server", "--single-node"]
    environment:
      GARAGE_RPC_SECRET: \${GARAGE_RPC_SECRET}
      GARAGE_ADMIN_TOKEN: \${GARAGE_ADMIN_TOKEN}
    ports:
      - "127.0.0.1:${o.adminPort}:3903"
    volumes:
      - ${o.garageConfDir}/garage.toml:/etc/garage.toml:ro
      - dbm-garage-meta:/var/lib/garage/meta
      - dbm-garage-data:/var/lib/garage/data
      - dbm-garage-snapshots:/var/lib/garage/snapshots
    networks:
      - ${o.network}
volumes:
  dbm-garage-meta:
    name: dbm-garage-meta
  dbm-garage-data:
    name: dbm-garage-data
  dbm-garage-snapshots:
    name: dbm-garage-snapshots
networks:
  ${o.network}:
    external: true
`;
}

export interface PgbouncerComposeOptions {
  network: string;
  pgbouncerConfDir: string;
  certsDir: string;
  traefikDynamicDir: string;
  tls: 'letsencrypt' | 'self-ca';
}

export function renderPgbouncerCompose(o: PgbouncerComposeOptions): string {
  const dumper =
    o.tls === 'letsencrypt'
      ? `
  certs-dumper:
    image: ${IMAGES.certsDumper}
    container_name: dbm-certs-dumper
    restart: unless-stopped
    command:
      - file
      - --version
      - v3
      - --watch
      - --domain-subdir
      - --source
      - /acme/acme.json
      - --dest
      - /certs
    volumes:
      - ${o.traefikDynamicDir}:/acme:ro
      - ${o.certsDir}:/certs
`
      : '';
  return `services:
  pgbouncer:
    image: ${IMAGES.pgbouncer}
    container_name: dbm-pgbouncer
    restart: unless-stopped
    ports:
      - "6432:6432"
    volumes:
      # Mount the directory, not the files: dbm replaces files with rename(), which a single-file bind mount would not see.
      - ${o.pgbouncerConfDir}:/etc/pgbouncer:ro
      - ${o.certsDir}:/certs:ro
    networks:
      - ${o.network}
    healthcheck:
      test: ["CMD-SHELL", "nc -z 127.0.0.1 6432 || exit 1"]
      interval: 10s
      timeout: 3s
      retries: 5
${dumper}networks:
  ${o.network}:
    external: true
`;
}
