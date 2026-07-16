/** Keep every renderer on one origin so browser-persisted UI settings stay shared. */
export function getDesktopDevServerOrigin(environment: NodeJS.ProcessEnv = process.env): string {
  const host = environment.MUX_DEVSERVER_HOST ?? "127.0.0.1";
  const port = environment.MUX_DEVSERVER_PORT ?? "5173";
  return `http://${host}:${port}`;
}
