import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config } from './config.js';

export const storageReady = Boolean(config.R2_ACCOUNT_ID && config.R2_ACCESS_KEY_ID && config.R2_SECRET_ACCESS_KEY);

const client = storageReady ? new S3Client({
  region: 'auto',
  endpoint: `https://${config.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: config.R2_ACCESS_KEY_ID!, secretAccessKey: config.R2_SECRET_ACCESS_KEY! }
}) : null;

export async function createUploadUrl(objectKey: string, contentType: string) {
  if (!client) throw new Error('R2 no está configurado');
  return getSignedUrl(client, new PutObjectCommand({ Bucket: config.R2_BUCKET, Key: objectKey, ContentType: contentType }), { expiresIn: 600 });
}

export async function uploadObject(objectKey: string, contentType: string, body: Buffer) {
  if (!client) throw new Error('R2 no está configurado');
  await client.send(new PutObjectCommand({
    Bucket: config.R2_BUCKET,
    Key: objectKey,
    ContentType: contentType,
    Body: body
  }));
  return { contentType, sizeBytes: body.byteLength };
}

export async function createDownloadUrl(objectKey: string) {
  if (!client) throw new Error('R2 no está configurado');
  return getSignedUrl(client, new GetObjectCommand({ Bucket: config.R2_BUCKET, Key: objectKey }), { expiresIn: 300 });
}

export async function verifyUpload(objectKey: string) {
  if (!client) throw new Error('R2 no está configurado');
  const result = await client.send(new HeadObjectCommand({ Bucket: config.R2_BUCKET, Key: objectKey }));
  return { contentType: result.ContentType, sizeBytes: result.ContentLength };
}
