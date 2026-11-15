import { Queue } from 'bullmq';

/** Empties (obliterates) the given queues under the test queue prefix. */
export async function cleanQueues(
  names: string[],
  connection: { host: string; port: number },
  prefix: string,
): Promise<void> {
  for (const name of names) {
    const queue = new Queue(name, { connection, prefix });
    try {
      await queue.obliterate({ force: true });
    } finally {
      await queue.close();
    }
  }
}
