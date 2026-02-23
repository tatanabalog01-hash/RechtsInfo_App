require("dotenv").config();

// db-setup.js
const fs = require("fs/promises");
const path = require("path");
const { Client } = require("pg");

async function main() {
  const DATABASE_URL = process.env.DATABASE_URL;
  if (!DATABASE_URL) {
    console.error("ERROR: DATABASE_URL is not set");
    process.exit(1);
  }

  // Render External DB обычно требует SSL
  const client = new Client({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  try {
    await client.connect();
    console.log("✅ Connected to Postgres");

    // 1) включаем pgvector
    await client.query("CREATE EXTENSION IF NOT EXISTS vector;");
    console.log("✅ pgvector extension enabled");

    // 2) применяем схему
    const sqlPath = path.join(__dirname, "sql", "law_chunks.sql");
    const schemaSQL = await fs.readFile(sqlPath, "utf8");
    await client.query(schemaSQL);
    console.log("✅ law_chunks.sql applied");

    // 3) быстрый тест
    const { rows } = await client.query("SELECT to_regclass('public.law_chunks') AS tbl;");
    console.log("✅ table check:", rows[0].tbl);

  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error("DB SETUP FAILED:", e.message);
  process.exit(1);
});
