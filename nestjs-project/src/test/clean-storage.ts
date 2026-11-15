import {
  AbortMultipartUploadCommand,
  DeleteObjectsCommand,
  ListMultipartUploadsCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';

/** Removes every object (and in-progress multipart upload) under a prefix of the test bucket. */
export async function cleanStorage(
  client: S3Client,
  bucket: string,
  prefix = '',
): Promise<void> {
  let token: string | undefined;
  do {
    const page = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: token,
      }),
    );
    const objects = (page.Contents ?? []).map((o) => ({
      Key: o.Key as string,
    }));
    if (objects.length > 0) {
      await client.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: objects },
        }),
      );
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);

  const uploads = await client.send(
    new ListMultipartUploadsCommand({ Bucket: bucket, Prefix: prefix }),
  );
  for (const upload of uploads.Uploads ?? []) {
    await client.send(
      new AbortMultipartUploadCommand({
        Bucket: bucket,
        Key: upload.Key as string,
        UploadId: upload.UploadId as string,
      }),
    );
  }
}
