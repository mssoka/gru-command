/** Environment variables that route git to ANOTHER repository (R8-22):
 * `git rev-parse --local-env-vars` less its config carriers, plus the
 * discovery controls. They are removed for every checkout-scoped git step
 * (Perkins review steps, the project-MCP check), so the repository git
 * touches is exactly the one named by its cwd or -C. Transport and auth
 * settings (GIT_SSH*, GIT_ASKPASS, credential helpers, config parameters)
 * are kept. */
const GIT_ROUTING_ENV = [
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE', 'GIT_IMPLICIT_WORK_TREE', 'GIT_PREFIX',
  'GIT_SHALLOW_FILE', 'GIT_GRAFT_FILE', 'GIT_REPLACE_REF_BASE', 'GIT_NO_REPLACE_OBJECTS',
  'GIT_CEILING_DIRECTORIES', 'GIT_DISCOVERY_ACROSS_FILESYSTEM', 'GIT_QUARANTINE_PATH',
] as const;

/** The environment of a checkout-scoped git step: the service's own, minus
 * every repository-routing override; C-locale diagnostics on request. */
export function repositoryGitEnv(cLocale: boolean): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of GIT_ROUTING_ENV) delete env[name];
  return cLocale ? { ...env, LC_ALL: 'C' } : env;
}
