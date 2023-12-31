'use strict';

import { pick, pickBy } from 'lodash-es';
import S3Error from './error';

class S3Object {
  static ALLOWED_METADATA: string[] = [
    'cache-control',
    'content-disposition',
    'content-encoding',
    'content-language',
    'content-type',
    'expires',
    'x-amz-storage-class',
    'x-amz-website-redirect-location',
  ];
  static STORAGE_CLASSES: string[] = [
    'STANDARD',
    'REDUCED_REDUNDANCY',
    'STANDARD_IA',
    'ONEZONE_IA',
    'INTELLIGENT_TIERING',
    'GLACIER',
    'DEEP_ARCHIVE',
    'OUTPOSTS',
  ];

  metadata: any;
  range: any;

  constructor(
    public readonly bucket: string,
    public readonly key: string,
    public readonly content: any,
    metadata,
  ) {
    if ('x-amz-storage-class' in metadata) {
      if (!S3Object.STORAGE_CLASSES.includes(metadata['x-amz-storage-class'])) {
        throw new S3Error(
          'InvalidStorageClass',
          'The storage class you specified is not valid',
        );
      }
    }
    this.metadata = pick(metadata, [
      ...S3Object.ALLOWED_METADATA,

      // intrinsic metadata determined when retrieving objects
      'last-modified',
      'etag',
      'content-length',
    ]);
    if (!this.metadata['content-type']) {
      this.metadata['content-type'] = 'binary/octet-stream';
    }
    Object.assign(
      this.metadata,
      pickBy(metadata, (v, k) => k.startsWith('x-amz-meta-')),
    );
  }

  get size(): number {
    return Number(this.metadata['content-length']);
  }

  get lastModifiedDate(): Date {
    return new Date(this.metadata['last-modified']);
  }
}
export default S3Object;
