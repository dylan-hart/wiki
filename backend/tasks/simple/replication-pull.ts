export async function task(): Promise<void> {
  await CARDINAL.models.replication.pull()
}
