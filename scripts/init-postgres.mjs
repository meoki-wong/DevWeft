import { DB_DIALECT, openDb } from '../db.js'

if (DB_DIALECT !== 'postgres') {
  throw new Error('Set AWP_DB_DIALECT=postgres before initializing the PostgreSQL schema.')
}

const database = await openDb()
try {
  console.log('PostgreSQL baseline registration and forward migrations are ready.')
} finally {
  await database.close()
}
