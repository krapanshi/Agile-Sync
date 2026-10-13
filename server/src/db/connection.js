import mongoose from 'mongoose';

export async function connectDatabase() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('Set MONGODB_URI in server/.env before running database commands');
  await mongoose.connect(uri, {
    autoIndex: false,
    serverSelectionTimeoutMS: 5000,
    maxPoolSize: 10
  });
  return mongoose.connection;
}

export async function disconnectDatabase() {
  await mongoose.disconnect();
}
