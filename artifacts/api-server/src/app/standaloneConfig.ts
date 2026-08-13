export function standalonePort(environment: NodeJS.ProcessEnv = process.env): number {
  const rawPort = environment["PORT"];
  if (!rawPort) {
    throw new Error("PORT environment variable is required but was not provided.");
  }

  const port = Number(rawPort);
  if (Number.isNaN(port) || port <= 0) {
    throw new Error(`Invalid PORT value: "${rawPort}"`);
  }
  return port;
}
