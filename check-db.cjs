require("dotenv").config();

// check-db.cjs
const { Client } = require("pg");

(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.log("ERROR: DATABASE_URL not set");
    process.exit(1);
  }

  const c = new Client({
    connectionString: url,
    ssl: { rejectUnauthorized: false },
  });

  try {
    await c.connect();

    // 1) есть ли таблица
    const r1 = await c.query("SELECT to_regclass('public.law_chunks') AS t");
    console.log("table:", r1.rows[0].t);

    // 2) сколько строк (после ingest будет > 0)
    const r2 = await c.query("SELECT COUNT(*)::int AS n FROM public.law_chunks");
    console.log("rows:", r2.rows[0].n);

  } catch (e) {
    console.log("ERR:", e.message);
    process.exit(1);
  } finally {
    await c.end();
  }
})();
