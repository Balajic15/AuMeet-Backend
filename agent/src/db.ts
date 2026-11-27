import { MongoClient, type Db } from 'mongodb';

/** One connection per meeting job, shared by the transcript and insights stores. */
export async function connectMongo(uri: string): Promise<{ db: Db; close: () => Promise<void> }> {
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 });
  await client.connect();
  return { db: client.db(), close: () => client.close() };
}
