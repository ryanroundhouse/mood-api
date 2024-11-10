const sqlite3 = require('sqlite3').verbose();
const { DateTime } = require('luxon');

async function migrateSummariesTable() {
  const db = new sqlite3.Database('database.sqlite');

  try {
    console.log('Starting summaries table migration...');

    // 1. Create new temporary table with desired structure
    await new Promise((resolve, reject) => {
      db.run(
        `
        CREATE TABLE IF NOT EXISTS summaries_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          userId INTEGER NOT NULL,
          date TEXT NOT NULL,
          basic TEXT,
          advanced TEXT,
          FOREIGN KEY (userId) REFERENCES users(id)
        )
      `,
        (err) => {
          if (err) reject(err);
          else resolve();
        }
      );
    });

    // 2. Copy data from old table to new table
    console.log('Fetching existing summaries...');
    db.all('SELECT * FROM summaries', [], (err, rows) => {
      if (err) {
        console.error('Error fetching existing summaries:', err);
        return;
      }

      console.log(`Found ${rows.length} summaries to migrate`);

      let processedRows = 0;
      rows.forEach((row) => {
        // Get previous Monday's date
        const now = DateTime.now();
        const date = now.minus({ days: (now.weekday - 1) % 7 }).toISODate();

        db.run(
          'INSERT INTO summaries_new (userId, date, basic, advanced) VALUES (?, ?, ?, ?)',
          [row.id, date, row.basic, row.advanced],
          (err) => {
            if (err) {
              console.error(`Error migrating summary for user ${row.id}:`, err);
            } else {
              processedRows++;
              console.log(
                `Processed ${processedRows}/${rows.length} summaries`
              );

              // If all rows are processed, proceed with table swap
              if (processedRows === rows.length) {
                swapTables(db);
              }
            }
          }
        );
      });
    });
  } catch (error) {
    console.error('Migration error:', error);
    db.close();
  }
}

function swapTables(db) {
  console.log('All rows migrated, swapping tables...');

  db.serialize(() => {
    // Drop the old table and rename the new one
    db.run('DROP TABLE IF EXISTS summaries_old');
    db.run('ALTER TABLE summaries RENAME TO summaries_old');
    db.run('ALTER TABLE summaries_new RENAME TO summaries', (err) => {
      if (err) {
        console.error('Error swapping tables:', err);
      } else {
        console.log('Migration completed successfully!');

        // Optional: Drop the old table if everything went well
        db.run('DROP TABLE IF EXISTS summaries_old', (err) => {
          if (err) {
            console.error('Error dropping old table:', err);
          } else {
            console.log('Old table dropped successfully');
          }
          db.close();
        });
      }
    });
  });
}

// Run the migration
console.log('Starting migration process...');
migrateSummariesTable();
