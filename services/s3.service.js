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
  return complete ? config : null;
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
