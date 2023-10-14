'use strict';

import { describe, test, beforeEach, afterEach } from '@jest/globals';
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
import fs from 'fs';
import crypto from 'crypto';

import { generateTestObjects, getEndpointHref } from './helpers';
import { createServer } from '../lib/s3rver';
import FilesystemStore from '../lib/stores/filesystem';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

describe('S3rver', () => {
  describe('#run', () => {
    test('supports running on port 0', async function () {
      const run = createServer({
        port: 0,
      });
      const { address, close } = await run();
      await close();

      expect(address.port).to.be.above(0);
    });

    test('creates preconfigured buckets on startup', async function () {
      const buckets = [{ name: 'bucket1' }, { name: 'bucket2' }];

      const run = createServer({
        configureBuckets: buckets,
      });
      const { address, close } = await run();

      const s3Client = new S3Client({
        credentials: {
          accessKeyId: 'S3RVER',
          secretAccessKey: 'S3RVER',
        },
        endpoint: `http://localhost:${address.port}`,
        forcePathStyle: true,
        region: 'localhost',
      });
      try {
        const res = await s3Client.send(new ListBucketsCommand({}));
        expect(res.Buckets).to.have.lengthOf(2);
      } finally {
        s3Client.destroy();
        await close();
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
      const run = createServer({
        configureBuckets: [bucket],
        allowMismatchedSignatures: true, // TODO: Remove this line by fixing signature mismatch
      });
      const { address, close } = await run();

      const s3Client = new S3Client({
        credentials: {
          accessKeyId: 'S3RVER',
          secretAccessKey: 'S3RVER',
        },
        endpoint: `http://localhost:${address.port}`,
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
        await close();
      }
    });
  });

  describe('#close', () => {
    test('cleans up after close if the resetOnClose setting is true', async function () {
      const bucket = { name: 'foobars' };
      const store = new FilesystemStore(path.join(os.tmpdir(), 'sss'));

      const run = createServer({
        resetOnClose: true,
        configureBuckets: [bucket],
        store,
      });
      const { address, close } = await run();

      const s3Client = new S3Client({
        credentials: {
          accessKeyId: 'S3RVER',
          secretAccessKey: 'S3RVER',
        },
        endpoint: `http://localhost:${address.port}`,
        forcePathStyle: true,
        region: 'localhost',
      });

      try {
        await generateTestObjects(s3Client, bucket.name, 10);
      } finally {
        s3Client.destroy();
        await close();
      }
      await expect(store.listBuckets()).to.eventually.have.lengthOf(0);
    });

    test('does not clean up after close if the resetOnClose setting is false', async function () {
      const bucket = { name: 'foobars' };
      const rs = Math.random().toString(32).substring(2);
      const store = new FilesystemStore(path.join(os.tmpdir(), 'sss', rs));

      const run = createServer({
        resetOnClose: false,
        configureBuckets: [bucket],
        store,
      });
      const { address, close } = await run();

      const s3Client = new S3Client({
        credentials: {
          accessKeyId: 'S3RVER',
          secretAccessKey: 'S3RVER',
        },
        endpoint: `http://localhost:${address.port}`,
        forcePathStyle: true,
        region: 'localhost',
      });

      try {
        await generateTestObjects(s3Client, bucket.name, 10);
      } finally {
        s3Client.destroy();
        await close();
      }
      await expect(store.listBuckets()).to.eventually.have.lengthOf(1);
    });

    test('does not clean up after close if the resetOnClose setting is not set', async function () {
      const bucket = { name: 'foobars' };
      const rs = Math.random().toString(32).substring(2);
      const store = new FilesystemStore(path.join(os.tmpdir(), 'sss', rs));

      const run = createServer({
        configureBuckets: [bucket],
        store,
      });
      const { address, close } = await run();

      const s3Client = new S3Client({
        credentials: {
          accessKeyId: 'S3RVER',
          secretAccessKey: 'S3RVER',
        },
        endpoint: `http://localhost:${address.port}`,
        forcePathStyle: true,
        region: 'localhost',
      });

      try {
        await generateTestObjects(s3Client, bucket.name, 10);
      } finally {
        s3Client.destroy();
        await close();
      }
      await expect(store.listBuckets()).to.eventually.have.lengthOf(1);
    });
  });

  describe("event 'event'", () => {
    let emitter;
    let close;
    let s3rver;
    let s3Client;

    beforeEach(async () => {
      emitter = new EventEmitter();
      const run = createServer({
        configureBuckets: [{ name: 'bucket-a' }, { name: 'bucket-b' }],
        emitter,
      });
      let address;
      ({ address, close } = await run());

      s3Client = new S3Client({
        credentials: {
          accessKeyId: 'S3RVER',
          secretAccessKey: 'S3RVER',
        },
        endpoint: `http://localhost:${address.port}`,
        forcePathStyle: true,
        region: 'localhost',
      });
    });

    afterEach(async () => {
      s3Client.destroy();
    });

    test('triggers an event with a valid message structure', async function () {
      const eventPromise = once(emitter, 'event');
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
      s3Client.destroy();
      await close();
    });

    test('triggers a Post event', async function () {
      const eventPromise = once(emitter, 'event');
      const body = 'Hello!';

      const form = new FormData();
      form.append('key', 'testPostKey');
      form.append('file', body);
      const endpointHref = await getEndpointHref(s3Client);
      await fetch(`${endpointHref}bucket-a`, {
        method: 'POST',
        body: form,
      });

      const [event] = await eventPromise;
      expect(event.Records[0].eventName).to.equal('ObjectCreated:Post');
      expect(event.Records[0].s3.bucket.name).to.equal('bucket-a');
      expect(event.Records[0].s3.object).to.contain({
        key: 'testPostKey',
        size: body.length,
        eTag: crypto.createHash('md5').update(body).digest('hex'),
      });
      s3Client.destroy();
      await close();
    });

    test('triggers a Put event', async function () {
      const eventPromise = once(emitter, 'event');
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
      s3Client.destroy();
      await close();
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
      const eventPromise = once(emitter, 'event');
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
      s3Client.destroy();
      await close();
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
      const eventPromise = once(emitter, 'event');
      await s3Client.send(
        new DeleteObjectCommand({ Bucket: 'bucket-a', Key: 'testDelete' }),
      );
      const [event] = await eventPromise;
      expect(event.Records[0].eventName).to.equal('ObjectRemoved:Delete');
      expect(event.Records[0].s3.bucket.name).to.equal('bucket-a');
      expect(event.Records[0].s3.object).to.contain({
        key: 'testDelete',
      });
      s3Client.destroy();
      await close();
    });
  });
});
