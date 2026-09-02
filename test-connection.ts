import pg from "pg";
import "dotenv/config";

async function testConnection() {
  const client = new pg.Client({
    host: process.env.DB_HOST!,
    port: parseInt(process.env.DB_PORT || "5432"),
    user: process.env.DB_USER!,
    password: process.env.DB_PASSWORD!,
    database: process.env.DB_NAME!,
    ssl: process.env.DB_SSL === "true" ? { rejectUnauthorized: false } : undefined,
  });

  try {
    await client.connect();
    console.log("Connected successfully!");
    
    // Check if tables exist
    const result = await client.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      AND table_type = 'BASE TABLE'
      ORDER BY table_name;
    `);
    
    console.log("Tables in database:");
    console.log(result.rows);
    
    await client.end();
  } catch (error) {
    console.error("Connection error:", error);
  }
}

testConnection();