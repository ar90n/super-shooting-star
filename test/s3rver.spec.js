'use strict';

import { createRequire } from 'node:module';
import { expect } from 'chai';
import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  CopyObjectCommand,
  GetBucketCorsCommand,
  GetBucketWebsiteCommand,
  ListBucketsCommand,
} from '@aws-sdk/client-s3';
import { once } from 'events';
import express from 'express';
import FormData from 'form-data';
import fs from 'fs';
import crypto from 'crypto';

import {
  createServerAndClient2,
  generateTestObjects,
  getEndpointHref,
} from './helpers';
import S3rver from '../lib/s3rver';

const require = createRequire(import.meta.url);
const request = require('request-promise-native').defaults({
  resolveWithFullResponse: true,
});

describe('S3rver', () => {
  describe('#run', () => {
    test('supports running on port 0', async function () {
      const server = new S3rver({
        port: 0,
      });
      const { port } = await server.run();
      await server.close();
      expect(port).to.be.above(0);
    });

    test('creates preconfigured buckets on startup', async function () {
      const buckets = [{ name: 'bucket1' }, { name: 'bucket2' }];
      const server = new S3rver({
        configureBuckets: buckets,
      });
      const { port } = await server.run();
      const s3Client = new S3Client({
        credentials: {
          accessKeyId: 'S3RVER',
          secretAccessKey: 'S3RVER',
        },
        endpoint: `http://localhost:${port}`,
        forcePathStyle: true,
        region: 'localhost',
      });
      try {
        const res = await s3Client.send(new ListBucketsCommand({}));
        expect(res.Buckets).to.have.lengthOf(2);
      } finally {
        s3Client.destroy();
        await server.close();
      }
    });

    test('creates a preconfigured bucket with configs on startup', async function () {
      const bucket = {
        name: 'bucket1',
        configs: [
          fs.readFileSync('./example/cors.xml'),
          fs.readFileSync('./example/website.xml'),
        ],
      };
      const server = new S3rver({
        configureBuckets: [bucket],
        allowMismatchedSignatures: true, // TODO: Remove this line by fixing signature mismatch
      });
      const { port } = await server.run();

      const s3Client = new S3Client({
        credentials: {
          accessKeyId: 'S3RVER',
          secretAccessKey: 'S3RVER',
        },
        endpoint: `http://localhost:${port}`,
        forcePathStyle: true,
        region: 'localhost',
      });

      try {
        await s3Client.send(new GetBucketCorsCommand({ Bucket: bucket.name }));
        await s3Client.send(
          new GetBucketWebsiteCommand({ Bucket: bucket.name }),
        );
      } finally {
        s3Client.destroy();
        await server.close();
      }
    });
  });

  describe('#close', () => {
    test('cleans up after close if the resetOnClose setting is true', async function () {
      const bucket = { name: 'foobars' };

      const server = new S3rver({
        resetOnClose: true,
        configureBuckets: [bucket],
      });
      const { port } = await server.run();

      const s3Client = new S3Client({
        credentials: {
          accessKeyId: 'S3RVER',
          secretAccessKey: 'S3RVER',
        },
        endpoint: `http://localhost:${port}`,
        forcePathStyle: true,
        region: 'localhost',
      });

      try {
        await generateTestObjects(s3Client, bucket.name, 10);
      } finally {
        s3Client.destroy();
        await server.close();
      }
      await expect(server.store.listBuckets()).to.eventually.have.lengthOf(0);
    });

    test('does not clean up after close if the resetOnClose setting is false', async function () {
      const bucket = { name: 'foobars' };

      const server = new S3rver({
        resetOnClose: false,
        configureBuckets: [bucket],
      });
      const { port } = await server.run();

      const s3Client = new S3Client({
        credentials: {
          accessKeyId: 'S3RVER',
          secretAccessKey: 'S3RVER',
        },
        endpoint: `http://localhost:${port}`,
        forcePathStyle: true,
        region: 'localhost',
      });

      try {
        await generateTestObjects(s3Client, bucket.name, 10);
      } finally {
        s3Client.destroy();
        await server.close();
      }
      await expect(server.store.listBuckets()).to.eventually.have.lengthOf(1);
    });

    test('does not clean up after close if the resetOnClose setting is not set', async function () {
      const bucket = { name: 'foobars' };

      const server = new S3rver({
        configureBuckets: [bucket],
      });
      const { port } = await server.run();

      const s3Client = new S3Client({
        credentials: {
          accessKeyId: 'S3RVER',
          secretAccessKey: 'S3RVER',
        },
        endpoint: `http://localhost:${port}`,
        forcePathStyle: true,
        region: 'localhost',
      });

      try {
        await generateTestObjects(s3Client, bucket.name, 10);
      } finally {
        s3Client.destroy();
        await server.close();
      }
      await expect(server.store.listBuckets()).to.eventually.have.lengthOf(1);
    });
  });

  describe("event 'event'", () => {
    let s3rver;
    let s3Client;

    beforeEach(async () => {
      ({ s3rver, s3Client } = await createServerAndClient2({
        configureBuckets: [{ name: 'bucket-a' }, { name: 'bucket-b' }],
      }));
    });

    afterEach(async () => {
      s3Client.destroy();
    });

    test('triggers an event with a valid message structure', async function () {
      const eventPromise = once(s3rver, 'event');
      const body = 'Hello!';
      await s3Client.send(
        new PutObjectCommand({
          Bucket: 'bucket-a',
          Key: 'testPutKey',
          Body: body,
        }),
      );
      const [event] = await eventPromise;
      const iso8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
      expect(event.Records[0].eventTime).to.match(iso8601);
      expect(new Date(event.Records[0].eventTime)).to.not.satisfy(isNaN);
    });

    test('triggers a Post event', async function () {
      const eventPromise = once(s3rver, 'event');
      const body = 'Hello!';

      const form = new FormData();
      form.append('key', 'testPostKey');
      form.append('file', body);
      await request.post('bucket-a', {
        baseUrl: await getEndpointHref(s3Client),
        body: form,
        headers: form.getHeaders(),
      });

      const [event] = await eventPromise;
      expect(event.Records[0].eventName).to.equal('ObjectCreated:Post');
      expect(event.Records[0].s3.bucket.name).to.equal('bucket-a');
      expect(event.Records[0].s3.object).to.contain({
        key: 'testPostKey',
        size: body.length,
        eTag: crypto.createHash('md5').update(body).digest('hex'),
      });
    });

    test('triggers a Put event', async function () {
      const eventPromise = once(s3rver, 'event');
      const body = 'Hello!';
      await s3Client.send(
        new PutObjectCommand({
          Bucket: 'bucket-a',
          Key: 'testPutKey',
          Body: body,
        }),
      );
      const [event] = await eventPromise;
      expect(event.Records[0].eventName).to.equal('ObjectCreated:Put');
      expect(event.Records[0].s3.bucket.name).to.equal('bucket-a');
      expect(event.Records[0].s3.object).to.contain({
        key: 'testPutKey',
        size: body.length,
        eTag: crypto.createHash('md5').update(body).digest('hex'),
      });
    });

    test('triggers a Copy event', async function () {
      const body = 'Hello!';
      await s3Client.send(
        new PutObjectCommand({
          Bucket: 'bucket-a',
          Key: 'testPut',
          Body: body,
        }),
      );
      const eventPromise = once(s3rver, 'event');
      await s3Client.send(
        new CopyObjectCommand({
          Bucket: 'bucket-b',
          Key: 'testCopy',
          CopySource: '/bucket-a/testPut',
        }),
      );
      const [event] = await eventPromise;
      expect(event.Records[0].eventName).to.equal('ObjectCreated:Copy');
      expect(event.Records[0].s3.bucket.name).to.equal('bucket-b');
      expect(event.Records[0].s3.object).to.contain({
        key: 'testCopy',
        size: body.length,
      });
    });

    test('triggers a Delete event', async function () {
      const body = 'Hello!';
      await s3Client.send(
        new PutObjectCommand({
          Bucket: 'bucket-a',
          Key: 'testDelete',
          Body: body,
        }),
      );
      const eventPromise = once(s3rver, 'event');
      await s3Client.send(
        new DeleteObjectCommand({ Bucket: 'bucket-a', Key: 'testDelete' }),
      );
      const [event] = await eventPromise;
      expect(event.Records[0].eventName).to.equal('ObjectRemoved:Delete');
      expect(event.Records[0].s3.bucket.name).to.equal('bucket-a');
      expect(event.Records[0].s3.object).to.contain({
        key: 'testDelete',
      });
    });
  });

  test.skip('can be mounted on a subpath in an Express app', async function () {
    const s3rver = new S3rver({
      configureBuckets: [{ name: 'bucket-a' }, { name: 'bucket-b' }],
    });
    await s3rver.configureBuckets();

    const app = express();
    app.use('/basepath', s3rver.getMiddleware());
    const httpServer = app.listen(0);
    await once(httpServer, 'listening');

    try {
      const { port } = httpServer.address();
      const s3Client = new S3Client({
        credentials: {
          accessKeyId: 'S3RVER',
          secretAccessKey: 'S3RVER',
        },
        endpoint: `http://localhost:${port}`,
        forcePathStyle: true,
        region: 'localhost',
      });
      const res = await s3Client.listBuckets().promise();
      expect(res.Buckets).toHaveLength(2);
      await s3Client.send(
        new PutObjectCommand({
          Bucket: 'bucket-a',
          Key: 'text',
          Body: 'Hello!',
        }),
      );
    } finally {
      httpServer.close();
      await once(httpServer, 'close');
    }
  });
});
