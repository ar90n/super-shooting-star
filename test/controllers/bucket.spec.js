'use strict';

import { createRequire } from 'node:module';
import { expect } from 'chai';
import {
  CreateBucketCommand,
  PutBucketWebsiteCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  DeleteBucketCommand,
  ListObjectsCommand,
  ListObjectsV2Command,
  DeleteBucketCorsCommand,
  GetBucketCorsCommand,
  GetBucketWebsiteCommand,
  DeleteBucketWebsiteCommand,
  PutBucketCorsCommand,
  GetBucketLocationCommand,
} from '@aws-sdk/client-s3';
import fs from 'fs';
import { find } from 'lodash-es';
import { createServerAndClient2, generateTestObjects } from '../helpers';

const require = createRequire(import.meta.url);

describe('Operations on Buckets', () => {
  let s3Client;
  const buckets = [
    // plain, unconfigured bucket
    {
      name: 'bucket-a',
    },

    // AWS default CORS settings when enabling it in the UI
    {
      name: 'cors-test0',
      configs: [fs.readFileSync(require.resolve('../fixtures/cors-test0.xml'))],
    },

    // A standard static hosting configuration with no custom error page
    {
      name: 'website-test0',
      configs: [
        fs.readFileSync(require.resolve('../fixtures/website-test0.xml')),
      ],
    },
  ];

  beforeEach(async function () {
    ({ s3Client } = await createServerAndClient2({
      configureBuckets: buckets,
      allowMismatchedSignatures: true, // TODO: Remove this line by fixing signature mismatch
    }));
  });

  afterEach(async function () {
    s3Client.destroy();
  });

  describe('DELETE Bucket', () => {
    test('deletes a bucket', async function () {
      await s3Client.send(new DeleteBucketCommand({ Bucket: 'bucket-a' }));
    });

    test('deletes a bucket configured with CORS', async function () {
      await s3Client.send(new DeleteBucketCommand({ Bucket: 'cors-test0' }));
    });

    test('deletes an empty bucket after a key nested in a directory has been deleted', async function () {
      await s3Client.send(
        new PutObjectCommand({
          Bucket: 'bucket-a',
          Key: 'foo/bar/foo.txt',
          Body: 'Hello!',
        }),
      );
      await s3Client.send(
        new DeleteObjectCommand({ Bucket: 'bucket-a', Key: 'foo/bar/foo.txt' }),
      );
      await s3Client.send(new DeleteBucketCommand({ Bucket: 'bucket-a' }));
    });

    test('fails to delete a bucket because it is not empty', async function () {
      let error;
      await generateTestObjects(s3Client, 'bucket-a', 20);
      try {
        await s3Client.send(new DeleteBucketCommand({ Bucket: 'bucket-a' }));
      } catch (err) {
        error = err;
      }
      expect(error).to.exist;
      expect(error.Code).to.equal('BucketNotEmpty');
      expect(error.$response.statusCode).to.equal(409);
    });

    it('fails to fetch a deleted bucket', async function () {
      let error;
      await s3Client.send(new DeleteBucketCommand({ Bucket: 'bucket-a' }));
      try {
        await s3Client.send(new ListObjectsCommand({ Bucket: 'bucket-a' }));
      } catch (err) {
        error = err;
      }
      expect(error).to.exist;
      expect(error.Code).to.equal('NoSuchBucket');
      expect(error.$response.statusCode).to.equal(404);
    });
  });

  describe('DELETE Bucket cors', () => {
    test('deletes a CORS configuration in a configured bucket', async function () {
      let error;
      try {
        await s3Client.send(
          new DeleteBucketCorsCommand({ Bucket: 'cors-test0' }),
        );
        await s3Client.send(new GetBucketCorsCommand({ Bucket: 'cors-test0' }));
      } catch (err) {
        error = err;
      }
      expect(error).to.exist;
      expect(error.Code).to.equal('NoSuchCORSConfiguration');
    });
  });

  describe('DELETE Bucket website', () => {
    test('deletes a website configuration in a configured bucket', async function () {
      await s3Client.send(
        new DeleteBucketWebsiteCommand({ Bucket: 'website-test0' }),
      );
      let error;
      try {
        await s3Client.send(
          new GetBucketWebsiteCommand({ Bucket: 'website-test0' }),
        );
      } catch (err) {
        error = err;
      }
      expect(error).to.exist;
      expect(error.Code).to.equal('NoSuchWebsiteConfiguration');
    });
  });

  describe('GET Bucket (List Objects) Version 1', () => {
    const testObjects = [
      'akey1',
      'akey2',
      'akey3',
      'key/key1',
      'key1',
      'key2',
      'key3',
    ];

    const createTestObjects = () =>
      Promise.all(
        testObjects.map((key) =>
          s3Client.send(
            new PutObjectCommand({
              Bucket: 'bucket-a',
              Key: key,
              Body: 'Hello!',
            }),
          ),
        ),
      );

    test('lists objects in a bucket', async function () {
      await createTestObjects();
      const data = await s3Client.send(
        new ListObjectsCommand({ Bucket: 'bucket-a' }),
      );
      expect(data.Name).to.equal('bucket-a');
      expect(data.Contents).to.have.lengthOf(testObjects.length);
      expect(data.IsTruncated).to.be.false;
      expect(data.MaxKeys).to.equal(1000);
    });

    test('lists objects in a bucket filtered by a prefix', async function () {
      await createTestObjects();
      const data = await s3Client.send(
        new ListObjectsCommand({ Bucket: 'bucket-a', Prefix: 'key' }),
      );
      expect(data.Contents).to.have.lengthOf(4);
      expect(find(data.Contents, { Key: 'akey1' })).to.not.exist;
      expect(find(data.Contents, { Key: 'akey2' })).to.not.exist;
      expect(find(data.Contents, { Key: 'akey3' })).to.not.exist;
    });

    test('lists objects in a bucket starting after a marker', async function () {
      await createTestObjects();
      const data = await s3Client.send(
        new ListObjectsCommand({
          Bucket: 'bucket-a',
          Marker: 'akey3',
        }),
      );
      expect(data.Contents).to.have.lengthOf(4);
    });

    test('lists objects in a bucket filtered by a prefix starting after a marker', async function () {
      await createTestObjects();
      const data = await s3Client.send(
        new ListObjectsCommand({
          Bucket: 'bucket-a',
          Prefix: 'akey',
          Marker: 'akey2',
        }),
      );
      expect(data.Contents).to.have.lengthOf(1);
      expect(data.Contents[0]).to.have.property('Key', 'akey3');
    });

    test('lists 100 objects without returning the next marker', async function () {
      await generateTestObjects(s3Client, 'bucket-a', 200);
      const data = await s3Client.send(
        new ListObjectsCommand({ Bucket: 'bucket-a', MaxKeys: 100 }),
      );
      expect(data.IsTruncated).to.be.true;
      expect(data.Contents).to.have.lengthOf(100);
      expect(data.NextMarker).to.not.exist;
    }, 30000);

    test('lists 100 delimited objects and return the next marker', async function () {
      await generateTestObjects(s3Client, 'bucket-a', 200);
      const data = await s3Client.send(
        new ListObjectsCommand({
          Bucket: 'bucket-a',
          MaxKeys: 100,
          Delimiter: '/',
        }),
      );
      expect(data.IsTruncated).to.be.true;
      expect(data.Contents).to.have.lengthOf(100);
      expect(data.NextMarker).to.equal('key099');
    }, 30000);

    test('lists no objects for a bucket', async function () {
      const objects = await s3Client.send(
        new ListObjectsCommand({ Bucket: 'bucket-a' }),
      );
      expect(objects.Contents).not.exist;
    });
  });

  describe('GET Bucket (List Objects) Version 2', () => {
    test('lists objects in a bucket filtered by a prefix', async function () {
      const testObjects = [
        'akey1',
        'akey2',
        'akey3',
        'key/key1',
        'key1',
        'key2',
        'key3',
      ];
      await Promise.all(
        testObjects.map((key) =>
          s3Client.send(
            new PutObjectCommand({
              Bucket: 'bucket-a',
              Key: key,
              Body: 'Hello!',
            }),
          ),
        ),
      );
      const data = await s3Client.send(
        new ListObjectsV2Command({ Bucket: 'bucket-a', Prefix: 'key' }),
      );
      expect(data.Contents).to.have.lengthOf(4);
      expect(find(data.Contents, { Key: 'akey1' })).to.not.exist;
      expect(find(data.Contents, { Key: 'akey2' })).to.not.exist;
      expect(find(data.Contents, { Key: 'akey3' })).to.not.exist;
    });

    it('lists objects in a bucket starting after a key', async function () {
      const testObjects = [
        'akey1',
        'akey2',
        'akey3',
        'key/key1',
        'key1',
        'key2',
        'key3',
      ];
      await Promise.all(
        testObjects.map((key) =>
          s3Client.send(
            new PutObjectCommand({
              Bucket: 'bucket-a',
              Key: key,
              Body: 'Hello!',
            }),
          ),
        ),
      );
      const data = await s3Client.send(
        new ListObjectsV2Command({
          Bucket: 'bucket-a',
          StartAfter: 'akey3',
        }),
      );
      expect(data.Contents).to.have.lengthOf(4);
    });

    test('lists objects in a bucket starting after a nonexistent key', async function () {
      const testObjects = [
        'akey1',
        'akey2',
        'akey3',
        'key/key1',
        'key1',
        'key2',
        'key3',
      ];
      await Promise.all(
        testObjects.map((key) =>
          s3Client.send(
            new PutObjectCommand({
              Bucket: 'bucket-a',
              Key: key,
              Body: 'Hello!',
            }),
          ),
        ),
      );
      const data = await s3Client.send(
        new ListObjectsV2Command({
          Bucket: 'bucket-a',
          StartAfter: 'akey4',
        }),
      );
      expect(data.Contents).to.have.lengthOf(4);
    });

    test('lists prefix/foo after prefix.foo in a bucket', async function () {
      const testObjects = ['prefix.foo', 'prefix/foo'];
      await Promise.all(
        testObjects.map((key) =>
          s3Client.send(
            new PutObjectCommand({
              Bucket: 'bucket-a',
              Key: key,
              Body: 'Hello!',
            }),
          ),
        ),
      );
      const data = await s3Client.send(
        new ListObjectsV2Command({
          Bucket: 'bucket-a',
          Delimiter: '/',
          StartAfter: 'prefix.foo',
        }),
      );
      expect(data.Contents).not.exist;
      expect(data.CommonPrefixes).to.have.lengthOf(1);
      expect(data.CommonPrefixes[0]).to.have.property('Prefix', 'prefix/');
    });

    test('lists objects in a bucket filtered prefix starting after a key', async function () {
      const testObjects = [
        'akey1',
        'akey2',
        'akey3',
        'key/key1',
        'key1',
        'key2',
        'key3',
      ];
      await Promise.all(
        testObjects.map((key) =>
          s3Client.send(
            new PutObjectCommand({
              Bucket: 'bucket-a',
              Key: key,
              Body: 'Hello!',
            }),
          ),
        ),
      );
      const data = await s3Client.send(
        new ListObjectsV2Command({
          Bucket: 'bucket-a',
          Prefix: 'akey',
          StartAfter: 'akey2',
        }),
      );
      expect(data.Contents).to.have.lengthOf(1);
      expect(data.Contents[0]).to.have.property('Key', 'akey3');
    });

    test('lists objects in a bucket filtered by a delimiter', async function () {
      const testObjects = [
        'akey1',
        'akey2',
        'akey3',
        'key/key1',
        'key1',
        'key2',
        'key3',
      ];
      await Promise.all(
        testObjects.map((key) =>
          s3Client.send(
            new PutObjectCommand({
              Bucket: 'bucket-a',
              Key: key,
              Body: 'Hello!',
            }),
          ),
        ),
      );
      const data = await s3Client.send(
        new ListObjectsV2Command({ Bucket: 'bucket-a', Delimiter: '/' }),
      );
      expect(data.Contents).to.have.lengthOf(6);
      expect(data.CommonPrefixes).to.have.lengthOf(1);
      expect(data.CommonPrefixes[0]).to.have.property('Prefix', 'key/');
    });

    test('lists folders in a bucket filtered by a prefix and a delimiter', async function () {
      const testObjects = [
        'folder1/file1.txt',
        'folder1/file2.txt',
        'folder1/folder2/file3.txt',
        'folder1/folder2/file4.txt',
        'folder1/folder2/file5.txt',
        'folder1/folder2/file6.txt',
        'folder1/folder4/file7.txt',
        'folder1/folder4/file8.txt',
        'folder1/folder4/folder5/file9.txt',
        'folder1/folder3/file10.txt',
      ];

      await Promise.all(
        testObjects.map((key) =>
          s3Client.send(
            new PutObjectCommand({
              Bucket: 'bucket-a',
              Key: key,
              Body: 'Hello!',
            }),
          ),
        ),
      );

      const data = await s3Client.send(
        new ListObjectsV2Command({
          Bucket: 'bucket-a',
          Prefix: 'folder1/',
          Delimiter: '/',
        }),
      );
      expect(data.CommonPrefixes).to.have.lengthOf(3);
      expect(data.CommonPrefixes[0]).to.have.property(
        'Prefix',
        'folder1/folder2/',
      );
      expect(data.CommonPrefixes[1]).to.have.property(
        'Prefix',
        'folder1/folder3/',
      );
      expect(data.CommonPrefixes[2]).to.have.property(
        'Prefix',
        'folder1/folder4/',
      );
    });

    test.skip('truncates a listing to 500 objects', async function () {
      await generateTestObjects(s3Client, 'bucket-a', 1000);
      let data;
      try {
        data = await s3Client.send(
          new ListObjectsV2Command({ Bucket: 'bucket-a', MaxKeys: 500 }),
        );
      } catch (e) {
        // mosty happen in node 18 with the error "EMFILE: too many open files"
        if (e.Code === 'InternalError') {
          this.skip();
        }
      }
      expect(data.IsTruncated).to.be.true;
      expect(data.KeyCount).to.equal(500);
      expect(data.Contents).to.have.lengthOf(500);
    }, 30000);

    test('reports no truncation when setting max keys to 0', async function () {
      await generateTestObjects(s3Client, 'bucket-a', 100);
      const data = await s3Client.send(
        new ListObjectsV2Command({ Bucket: 'bucket-a', MaxKeys: 0 }),
      );
      expect(data.IsTruncated).to.be.false;
      expect(data.KeyCount).to.equal(0);
      expect(data.Contents).not.exist;
    });

    test.skip('lists at most 1000 objects', async function () {
      await generateTestObjects(s3Client, 'bucket-a', 1100);
      let data;
      try {
        data = await s3Client.send(
          new ListObjectsV2Command({ Bucket: 'bucket-a', MaxKeys: 1100 }),
        );
      } catch (e) {
        // mosty happen in node 18 with the error "EMFILE: too many open files"
        if (e.Code === 'InternalError') {
          this.skip();
        }
      }
      expect(data.IsTruncated).to.be.true;
      expect(data.MaxKeys).to.equal(1100);
      expect(data.Contents).to.have.lengthOf(1000);
      expect(data.KeyCount).to.equal(1000);
    }, 30000);

    test.skip('lists 100 objects and return a continuation token', async function () {
      await generateTestObjects(s3Client, 'bucket-a', 200);
      let data;
      try {
        data = await s3Client.send(
          new ListObjectsV2Command({ Bucket: 'bucket-a', MaxKeys: 100 }),
        );
      } catch (e) {
        // mosty happen in node 18 with the error "EMFILE: too many open files"
        if (e.Code === 'InternalError') {
          this.skip();
        }
      }
      expect(data.IsTruncated).to.be.true;
      expect(data.Contents).to.have.lengthOf(100);
      expect(data.KeyCount).to.equal(100);
      expect(data.NextContinuationToken).to.exist;
    }, 30000);

    test.skip('lists additional objects using a continuation token', async function () {
      await generateTestObjects(s3Client, 'bucket-a', 500);
      let data;
      try {
        data = await s3Client.send(
          new ListObjectsV2Command({ Bucket: 'bucket-a', MaxKeys: 400 }),
        );
      } catch (e) {
        // mosty happen in node 18 with the error "EMFILE: too many open files"
        if (e.Code === 'InternalError') {
          this.skip();
        }
      }
      expect(data.IsTruncated).to.be.true;
      expect(data.Contents).to.have.lengthOf(400);
      expect(data.NextContinuationToken).to.exist;
      const nextData = await s3Client.send(
        new ListObjectsV2Command({
          Bucket: 'bucket-a',
          ContinuationToken: data.NextContinuationToken,
        }),
      );
      expect(nextData.Contents).to.have.lengthOf(100);
      expect(nextData.ContinuationToken).to.equal(data.NextContinuationToken);
      expect(nextData.NextContinuationToken).to.not.exist;
    }, 30000);
  });

  describe('GET Bucket cors', () => {});

  describe('GET Bucket location', () => {
    test.skip('returns default bucket location', async function () {
      const location = await s3Client.send(
        new GetBucketLocationCommand({
          Bucket: 'bucket-a',
        }),
      );
      expect(location).to.have.property('LocationConstraint', '');
    });
  });

  describe('GET Bucket website', () => {});

  describe('PUT Bucket', () => {
    test('creates a bucket with valid domain-style name', async function () {
      await s3Client.send(
        new CreateBucketCommand({ Bucket: 'a-test.example.com' }),
      );
    });

    test('fails to create a bucket because of invalid name', async function () {
      let error;
      try {
        await s3Client.send(new CreateBucketCommand({ Bucket: '-$%!nvalid' }));
      } catch (err) {
        error = err;
      }
      expect(error).to.exist;
      expect(error.$response.statusCode).to.equal(400);
      expect(error.Code).to.equal('InvalidBucketName');
    });

    test('fails to create a bucket because of invalid domain-style name', async function () {
      let error;
      try {
        await s3Client.send(
          new CreateBucketCommand({ Bucket: '.example.com' }),
        );
      } catch (err) {
        error = err;
      }
      expect(error).to.exist;
      expect(error.$response.statusCode).to.equal(400);
      expect(error.Code).to.equal('InvalidBucketName');
    });

    test('fails to create a bucket because name is too long', async function () {
      let error;
      try {
        await s3Client.send(
          new CreateBucketCommand({ Bucket: 'abcd'.repeat(16) }),
        );
      } catch (err) {
        error = err;
      }
      expect(error).to.exist;
      expect(error.$response.statusCode).to.equal(400);
      expect(error.Code).to.equal('InvalidBucketName');
    });

    test('fails to create a bucket because name is too short', async function () {
      let error;
      try {
        await s3Client.send(new CreateBucketCommand({ Bucket: 'ab' }));
      } catch (err) {
        error = err;
      }
      expect(error).to.exist;
      expect(error.$response.statusCode).to.equal(400);
      expect(error.Code).to.equal('InvalidBucketName');
    });
  });

  describe('PUT Bucket cors', () => {
    test('puts a CORS configuration in an unconfigured bucket', async function () {
      await s3Client.send(
        new PutBucketCorsCommand({
          Bucket: 'bucket-a',
          CORSConfiguration: {
            CORSRules: [
              {
                AllowedOrigins: ['*'],
                AllowedMethods: ['GET', 'HEAD'],
              },
            ],
          },
        }),
      );
      await s3Client.send(new GetBucketCorsCommand({ Bucket: 'bucket-a' }));
    });
  });

  describe('PUT Bucket website', () => {
    test('puts a website configuration in an unconfigured bucket', async function () {
      await s3Client.send(
        new PutBucketWebsiteCommand({
          Bucket: 'bucket-a',
          WebsiteConfiguration: {
            IndexDocument: {
              Suffix: 'index.html',
            },
          },
        }),
      );
      await s3Client.send(new GetBucketWebsiteCommand({ Bucket: 'bucket-a' }));
    });
  });
});
