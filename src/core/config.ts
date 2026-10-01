import { z } from 'zod';

export const RemotePathsSchema = z.object({
  pgbouncerConfDir: z.string().default('/etc/dokploy/dbm/pgbouncer'),
  certsDir: z.string().default('/etc/dokploy/dbm/certs'),
  garageConfDir: z.string().default('/etc/dokploy/dbm/garage'),
  rcloneConfDir: z.string().default('/etc/dokploy/dbm/rclone'),
  traefikDynamicDir: z.string().default('/etc/dokploy/traefik/dynamic'),
  dockerNetwork: z.string().default('dokploy-network'),
  pgbouncerContainer: z.string().default('dbm-pgbouncer'),
  garageContainer: z.string().default('dbm-garage'),
  garageAdminPort: z.number().int().default(3903),
  dbPort: z.number().int().default(6432),
});

export const ConfigSchema = z.object({
  sshHost: z.string(),
  sshUser: z.string().default('root'),
  dokployUrl: z.url(),
  dokployApiKey: z.string(),
  dokployProjectId: z.string(),
  dokployEnvironmentId: z.string(),
  domain: z.string(),
  dbHost: z.string(),
  s3Host: z.string(),
  webDomain: z.string(),
  garageAdminToken: z.string(),
  garageBackupKeyId: z.string(),
  dumpsDestinationId: z.string(),
  tls: z.enum(['letsencrypt', 'self-ca']).default('letsencrypt'),
  sslCaPem: z.string().optional(),
  remote: RemotePathsSchema.prefault({}),
});
export type Config = z.infer<typeof ConfigSchema>;
export type ConfigInput = z.input<typeof ConfigSchema>;
