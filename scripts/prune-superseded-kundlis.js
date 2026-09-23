/**
 * Clears out charts a seeker has already replaced.
 *
 *   npm run prune:kundlis            # shows what it would delete, changes nothing
 *   npm run prune:kundlis -- --apply # actually deletes
 *
 * Generating a chart from the Kundli tab now removes the ones it supersedes
 * (services/kundli.service.js's pruneSupersededSelfCharts), so this is only for
 * what stacked up before that: accounts holding several charts of their own,
 * from birth details they corrected one at a time.
 *
 * What it keeps, per seeker:
 *   - the chart their account's current birth details point at, if any — never
 *     delete the one the Kundli tab is about to open;
 *   - otherwise their newest `ready` chart of their own, so nobody is left with
 *     none at all;
 *   - every chart for somebody else (`partner`/`family`/`friend`/`other`) — a
 *     reading about a parent is not superseded by the seeker fixing their own
 *     birth time.
 *
 * What it never touches: KundliCache. Its rows are keyed by the birth moment,
 * not the profile, so they are shared with anyone born at the same moment and
 * they are the record of credits already paid — deleting them would mean paying
 * AstrologyAPI again for a chart somebody has already bought.
 */

const { connectDatabase, disconnectDatabase } = require('../config/database');
const BirthProfile = require('../models/BirthProfile');
const UserProfile = require('../models/UserProfile');
const { isSameBirth } = require('../services/kundliRead.service');

const APPLY = process.argv.includes('--apply');

/** "13/05/2004 08:00 Aligarh, IN" — enough to recognise a chart in the output. */
function describe(profile) {
  const details = profile.birthDetails || {};
  const day = details.dateOfBirth ? new Date(details.dateOfBirth).toISOString().slice(0, 10) : '????-??-??';
  return `${day} ${details.timeOfBirth || '??:??'} ${details.place?.formatted || '?'}`;
}

async function run() {
  await connectDatabase();

  /** Only seekers who actually have more than one chart of their own. */
  const crowded = await BirthProfile.aggregate([
    { $match: { relation: 'self' } },
    { $group: { _id: '$user', charts: { $sum: 1 } } },
    { $match: { charts: { $gt: 1 } } },
  ]);

  console.log(
    APPLY
      ? `Pruning ${crowded.length} account(s) with more than one chart of their own.\n`
      : `DRY RUN — nothing will be deleted. ${crowded.length} account(s) have more than one chart of their own.\n`,
  );

  let deleted = 0;

  for (const { _id: userId } of crowded) {
    // eslint-disable-next-line no-await-in-loop
    const [own, account] = await Promise.all([
      BirthProfile.find({ user: userId, relation: 'self' }).sort({ createdAt: -1 }).lean(),
      UserProfile.findOne({ user: userId }).select('birthDetails').lean(),
    ]);

    /** The one the Kundli tab resolves to, else the newest that has a chart behind it. */
    const current = account?.birthDetails
      ? own.find(chart => isSameBirth(account.birthDetails, chart.birthDetails))
      : undefined;
    const keep = current || own.find(chart => chart.status === 'ready') || own[0];
    const superseded = own.filter(chart => String(chart._id) !== String(keep._id));

    console.log(`user ${userId}`);
    console.log(`  keep    ${describe(keep)}${current ? '  (their current birth details)' : '  (newest)'}`);
    for (const chart of superseded) {
      console.log(`  delete  ${describe(chart)}  created ${chart.createdAt.toISOString().slice(0, 10)}`);
    }

    if (APPLY && superseded.length > 0) {
      // eslint-disable-next-line no-await-in-loop
      const result = await BirthProfile.deleteMany({ _id: { $in: superseded.map(chart => chart._id) } });
      deleted += result.deletedCount;
    } else {
      deleted += superseded.length;
    }
  }

  console.log(
    APPLY
      ? `\nDone. ${deleted} superseded chart(s) deleted. Cached sections were left alone.`
      : `\n${deleted} superseded chart(s) would be deleted. Re-run with --apply to do it.`,
  );

  await disconnectDatabase();
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
