/**
 * Seeds the admin account, so somebody can sign into the panel.
 *
 *   npm run seed:admin
 *
 * Running it again just resets the password back to the one below.
 */

const { connectDatabase, disconnectDatabase } = require('../config/database');
const Admin = require('../models/Admin');
const { hashPassword } = require('../utils/password');

const EMAIL = 'admin@shreeastro.com';
const PASSWORD = 'admin@123';
const NAME = 'Platform Admin';

async function run() {
  await connectDatabase();

  const passwordHash = await hashPassword(PASSWORD);

  await Admin.findOneAndUpdate(
    { email: EMAIL },
    {
      $set: { name: NAME, passwordHash, role: 'super_admin', status: 'active' },
    },
    { upsert: true },
  );

  console.log(`Admin ready.  ${EMAIL} / ${PASSWORD}`);

  await disconnectDatabase();
}

run().catch(async error => {
  console.error('Could not seed the admin:', error.message);
  process.exit(1);
});
