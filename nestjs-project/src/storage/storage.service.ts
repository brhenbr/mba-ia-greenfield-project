import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { StorageUnavailableException } from '../common/exceptions/domain.exception';
import storageConfig from '../config/storage.config';
import { S3_INTERNAL_CLIENT, S3_PUBLIC_CLIENT } from './storage.constants';

export interface StoredPart {
  partNumber: number;
  size: number;
  etag: string;
}

export interface CompletedPart {
  partNumber: number;
  etag: string;
}

export interface StoredObjectHead {
  contentLength: number;
  contentType: string | undefined;
}

function errorName(error: unknown): string | undefined {
  return error instanceof Error ? error.name : undefined;
}

function isNotFound(error: unknown): boolean {
  const status = (error as { $metadata?: { httpStatusCode?: number } })
    ?.$metadata?.httpStatusCode;
  return (
    status === 404 ||
    ['NotFound', 'NoSuchKey', 'NoSuchBucket'].includes(errorName(error) ?? '')
  );
}

@Injectable()
export class StorageService implements OnModuleInit {
  private readonly logger = new Logger(StorageService.name);

  constructor(
    @Inject(S3_INTERNAL_CLIENT) private readonly internalClient: S3Client,
    @Inject(S3_PUBLIC_CLIENT) private readonly publicClient: S3Client,
    @Inject(storageConfig.KEY)
    private readonly config: ConfigType<typeof storageConfig>,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.ensureBucket();
  }

  /** Creates the configured bucket when missing; does nothing when it exists. */
  async ensureBucket(): Promise<void> {
    const Bucket = this.config.bucket;
    try {
      await this.internalClient.send(new HeadBucketCommand({ Bucket }));
      return;
    } catch (error) {
      if (!isNotFound(error)) {
        throw this.unavailable('ensureBucket', error);
      }
    }
    try {
      await this.internalClient.send(new CreateBucketCommand({ Bucket }));
    } catch (error) {
      if (errorName(error) !== 'BucketAlreadyOwnedByYou') {
        throw this.unavailable('ensureBucket', error);
      }
    }
  }

  async createMultipartUpload(
    key: string,
    contentType: string,
  ): Promise<string> {
    return this.guard('createMultipartUpload', async () => {
      const result = await this.internalClient.send(
        new CreateMultipartUploadCommand({
          Bucket: this.config.bucket,
          Key: key,
          ContentType: contentType,
        }),
      );
      if (!result.UploadId) {
        throw new Error('Storage returned no UploadId');
      }
      return result.UploadId;
    });
  }

  /** Signed for the public endpoint: the client PUTs the part straight to storage. */
  async presignUploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
  ): Promise<string> {
    return this.guard('presignUploadPart', () =>
      getSignedUrl(
        this.publicClient,
        new UploadPartCommand({
          Bucket: this.config.bucket,
          Key: key,
          UploadId: uploadId,
          PartNumber: partNumber,
        }),
        { expiresIn: this.config.presignExpiresSeconds },
      ),
    );
  }

  async listParts(key: string, uploadId: string): Promise<StoredPart[]> {
    return this.guard('listParts', async () => {
      const parts: StoredPart[] = [];
      let marker: string | undefined;
      do {
        const page = await this.internalClient.send(
          new ListPartsCommand({
            Bucket: this.config.bucket,
            Key: key,
            UploadId: uploadId,
            PartNumberMarker: marker,
          }),
        );
        for (const part of page.Parts ?? []) {
          parts.push({
            partNumber: part.PartNumber as number,
            size: part.Size as number,
            etag: part.ETag as string,
          });
        }
        marker = page.IsTruncated ? page.NextPartNumberMarker : undefined;
      } while (marker);
      return parts;
    });
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: CompletedPart[],
  ): Promise<void> {
    await this.guard('completeMultipartUpload', () =>
      this.internalClient.send(
        new CompleteMultipartUploadCommand({
          Bucket: this.config.bucket,
          Key: key,
          UploadId: uploadId,
          MultipartUpload: {
            Parts: parts.map((p) => ({
              PartNumber: p.partNumber,
              ETag: p.etag,
            })),
          },
        }),
      ),
    );
  }

  /** Aborting an upload that no longer exists is not an error. */
  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    try {
      await this.internalClient.send(
        new AbortMultipartUploadCommand({
          Bucket: this.config.bucket,
          Key: key,
          UploadId: uploadId,
        }),
      );
    } catch (error) {
      if (errorName(error) === 'NoSuchUpload') {
        return;
      }
      throw this.unavailable('abortMultipartUpload', error);
    }
  }

  /** Returns null when the object does not exist. */
  async headObject(key: string): Promise<StoredObjectHead | null> {
    try {
      const head = await this.internalClient.send(
        new HeadObjectCommand({ Bucket: this.config.bucket, Key: key }),
      );
      return {
        contentLength: head.ContentLength ?? 0,
        contentType: head.ContentType,
      };
    } catch (error) {
      if (isNotFound(error)) {
        return null;
      }
      throw this.unavailable('headObject', error);
    }
  }

  async putObject(
    key: string,
    body: Buffer | Uint8Array,
    contentType: string,
  ): Promise<void> {
    await this.guard('putObject', () =>
      this.internalClient.send(
        new PutObjectCommand({
          Bucket: this.config.bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
        }),
      ),
    );
  }

  /**
   * GET URL signed for the public endpoint (stream, thumbnail and download).
   * With `downloadFilename` the response is forced to `attachment`.
   */
  async presignGetObject(
    key: string,
    options: { downloadFilename?: string } = {},
  ): Promise<string> {
    const disposition = options.downloadFilename
      ? `attachment; filename="${options.downloadFilename.replace(/["\\\r\n]/g, '_')}"`
      : undefined;
    return this.guard('presignGetObject', () =>
      getSignedUrl(
        this.publicClient,
        new GetObjectCommand({
          Bucket: this.config.bucket,
          Key: key,
          ResponseContentDisposition: disposition,
        }),
        { expiresIn: this.config.presignExpiresSeconds },
      ),
    );
  }

  /** GET URL signed for the internal endpoint: read by the worker (ffprobe/ffmpeg). */
  async presignInternalGetObject(key: string): Promise<string> {
    return this.guard('presignInternalGetObject', () =>
      getSignedUrl(
        this.internalClient,
        new GetObjectCommand({ Bucket: this.config.bucket, Key: key }),
        { expiresIn: this.config.presignExpiresSeconds },
      ),
    );
  }

  private async guard<T>(operation: string, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      throw this.unavailable(operation, error);
    }
  }

  // Logs the SDK failure server-side; the client only sees a generic 503.
  private unavailable(
    operation: string,
    error: unknown,
  ): StorageUnavailableException {
    this.logger.error(
      `Storage operation ${operation} failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return new StorageUnavailableException();
  }
}
