/**
 * Third-party config now lives in .env, not an encrypted Mongo row (see
 * services/integrations.service.js, utils/envFile.js). This runs against a
 * real temporary .env file in a scratch directory — never the project's own
 * — so it proves the actual file gets written and re-read correctly.
 */
process.env.NODE_ENV = 'development';

const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0, fail = 0;
const check = (l, ok, extra) => {
  if (ok) { pass += 1; console.log(`  ok   ${l}`); }
  else { fail += 1; console.log(`  FAIL ${l}${extra !== undefined ? ` -> ${JSON.stringify(extra)}` : ''}`); }
};
const section = t => console.log(`\n=== ${t} ===`);

(async () => {
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shreeastro-integrations-test-'));
  const originalCwd = process.cwd();
  process.chdir(scratchDir);

  /** A pre-existing line the write must leave untouched. */
  fs.writeFileSync(path.join(scratchDir, '.env'), '# a comment\nUNRELATED_KEY=keep-me\n');

  const { ENV_PATH } = require('../utils/envFile');
  const integrations = require('../services/integrations.service');

  section('get() — nothing saved yet');
  check('unsaved provider is null', await integrations.get('awsS3') === null);
  check('list() shows it disabled with no values', (await integrations.list()).find(r => r.provider === 'awsS3').enabled === false);

  section('save() — writes to .env and takes effect immediately, no restart');
  const saved = await integrations.save('awsS3', {
    accessKeyId: 'AKIAEXAMPLE',
    secretAccessKey: 'shh-dont-tell',
    bucket: 'my-bucket',
    region: 'ap-south-1',
  });
  check('save() returns {provider, enabled}', saved.provider === 'awsS3' && saved.enabled === true);

  const fileContent = fs.readFileSync(ENV_PATH, 'utf8');
  check('the actual .env file now has the fields', fileContent.includes('INTEGRATION_AWS_S3_BUCKET=my-bucket'));
  check('the enabled flag is in the file too', fileContent.includes('INTEGRATION_AWS_S3_ENABLED=true'));
  check('the pre-existing comment and unrelated key survive untouched', fileContent.includes('# a comment') && fileContent.includes('UNRELATED_KEY=keep-me'));
  check('process.env picked it up without a restart', process.env.INTEGRATION_AWS_S3_BUCKET === 'my-bucket');

  const config = await integrations.get('awsS3');
  check('get() now returns the real values', config?.accessKeyId === 'AKIAEXAMPLE' && config?.secretAccessKey === 'shh-dont-tell' && config?.region === 'ap-south-1');

  section('list() — secrets are masked, non-secrets are not');
  const row = (await integrations.list()).find(r => r.provider === 'awsS3');
  check('enabled reflects the save', row.enabled === true);
  check('the secret is masked, not returned in the clear', row.values.secretAccessKey !== 'shh-dont-tell' && row.values.secretAccessKey.includes('*'));
  check('a non-secret field is returned as-is', row.values.bucket === 'my-bucket');
  check('updatedAt is null — .env carries no per-row timestamp', row.updatedAt === null);

  section('save() — a blank field on re-save keeps what was already there');
  await integrations.save('awsS3', { bucket: 'my-bucket-v2' });
  const afterPartialSave = await integrations.get('awsS3');
  check('the untouched secret survives a save that only changed one field', afterPartialSave.secretAccessKey === 'shh-dont-tell');
  check('the field that was actually sent did change', afterPartialSave.bucket === 'my-bucket-v2');

  section('setEnabled() — turns it off without losing the saved values');
  await integrations.setEnabled('awsS3', false);
  check('get() now refuses to hand back a disabled provider\'s config', await integrations.get('awsS3') === null);
  check('but the raw file still has the values, not wiped', fs.readFileSync(ENV_PATH, 'utf8').includes('INTEGRATION_AWS_S3_SECRET_ACCESS_KEY=shh-dont-tell'));

  await integrations.setEnabled('awsS3', true);
  check('re-enabling brings the same values right back', (await integrations.get('awsS3'))?.bucket === 'my-bucket-v2');

  section('save() — an unknown provider is refused before touching the file');
  let threw;
  try {
    await integrations.save('not-a-real-provider', { foo: 'bar' });
  } catch (error) {
    threw = error;
  }
  check('refuses with a 400', threw?.status === 400);

  section('two providers do not collide with each other\'s env keys');
  await integrations.save('sms', { authKey: 'sms-secret', senderId: 'SHREE' });
  const sms = await integrations.get('sms');
  const s3Still = await integrations.get('awsS3');
  check('sms got its own values', sms.authKey === 'sms-secret' && sms.senderId === 'SHREE');
  check('awsS3 is untouched by the sms save', s3Still.bucket === 'my-bucket-v2' && s3Still.secretAccessKey === 'shh-dont-tell');

  process.chdir(originalCwd);
  fs.rmSync(scratchDir, { recursive: true, force: true });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error('CRASHED:', e);
  process.exit(1);
});
