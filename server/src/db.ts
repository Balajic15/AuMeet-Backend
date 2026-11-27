import mongoose from 'mongoose';
import { logger } from './logger.js';

export async function connectDb(uri: string): Promise<void> {
  mongoose.set('strictQuery', true);
  await mongoose.connect(uri);
  logger.info(`MongoDB connected (${mongoose.connection.name})`);
}

export async function disconnectDb(): Promise<void> {
  await mongoose.disconnect();
}
