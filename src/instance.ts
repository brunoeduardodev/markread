import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface ServerInstance {
  port: number;
  token: string;
}

const INSTANCE_FILE = join(homedir(), '.markread', 'server.json');

/** Read the local handoff record for the one long-lived markread server. */
export async function getServerInstance(): Promise<ServerInstance | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(INSTANCE_FILE, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    const { port, token } = parsed as Partial<ServerInstance>;
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535 || typeof token !== 'string' || !token) return null;
    return { port, token };
  } catch {
    return null;
  }
}

/** Atomically publish the server address so later CLI calls can hand work to it. */
export async function saveServerInstance(instance: ServerInstance): Promise<void> {
  const tmp = `${INSTANCE_FILE}.${process.pid}.tmp`;
  await mkdir(dirname(INSTANCE_FILE), { recursive: true });
  await writeFile(tmp, JSON.stringify(instance), 'utf8');
  await rename(tmp, INSTANCE_FILE);
}

/** Remove only our own record; a newer process must never be unregistered. */
export async function clearServerInstance(token: string): Promise<void> {
  const instance = await getServerInstance();
  if (instance?.token !== token) return;
  await unlink(INSTANCE_FILE).catch(() => {});
}
