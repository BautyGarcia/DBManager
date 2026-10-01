export interface HttpRouterOptions {
  name: string;
  hosts: string[];
  serviceUrl: string;
}

/** Traefik v3 file-provider fragment; Dokploy watches /etc/dokploy/traefik/dynamic and hot-reloads. */
export function renderHttpRouter(o: HttpRouterOptions): string {
  const rule = o.hosts.map((h) => `Host(\`${h}\`)`).join(' || ');
  return `http:
  routers:
    ${o.name}:
      rule: ${rule}
      entryPoints:
        - websecure
      service: ${o.name}
      tls:
        certResolver: letsencrypt
  services:
    ${o.name}:
      loadBalancer:
        servers:
          - url: ${o.serviceUrl}
`;
}

/** Exists only so Traefik requests a certificate for the PgBouncer hostname. Traffic never uses it. */
export function renderDbCertRouter(host: string): string {
  return renderHttpRouter({ name: 'dbm-db-cert', hosts: [host], serviceUrl: 'http://127.0.0.1:9' });
}
