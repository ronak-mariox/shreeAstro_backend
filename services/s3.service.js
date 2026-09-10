/**
 * File storage on AWS S3 — the production alternative to the local disk
 * storage.service.js writes to by default.
 *
 * Nothing here runs unless AWS S3 has been configured on the Third Parties
 * tab: `isConfigured()` is what middlewares/upload.middleware.js checks
 * before ever calling `upload`/`remove`, so an unconfigured S3 leaves the
 * existing local-disk path completely untouched.
 */

const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');

const integrationsService = require('./integrations.service');

/** Rebuilt only when the config actually changes, not on every upload. */
let cachedClient = null;
let cachedKey = null;

/** A real AWS region code, e.g. "ap-south-1" or "us-gov-west-1". */
const REGION_CODE_PATTERN = /[a-z]{2}(?:-gov)?-[a-z]+-\d+/i;

/**
 * The Third Parties tab takes free-text, and the AWS Console's own region
 * dropdown shows "Asia Pacific (Mumbai) ap-south-1" — pasting that whole
 * label in (rather than just the trailing code) otherwise reaches the SDK
 * verbatim and fails with "not a valid hostname component" on every upload.
 * Extracting the code here fixes it regardless of what's actually saved,
 * rather than depending on the panel entry being edited correctly.
 */
function normalizeRegion(region) {
  const match = String(region || '').match(REGION_CODE_PATTERN);
  return match ? match[0].toLowerCase() : region;
}

function clientFor(config) {
  const key = `${config.region}:${config.accessKeyId}`;
  if (cachedClient && cachedKey === key) {
    return cachedClient;
  }

  cachedClient = new S3Client({
    region: config.region,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
  });
  cachedKey = key;
  return cachedClient;
}

async function currentConfig() {
  const config = await integrationsService.get('awsS3');
  const complete = Boolean(config?.accessKeyId && config?.secretAccessKey && config?.bucket && config?.region);
  return complete ? { ...config, region: normalizeRegion(config.region) } : null;
}

/** Whether upload.middleware.js should route new uploads to S3 instead of disk. */
async function isConfigured() {
  return Boolean(await currentConfig());
}

/** Uploads a buffer under `key`, returns its public URL. */
async function upload({ buffer, key, contentType }) {
  const config = await currentConfig();
  if (!config) {
    throw new Error('AWS S3 is not configured.');
  }

  await clientFor(config).send(
    new PutObjectCommand({ Bucket: config.bucket, Key: key, Body: buffer, ContentType: contentType }),
  );

  return `https://${config.bucket}.s3.${config.region}.amazonaws.com/${key}`;
}

/** Deletes an object by key; used when a write fails after the upload landed. */
async function remove(key) {
  const config = await currentConfig();
  if (!config) {
    return;
  }
  await clientFor(config)
    .send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }))
    .catch(() => {});
}

module.exports = { isConfigured, upload, remove };
