import { z } from 'zod';
import { userError } from './exit.js';

export const ProjectStatusSchema = z.enum(['provisioning', 'running', 'paused']);
export type ProjectStatus = z.infer<typeof ProjectStatusSchema>;

export const ProjectSchema = z.object({
  slug: z.string(),
  createdAt: z.string(),
  status: ProjectStatusSchema,
  pgMajor: z.union([z.literal(17), z.literal(18)]),
  dokploy: z.object({
    postgresId: z.string(),
    appName: z.string(),
    backupId: z.string().optional(),
  }),
  postgres: z.object({
    database: z.string(),
    appRole: z.string(),
    appPassword: z.string(),
    appScramVerifier: z.string(),
    adminRole: z.string(),
    adminPassword: z.string(),
    extensions: z.array(z.string()),
    memoryBytes: z.number().int().positive(),
  }),
  storage: z
    .object({
      bucketId: z.string(),
      bucket: z.string(),
      keyId: z.string(),
      keySecret: z.string(),
      corsOrigins: z.array(z.string()),
      publicBaseUrl: z.string().optional(),
      aliases: z.array(z.string()),
    })
    .optional(),
  betterAuthSecret: z.string(),
});
export type Project = z.infer<typeof ProjectSchema>;

export const StateV1Schema = z.object({
  version: z.literal(1),
  projects: z.record(z.string(), ProjectSchema),
});
export type State = z.infer<typeof StateV1Schema>;
export const CURRENT_STATE_VERSION = 1;

const AnyStateSchema = z.discriminatedUnion('version', [StateV1Schema]);
// Future: add StateV2Schema above and `1: (s) => ({ ...s, version: 2 })` here.
const migrations: Record<number, (s: unknown) => unknown> = {};

export function emptyState(): State {
  return { version: 1, projects: {} };
}

export function parseState(raw: unknown): State {
  let s: unknown = AnyStateSchema.parse(raw);
  while ((s as { version: number }).version < CURRENT_STATE_VERSION) {
    const v = (s as { version: number }).version;
    const m = migrations[v];
    if (!m) throw new Error(`no migration from state version ${v}`);
    s = m(s);
  }
  return StateV1Schema.parse(s);
}

export function upsertProject(state: State, project: Project): State {
  return { ...state, projects: { ...state.projects, [project.slug]: project } };
}

export function removeProject(state: State, slug: string): State {
  const { [slug]: _removed, ...rest } = state.projects;
  return { ...state, projects: rest };
}

export function listProjects(state: State): Project[] {
  return Object.values(state.projects).sort((a, b) => a.slug.localeCompare(b.slug));
}

export function getProject(state: State, slug: string): Project {
  const p = state.projects[slug];
  if (!p)
    throw userError(
      `project ${JSON.stringify(slug)} not found in state (run \`dbm list\`)`,
      'state',
    );
  return p;
}
