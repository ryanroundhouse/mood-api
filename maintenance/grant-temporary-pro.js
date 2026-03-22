const sqlite3 = require('sqlite3').verbose();
const path = require('path');

function printUsage() {
  console.log(`
Usage:
  node maintenance/grant-temporary-pro.js grant --email <email> [--months 6]
  node maintenance/grant-temporary-pro.js grant --user-id <id> [--months 6]
  node maintenance/grant-temporary-pro.js revoke --email <email>
  node maintenance/grant-temporary-pro.js revoke --user-id <id>
  node maintenance/grant-temporary-pro.js status --email <email>
  node maintenance/grant-temporary-pro.js status --user-id <id>

Notes:
  - Manual grants only affect the dedicated manualProExpiresAt field.
  - They do not modify Stripe, Apple, or Google subscription records.
  - Granting defaults to 6 months from the current time.
`);
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};

  for (let i = 0; i < rest.length; i += 1) {
    const key = rest[i];
    const value = rest[i + 1];

    if (!key.startsWith('--')) {
      throw new Error(`Unexpected argument: ${key}`);
    }

    if (value === undefined || value.startsWith('--')) {
      throw new Error(`Missing value for ${key}`);
    }

    options[key.slice(2)] = value;
    i += 1;
  }

  return { command, options };
}

function addMonths(date, months) {
  const result = new Date(date);
  result.setMonth(result.getMonth() + months);
  return result;
}

function resolveEffectiveAccountLevel(user, now = new Date()) {
  if (!user) return 'basic';
  if (user.accountLevel === 'enterprise' || user.accountLevel === 'pro') {
    return user.accountLevel;
  }
  if (user.manualProExpiresAt) {
    const expiresAt = new Date(user.manualProExpiresAt);
    if (!Number.isNaN(expiresAt.getTime()) && expiresAt > now) {
      return 'pro';
    }
  }
  return 'basic';
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (!['grant', 'revoke', 'status'].includes(command)) {
    printUsage();
    process.exit(1);
  }

  const email = options.email;
  const userId = options['user-id'] ? Number(options['user-id']) : null;
  const months = options.months ? Number(options.months) : 6;

  if ((!email && !userId) || (email && userId)) {
    throw new Error('Provide exactly one of --email or --user-id');
  }

  if (command === 'grant' && (!Number.isInteger(months) || months <= 0)) {
    throw new Error('--months must be a positive integer');
  }

  const db = new sqlite3.Database(path.join(__dirname, '../database.sqlite'));

  const getUser = () =>
    new Promise((resolve, reject) => {
      const sql = userId
        ? `SELECT id, email, accountLevel, manualProExpiresAt FROM users WHERE id = ?`
        : `SELECT id, email, accountLevel, manualProExpiresAt FROM users WHERE email = ?`;

      db.get(sql, [userId || email], (err, row) => {
        if (err) return reject(err);
        resolve(row);
      });
    });

  const run = (sql, params) =>
    new Promise((resolve, reject) => {
      db.run(sql, params, function onRun(err) {
        if (err) return reject(err);
        resolve(this);
      });
    });

  try {
    const user = await getUser();
    if (!user) {
      throw new Error('User not found');
    }

    if (command === 'grant') {
      const manualProExpiresAt = addMonths(new Date(), months).toISOString();
      await run(`UPDATE users SET manualProExpiresAt = ? WHERE id = ?`, [
        manualProExpiresAt,
        user.id,
      ]);

      console.log(
        JSON.stringify(
          {
            action: 'grant',
            userId: user.id,
            email: user.email,
            storedAccountLevel: user.accountLevel,
            manualProExpiresAt,
            effectiveAccountLevel: 'pro',
          },
          null,
          2
        )
      );
      return;
    }

    if (command === 'revoke') {
      await run(`UPDATE users SET manualProExpiresAt = NULL WHERE id = ?`, [user.id]);

      console.log(
        JSON.stringify(
          {
            action: 'revoke',
            userId: user.id,
            email: user.email,
            storedAccountLevel: user.accountLevel,
            manualProExpiresAt: null,
            effectiveAccountLevel: resolveEffectiveAccountLevel({
              ...user,
              manualProExpiresAt: null,
            }),
          },
          null,
          2
        )
      );
      return;
    }

    console.log(
      JSON.stringify(
        {
          action: 'status',
          userId: user.id,
          email: user.email,
          storedAccountLevel: user.accountLevel,
          manualProExpiresAt: user.manualProExpiresAt || null,
          effectiveAccountLevel: resolveEffectiveAccountLevel(user),
        },
        null,
        2
      )
    );
  } finally {
    await new Promise((resolve, reject) => {
      db.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

main().catch((error) => {
  console.error(error.message);
  printUsage();
  process.exit(1);
});
