const sqlite3 = require('sqlite3').verbose();
const crypto = require('crypto');

// Configuration
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;
const ENCRYPTION_ALGORITHM = 'aes-256-gcm';

// Encryption function (same as in your server.js)
function encrypt(text) {
  if (!text) return null;

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(
    ENCRYPTION_ALGORITHM,
    Buffer.from(ENCRYPTION_KEY, 'hex'),
    iv
  );

  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');

  const authTag = cipher.getAuthTag();

  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
}

// Main function to encrypt all comments and summaries
async function encryptAllData() {
  if (!ENCRYPTION_KEY) {
    console.error('ENCRYPTION_KEY environment variable is not set!');
    process.exit(1);
  }

  const db = new sqlite3.Database('database.sqlite');

  try {
    // Get all moods with comments
    db.all(
      'SELECT id, comment FROM moods WHERE comment IS NOT NULL',
      [],
      (err, moodRows) => {
        if (err) {
          console.error('Error fetching moods:', err);
          return;
        }

        console.log(`Found ${moodRows.length} comments to encrypt`);

        // Update each comment
        let processedMoods = 0;
        moodRows.forEach((row) => {
          const encryptedComment = encrypt(row.comment);

          db.run(
            'UPDATE moods SET comment = ? WHERE id = ?',
            [encryptedComment, row.id],
            (err) => {
              if (err) {
                console.error(`Error updating mood ${row.id}:`, err);
              } else {
                processedMoods++;
                console.log(
                  `Processed ${processedMoods}/${moodRows.length} comments`
                );
              }
            }
          );
        });
      }
    );

    // Get all summaries
    db.all(
      'SELECT id, basic, advanced FROM summaries WHERE basic IS NOT NULL OR advanced IS NOT NULL',
      [],
      (err, summaryRows) => {
        if (err) {
          console.error('Error fetching summaries:', err);
          return;
        }

        console.log(`Found ${summaryRows.length} summaries to encrypt`);

        // Update each summary
        let processedSummaries = 0;
        summaryRows.forEach((row) => {
          const encryptedBasic = row.basic ? encrypt(row.basic) : null;
          const encryptedAdvanced = row.advanced ? encrypt(row.advanced) : null;

          db.run(
            'UPDATE summaries SET basic = ?, advanced = ? WHERE id = ?',
            [encryptedBasic, encryptedAdvanced, row.id],
            (err) => {
              if (err) {
                console.error(`Error updating summary ${row.id}:`, err);
              } else {
                processedSummaries++;
                console.log(
                  `Processed ${processedSummaries}/${summaryRows.length} summaries`
                );

                // Close database when all updates are complete
                if (processedSummaries === summaryRows.length) {
                  console.log('All data encrypted successfully!');
                  db.close();
                }
              }
            }
          );
        });
      }
    );
  } catch (error) {
    console.error('Error:', error);
    db.close();
  }
}

// Run the encryption
console.log('Starting data encryption...');
encryptAllData();
