import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

// Garage behind Traefik, path-style, region "garage".
// requestChecksumCalculation / responseChecksumValidation MUST be WHEN_REQUIRED: since @aws-sdk/client-s3 3.729.0
// the SDK signs an empty-body CRC32 into presigned PUT URLs and Garage rejects the upload with 400 InvalidDigest.
export const s3 = new S3Client({
  endpoint: process.env.S3_ENDPOINT!,
  region: process.env.S3_REGION ?? "garage",
  forcePathStyle: true,
  requestChecksumCalculation: "WHEN_REQUIRED",
  responseChecksumValidation: "WHEN_REQUIRED",
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID!,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY!,
  },
});

const Bucket = process.env.S3_BUCKET!;

/** Browser PUTs directly to this URL with the same Content-Type. Garage caps expiry at 7 days. */
export function getPresignedUploadUrl(key: string, contentType: string, expiresIn = 900) {
  return getSignedUrl(s3, new PutObjectCommand({ Bucket, Key: key, ContentType: contentType }), { expiresIn });
}

export function getPresignedDownloadUrl(key: string, expiresIn = 900) {
  return getSignedUrl(s3, new GetObjectCommand({ Bucket, Key: key }), { expiresIn });
}

export function deleteObject(key: string) {
  return s3.send(new DeleteObjectCommand({ Bucket, Key: key }));
}

/** Only for buckets made public with `dbm storage public <slug>`; served by Garage's web endpoint per host. */
export function publicUrl(key: string) {
  const base = process.env.S3_PUBLIC_BASE_URL;
  if (!base) throw new Error("Bucket is not public (S3_PUBLIC_BASE_URL unset)");
  return `${base}/${encodeURI(key)}`;
}
