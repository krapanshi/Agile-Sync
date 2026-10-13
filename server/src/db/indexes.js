import { models } from '../models/index.js';

export async function requireDatabaseIndexes() {
  for (const model of models) {
    const indexes = await model.collection.listIndexes().toArray();
    for (const [key, options] of model.schema.indexes()) {
      const exists = indexes.some(index => JSON.stringify(index.key) === JSON.stringify(key)
        && Boolean(index.unique) === Boolean(options.unique)
        && index.expireAfterSeconds === options.expireAfterSeconds);
      if (!exists) throw Object.assign(new Error('Run db:indexes before starting the server'), { code: 'MISSING_INDEX' });
    }
  }
}
