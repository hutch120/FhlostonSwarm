import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { DataDeps } from "./routes.js";

/** Presigned GET URLs for the report. The browser is sent to S3 as a download, never rendered from our origin. */
export function s3Presigner(bucket: string, client = new S3Client({})): DataDeps["presign"] {
  return (key, { filename, contentType, expiresSeconds }) =>
    getSignedUrl(
      client,
      new GetObjectCommand({
        Bucket: bucket,
        Key: key,
        ResponseContentType: contentType,
        ResponseContentDisposition: `attachment; filename="${filename}"`,
      }),
      { expiresIn: expiresSeconds },
    );
}
