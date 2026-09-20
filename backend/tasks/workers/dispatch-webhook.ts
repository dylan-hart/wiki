import { hooks } from '../../models/hooks.ts'

/**
 * One job per subscribed webhook, in a worker thread: delivery is spent waiting on somebody else's
 * server, and a busy event queues those waits in bursts the main event loop would otherwise absorb.
 *
 * A worker starts with nothing but config and a logger, so the db connection is opened on demand
 * and `hooks` is imported directly — a worker carries no `CARDINAL.models`.
 */
export async function task(job: {
  payload: {
    hookId: string
    event: string
    data: Record<string, any>
    instance: string
  }
}): Promise<void> {
  await CARDINAL.ensureDb!()
  await hooks.deliver(job.payload)
}
