import { resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';
import mongoose from 'mongoose';
import { backfillTaskCounters } from './migrations/backfill-task-counters';

loadEnv({ path: resolve(__dirname, '../../../../.env'), quiet: true });
loadEnv({ quiet: true });

async function migrate(): Promise<void> {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is required');
  await mongoose.connect(uri);
  const updated = await backfillTaskCounters(mongoose.connection);
  console.warn(`Task counter migration complete; updated ${updated} project(s).`);
  await mongoose.disconnect();
}

migrate().catch(async (error: unknown) => {
  console.error(error);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
