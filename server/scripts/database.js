import { connectDatabase, disconnectDatabase } from '../src/db/connection.js';
import { models } from '../src/models/index.js';

const command = process.argv[2];
try {
  if (!['check', 'indexes'].includes(command)) throw new Error('Usage: database.js check|indexes');
  const database = await connectDatabase();
  await database.db.admin().ping();
  console.log('MongoDB connection OK');
  if (command === 'indexes') {
    // Add indexes without dropping existing ones. Never use syncIndexes here.
    for (const model of models) {
      await model.createIndexes();
      console.log(`Indexes ready: ${model.collection.name}`);
    }
  }
} catch (error) {
  // Avoid logging the connection string, which may contain credentials.
  console.error(`Database command failed (${error.code || error.name}). Check server/.env, network access, MongoDB availability, and duplicate data. MONGODB_URI is required.`);
  process.exitCode = 1;
} finally {
  await disconnectDatabase();
}
