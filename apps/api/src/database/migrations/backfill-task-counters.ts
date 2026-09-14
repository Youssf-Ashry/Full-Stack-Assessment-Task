import type { Connection, Types } from 'mongoose';

/**
 * Makes `nextTaskNumber` safe for the atomic allocator. It never decreases an
 * existing counter, so it is safe to run repeatedly and during deployment.
 */
export async function backfillTaskCounters(connection: Connection): Promise<number> {
  const projects = connection.collection<{ _id: Types.ObjectId }>('projects');
  const tasks = connection.collection<{ projectId: Types.ObjectId; number: number }>('tasks');
  let updated = 0;

  for await (const project of projects.find({}, { projection: { _id: 1 } })) {
    const latest = await tasks
      .find({ projectId: project._id }, { projection: { number: 1 } })
      .sort({ number: -1 })
      .limit(1)
      .next();
    const nextTaskNumber = (latest?.number ?? 0) + 1;
    const result = await projects.updateOne({ _id: project._id }, { $max: { nextTaskNumber } });
    updated += result.modifiedCount;
  }

  return updated;
}
