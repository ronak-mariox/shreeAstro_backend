/**
 * getCompatibilityFor against a fake provider — no real AstrologyAPI call.
 * Plain mongod is enough (no transactions).
 */
process.env.MONGODB_URI =
  process.env.TEST_MONGODB_URI || 'mongodb://127.0.0.1:27017/shree_astro_test_zodiac_compat';
process.env.NODE_ENV = 'development';

const mongoose = require('mongoose');
const ZodiacCompatibilityCache = require('../models/ZodiacCompatibilityCache');
const ApiUsage = require('../models/ApiUsage');
const { getCompatibilityFor } = require('../services/zodiacCompatibility.service');
const fixture = require('./fixtures/astrologyapi/zodiac_compatibility.json');

let pass = 0, fail = 0;
const check = (l, ok, extra) => {
  if (ok) { pass += 1; console.log(`  ok   ${l}`); }
  else { fail += 1; console.log(`  FAIL ${l}${extra !== undefined ? ` -> ${JSON.stringify(extra)}` : ''}`); }
};
const section = t => console.log(`\n=== ${t} ===`);

/** Answers with the real fixture shape; the percentage depends on the partner so ordering is testable. */
function fakeProvider() {
  const calls = [];
  const fn = async (sign, partner) => {
    calls.push({ sign, partner });
    await new Promise(resolve => setTimeout(resolve, 5));
    return { ...fixture, your_sign: sign, your_partner_sign: partner, compatibility_percentage: 50 + partner.length * 3 };
  };
  fn.calls = calls;
  return fn;
}

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  await mongoose.connection.dropDatabase();
  await ZodiacCompatibilityCache.init();

  section('first request fetches the eleven pairs, later ones are cache-only');
  const provider = fakeProvider();
  const first = await getCompatibilityFor('leo', provider);
  check('eleven provider calls on the first request', provider.calls.length === 11, provider.calls.length);
  check('never asks the provider about the sign itself', provider.calls.every(c => c.sign === 'leo' && c.partner !== 'leo'));
  check('eleven items, one per other sign', first.items.length === 11 && new Set(first.items.map(i => i.partner_sign)).size === 11);
  check('items sorted best match first', first.items.every((item, i) => i === 0 || first.items[i - 1].percentage >= item.percentage));
  check('rows carry the provider report text and a numeric percentage', first.items.every(i => typeof i.report === 'string' && i.report.length > 0 && typeof i.percentage === 'number'));
  check('eleven cache rows written', await ZodiacCompatibilityCache.countDocuments({ sign: 'leo' }) === 11);
  check('eleven general-pool usage rows logged', await ApiUsage.countDocuments({ endpoint: 'zodiac_compatibility', category: 'general' }) === 11);

  const second = await getCompatibilityFor('leo', provider);
  check('second request makes no provider call', provider.calls.length === 11);
  check('second request returns the same list', JSON.stringify(second) === JSON.stringify(first));

  section('partial cache only fetches what is missing');
  await ZodiacCompatibilityCache.deleteOne({ sign: 'leo', partnerSign: 'aries' });
  await getCompatibilityFor('leo', provider);
  check('exactly one more call, for the missing pair', provider.calls.length === 12 && provider.calls[11].partner === 'aries');

  section('concurrent first requests share one fetch');
  const provider2 = fakeProvider();
  await Promise.all(Array.from({ length: 6 }, () => getCompatibilityFor('virgo', provider2)));
  check('six concurrent requests -> eleven calls, not sixty-six', provider2.calls.length === 11, provider2.calls.length);

  section('provider failure -> clean 503, pairs fetched so far stay cached');
  let failCount = 0;
  const flaky = async (sign, partner) => {
    failCount += 1;
    if (failCount > 3) throw new Error('astrologyapi is down');
    return { ...fixture, your_sign: sign, your_partner_sign: partner, compatibility_percentage: 70 };
  };
  let failed = null;
  try { await getCompatibilityFor('aries', flaky); } catch (error) { failed = error; }
  check('a provider error surfaces as a 503 with a stable code', failed?.status === 503 && failed?.code === 'provider_unavailable', failed?.message);
  check('the three pairs fetched before the failure are cached', await ZodiacCompatibilityCache.countDocuments({ sign: 'aries' }) === 3);
  const retryProvider = fakeProvider();
  await getCompatibilityFor('aries', retryProvider);
  check('a retry only fetches the eight missing pairs', retryProvider.calls.length === 8, retryProvider.calls.length);

  section('input validation');
  let rejected = null;
  try { await getCompatibilityFor('dragon'); } catch (error) { rejected = error; }
  check('unknown sign -> 400', rejected?.statusCode === 400 || rejected?.status === 400, rejected?.message);

  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(error => { console.error(error); process.exit(1); });
