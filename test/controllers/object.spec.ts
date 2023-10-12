'use strict';

import { describe, test, beforeEach, afterEach } from '@jest/globals';
import { expect } from 'chai';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Upload } from '@aws-sdk/lib-storage';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  CreateMultipartUploadCommand,
  PutObjectTaggingCommand,
  CopyObjectCommand,
  UploadPartCopyCommand,
  GetObjectTaggingCommand,
  CreateBucketCommand,
  HeadObjectCommand,
  GetObjectAclCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
} from '@aws-sdk/client-s3';
import {
  AbortMultipartUploadCommandOutput,
  CompleteMultipartUploadCommandOutput,
} from '@aws-sdk/client-s3';
import { EventEmitter } from 'events';
import { once } from 'events';
import express from 'express';
import fs from 'fs';
import http from 'http';
import { find, times } from 'lodash-es';
import moment from 'moment';
import pMap from 'p-map';
import { URL, URLSearchParams } from 'url';

import {
  createServerAndClient2,
  getEndpointHref,
  generateTestObjects,
  md5,
  parseXml,
  StreamingRequestSigner,
  resolveFixturePath,
} from '../helpers';

function streamToString(stream): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

describe('Operations on Objects', () => {
  let s3rver;
  let s3Client;
  const buckets = {
    // plain, unconfigured buckets
    plainA: {
      name: 'bucket-a',
    },
    plainB: {
      name: 'bucket-b',
    },
  };

  beforeEach(async () => {
    ({ s3rver, s3Client } = await createServerAndClient2({
      configureBuckets: Object.values(buckets),
      allowMismatchedSignatures: true, // TODO: Remove this line by fixing signature mismatch
    }));
  });

  afterEach(async function () {
    s3Client.destroy();
  });

  describe('Delete Multiple Objects', () => {
    test('deletes an image from a bucket', async function () {
      await s3Client.send(
        new PutObjectCommand({
          Bucket: 'bucket-a',
          Key: 'large',
          Body: Buffer.alloc(10),
        }),
      );
      await s3Client.send(
        new DeleteObjectCommand({ Bucket: 'bucket-a', Key: 'large' }),
      );
    });

    test('deletes 500 objects with deleteObjects', async function () {
      await generateTestObjects(s3Client, 'bucket-a', 500);
      const deleteObj = { Objects: times(500, (i) => ({ Key: 'key' + i })) };
      const data = await s3Client.send(
        new DeleteObjectsCommand({ Bucket: 'bucket-a', Delete: deleteObj }),
      );
      expect(data.Deleted).to.exist;
      expect(data.Deleted).to.have.lengthOf(500);
      expect(find(data.Deleted, { Key: 'key67' })).to.exist;
    }, 30000);

    test('reports invalid XML when using deleteObjects with zero objects', async function () {
      let error;
      try {
        await s3Client.send(
          new DeleteObjectsCommand({
            Bucket: 'bucket-a',
            Delete: { Objects: [] },
          }),
        );
      } catch (err) {
        error = err;
      }
      expect(error).to.exist;
      expect(error.Code).to.equal('MalformedXML');
    });

    test('deletes nonexistent objects', async function () {
      const deleteObj = { Objects: [{ Key: 'doesnotexist' }] };
      const data = await s3Client.send(
        new DeleteObjectsCommand({ Bucket: 'bucket-a', Delete: deleteObj }),
      );
      expect(data.Deleted).to.exist;
      expect(data.Deleted).to.have.lengthOf(1);
      expect(find(data.Deleted, { Key: 'doesnotexist' })).to.exist;
    });
  });

  describe('DELETE Object', () => {
    test('deletes 500 objects', async function () {
      await generateTestObjects(s3Client, 'bucket-a', 500);
      await pMap(
        times(500),
        (i) =>
          s3Client.send(
            new DeleteObjectCommand({ Bucket: 'bucket-a', Key: 'key' + i }),
          ),
        { concurrency: 100 },
      );
    }, 30000);

    test('deletes a nonexistent object from a bucket', async function () {
      await s3Client.send(
        new DeleteObjectCommand({ Bucket: 'bucket-a', Key: 'doesnotexist' }),
      );
    });
  });

  describe('GET Object', () => {
    test('stores a large buffer in a bucket', async function () {
      const data = await s3Client.send(
        new PutObjectCommand({
          Bucket: 'bucket-a',
          Key: 'large',
          Body: Buffer.alloc(20 * Math.pow(1024, 2)),
        }),
      );
      expect(data.ETag).to.match(/"[a-fA-F0-9]{32}"/);
    });

    test('gets an image from a bucket', async function () {
      const file = resolveFixturePath('image0.jpg');
      const data = await fs.promises.readFile(file);
      await s3Client.send(
        new PutObjectCommand({
          Bucket: 'bucket-a',
          Key: 'image',
          Body: data,
          ContentType: 'image/jpeg',
        }),
      );
      const object = await s3Client.send(
        new GetObjectCommand({ Bucket: 'bucket-a', Key: 'image' }),
      );
      expect(object.ETag).to.equal(JSON.stringify(md5(data)));
      expect(object.ContentLength).to.equal(data.length);
      expect(object.ContentType).to.equal('image/jpeg');
    });

    test('can HEAD an empty object in a bucket', async function () {
      await s3Client.send(
        new PutObjectCommand({
          Bucket: 'bucket-a',
          Key: 'somekey',
          Body: Buffer.alloc(0),
        }),
      );
      const object = await s3Client.send(
        new HeadObjectCommand({ Bucket: 'bucket-a', Key: 'somekey' }),
      );
      expect(object.ETag).to.match(/"[a-fA-F0-9]{32}"/);
    });

    test('gets partial image from a bucket with a range request', async function () {
      const file = resolveFixturePath('image0.jpg');
      await s3Client.send(
        new PutObjectCommand({
          Bucket: 'bucket-a',
          Key: 'image',
          Body: await fs.promises.readFile(file),
          ContentType: 'image/jpeg',
        }),
      );
      const url = await getSignedUrl(
        s3Client,
        new GetObjectCommand({
          Bucket: 'bucket-a',
          Key: 'image',
        }),
      );
      const res = await fetch(url, {
        headers: { range: 'bytes=0-99' },
      });
      expect(res.status).to.equal(206);
      expect(res.headers.get('content-range')).to.exist;
      expect(res.headers.get('accept-ranges')).to.exist;
      expect(res.headers.get('content-length')).to.equal('100');
    });

    test('gets a response without range headers when no range is specified in the request', async function () {
      const file = resolveFixturePath('image0.jpg');
      await s3Client.send(
        new PutObjectCommand({
          Bucket: 'bucket-a',
          Key: 'image',
          Body: await fs.promises.readFile(file),
          ContentType: 'image/jpeg',
        }),
      );
      const url = await getSignedUrl(
        s3Client,
        new GetObjectCommand({
          Bucket: 'bucket-a',
          Key: 'image',
        }),
      );
      const res = await fetch(url, {
        headers: {},
      });
      expect(res.status).to.equal(200);
      expect(res.headers.get('content-range')).to.not.exist;
      expect(res.headers.get('accept-ranges')).to.exist;
      expect(res.headers.get('content-length')).to.equal('52359');
    });

    test('gets a response with range headers when the requested range starts on byte 0 and no end', async function () {
      const file = resolveFixturePath('image0.jpg');
      await s3Client.send(
        new PutObjectCommand({
          Bucket: 'bucket-a',
          Key: 'image',
          Body: await fs.promises.readFile(file),
          ContentType: 'image/jpeg',
        }),
      );
      const url = await getSignedUrl(
        s3Client,
        new GetObjectCommand({
          Bucket: 'bucket-a',
          Key: 'image',
        }),
      );
      const res = await fetch(url, {
        headers: { range: 'bytes=0-' },
      });
      expect(res.status).to.equal(206);
      expect(res.headers.get('content-range')).to.exist;
      expect(res.headers.get('accept-ranges')).to.exist;
      expect(res.headers.get('content-length')).to.equal('52359');
    });

    test('returns 416 error for out of bounds range requests', async function () {
      const file = resolveFixturePath('image0.jpg');
      const { size: filesize } = fs.statSync(file);
      await s3Client.send(
        new PutObjectCommand({
          Bucket: 'bucket-a',
          Key: 'image',
          Body: await fs.promises.readFile(file),
          ContentType: 'image/jpeg',
        }),
      );
      const url = await getSignedUrl(
        s3Client,
        new GetObjectCommand({
          Bucket: 'bucket-a',
          Key: 'image',
        }),
      );

      const res = await fetch(url, {
        headers: { range: `bytes=${filesize + 100}-${filesize + 200}` },
      });
      expect(res).to.exist;
      expect(res.status).to.equal(416);
    });

    test('returns actual length of data for partial out of bounds range requests', async function () {
      const file = resolveFixturePath('image0.jpg');
      const { size: filesize } = fs.statSync(file);
      await s3Client.send(
        new PutObjectCommand({
          Bucket: 'bucket-a',
          Key: 'image',
          Body: await fs.promises.readFile(file),
          ContentType: 'image/jpeg',
        }),
      );
      const url = await getSignedUrl(
        s3Client,
        new GetObjectCommand({
          Bucket: 'bucket-a',
          Key: 'image',
        }),
      );
      const res = await fetch(url, {
        headers: { range: 'bytes=0-100000' },
      });
      expect(res.status).to.equal(206);
      expect(res.headers.get('content-range')).to.exist;
      expect(res.headers.get('accept-ranges')).to.exist;
      expect(res.headers.get('content-length')).to.deep.equal(
        filesize.toString(),
      );
    });

    test('finds a text file in a multi directory path', async function () {
      await s3Client.send(
        new PutObjectCommand({
          Bucket: 'bucket-a',
          Key: 'multi/directory/path/text',
          Body: 'Hello!',
        }),
      );
      const object = await s3Client.send(
        new GetObjectCommand({
          Bucket: 'bucket-a',
          Key: 'multi/directory/path/text',
        }),
      );
      expect(object.ETag).to.equal(JSON.stringify(md5('Hello!')));
      expect(object.ContentLength).to.equal(6);
      expect(object.ContentType).to.equal('application/octet-stream');
    });

    test('returns image metadata from a bucket in HEAD request', async function () {
      const file = resolveFixturePath('image0.jpg');
      const fileContent = await fs.promises.readFile(file);
      await s3Client.send(
        new PutObjectCommand({
          Bucket: 'bucket-a',
          Key: 'image',
          Body: fileContent,
          ContentType: 'image/jpeg',
          ContentLength: fileContent.length,
        }),
      );
      const object = await s3Client.send(
        new HeadObjectCommand({ Bucket: 'bucket-a', Key: 'image' }),
      );
      expect(object.ETag).to.equal(JSON.stringify(md5(fileContent)));
      expect(object.ContentLength).to.equal(fileContent.length);
      expect(object.ContentType).to.equal('image/jpeg');
    });

    test('fails to find an image from a bucket', async function () {
      let error;
      try {
        await s3Client.send(
          new GetObjectCommand({ Bucket: 'bucket-a', Key: 'image' }),
        );
      } catch (err) {
        error = err;
      }
      expect(error).to.exist;
      expect(error.Code).to.equal('NoSuchKey');
      expect(error.$metadata.httpStatusCode).to.equal(404);
    });
  });

  describe('GET Object ACL', () => {
    test('returns a dummy acl for an object', async function () {
      const object = await s3Client.send(
        new GetObjectAclCommand({ Bucket: 'bucket-a', Key: 'image0' }),
      );
      expect(object.Owner.DisplayName).to.equal('S3rver');
    });
  });

  describe('GET Object tagging', () => {
    test("errors when getting tags for an object that doesn't exist", async function () {
      await expect(
        s3Client.send(
          new GetObjectTaggingCommand({
            Bucket: 'bucket-a',
            Key: 'text',
          }),
        ),
      ).to.eventually.be.rejectedWith('The specified key does not exist.');
    });

    test('returns an empty tag set for an untagged object', async function () {
      await s3Client.send(
        new PutObjectCommand({
          Bucket: 'bucket-a',
          Key: 'text',
          Body: 'Hello!',
        }),
      );

      const tagging = await s3Client.send(
        new GetObjectTaggingCommand({
          Bucket: 'bucket-a',
          Key: 'text',
        }),
      );

      expect(tagging).to.deep.contains({ TagSet: [] });
    });
  });

  describe('POST Object', () => {
    test('stores a text object for a multipart/form-data request', async function () {
      const form = new FormData();
      form.append('key', 'text');
      form.append('file', new Blob(['Hello!']), 'post_file.txt');
      const href = await getEndpointHref(s3Client);
      const res = await fetch(`${href}bucket-a`, {
        method: 'POST',
        body: form,
      });
      expect(res.status).to.equal(204);
      const object = await s3Client.send(
        new GetObjectCommand({ Bucket: 'bucket-a', Key: 'text' }),
      );
      expect(object.ContentType).to.equal('binary/octet-stream');
      const body = await streamToString(object.Body);
      expect(body).to.deep.equal('Hello!');
    });

    test('rejects requests with an invalid content-type', async function () {
      const href = await getEndpointHref(s3Client);
      let res;
      try {
        res = await fetch(`${href}bucket-a`, {
          method: 'POST',
          body: new URLSearchParams({
            key: 'text',
            file: 'Hello!',
          }).toString(),
        });
      } catch (err) {
        res = err.response;
      }
      expect(res.status).to.equal(412);
      expect(res.text()).to.eventually.contain(
        '<Condition>Bucket POST must be of the enclosure-type multipart/form-data</Condition>',
      );
    });

    test('stores a text object without filename part metadata', async function () {
      const form = new FormData();
      form.append('key', 'text');
      form.append('file', 'Hello!');
      const href = await getEndpointHref(s3Client);
      const res = await fetch(`${href}bucket-a`, {
        method: 'POST',
        body: form,
      });
      expect(res.status).to.equal(204);
      const object = await s3Client.send(
        new GetObjectCommand({ Bucket: 'bucket-a', Key: 'text' }),
      );
      expect(object.ContentType).to.equal('binary/octet-stream');
      const body = await streamToString(object.Body);
      expect(body).to.equal('Hello!');
    });

    test('stores a text object with a content-type', async function () {
      const form = new FormData();
      form.append('key', 'text');
      form.append('Content-Type', 'text/plain');
      form.append('file', new Blob(['Hello!']), 'post_file.txt');
      const href = await getEndpointHref(s3Client);
      const res = await fetch(`${href}bucket-a`, {
        method: 'POST',
        body: form,
      });
      expect(res.status).to.equal(204);
      const object = await s3Client.send(
        new GetObjectCommand({ Bucket: 'bucket-a', Key: 'text' }),
      );
      expect(object.ContentType).to.equal('text/plain');
      const body = await streamToString(object.Body);
      expect(body).to.deep.equal('Hello!');
    });

    test('returns the location of the stored object in a header', async function () {
      const file = fs.readFileSync(resolveFixturePath('image0.jpg'));
      const form = new FormData();
      form.append('key', 'image');
      form.append(
        'file',
        new Blob([file], { type: 'image/jpeg' }),
        'image0.jpg',
      );
      const href = await getEndpointHref(s3Client);
      const res = await fetch(`${href}bucket-a`, {
        method: 'POST',
        body: form,
      });
      expect(res.status).to.equal(204);
      expect(res.headers.get('location')).to.deep.equal(
        new URL('/bucket-a/image', href).href,
      );
      const objectRes = await fetch(res.headers.get('location'), {});
      const arrayBuffer = await objectRes.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      expect(buffer).to.deep.equal(file);
    });

    test('returns the location of the stored object in a header with vhost URL', async function () {
      const file = fs.readFileSync(resolveFixturePath('image0.jpg'));
      const form = new FormData();
      form.append('key', 'image');
      form.append(
        'file',
        new Blob([file], { type: 'image/jpeg' }),
        'image0.jpg',
      );
      const href = await getEndpointHref(s3Client);
      const res = await fetch(`${href}`, {
        method: 'POST',
        body: form,
        headers: {
          host: 'bucket-a',
        },
      });
      expect(res.status).to.equal(204);
      expect(res.headers.get('location')).to.deep.equal(
        new URL('/image', `http://bucket-a`).href,
      );
    });

    test('returns the location of the stored object in a header with subdomain URL', async function () {
      const file = fs.readFileSync(resolveFixturePath('image0.jpg'));
      const form = new FormData();
      form.append('key', 'image');
      form.append(
        'file',
        new Blob([file], { type: 'image/jpeg' }),
        'image0.jpg',
      );
      const href = await getEndpointHref(s3Client);
      const res = await fetch(`${href}`, {
        method: 'POST',
        body: form,
        headers: {
          host: 'bucket-a.s3.amazonaws.com',
        },
      });
      expect(res.status).to.equal(204);
      expect(res.headers.get('location')).to.deep.equal(
        new URL('/image', 'http://bucket-a.s3.amazonaws.com').href,
      );
    });

    test('returns a 200 status code with empty response body', async function () {
      const form = new FormData();
      form.append('key', 'text');
      form.append('success_action_status', '200');
      form.append('file', 'Hello!');
      const href = await getEndpointHref(s3Client);
      const res = await fetch(`${href}bucket-a`, {
        method: 'POST',
        body: form,
      });
      expect(res.status).to.equal(200);
      expect(res.headers).not.to.have.property('content-type');
      expect(res.text()).to.eventually.equal('');
    });

    test('returns a 201 status code with XML response body', async function () {
      const form = new FormData();
      form.append('key', 'text');
      form.append('success_action_status', '201');
      form.append('file', 'Hello!');
      const href = await getEndpointHref(s3Client);
      const res = await fetch(`${href}bucket-a`, {
        method: 'POST',
        body: form,
      });
      expect(res.status).to.equal(201);
      expect(res.headers.get('content-type')).to.equal('application/xml');
      const text = await res.text();
      expect(text).to.contain('<PostResponse>');
      expect(text).to.contain('<Bucket>bucket-a</Bucket><Key>text</Key>');
    });

    test('returns a 204 status code when an invalid status is specified', async function () {
      const form = new FormData();
      form.append('key', 'text');
      form.append('success_action_status', '301');
      form.append('file', 'Hello!');
      const href = await getEndpointHref(s3Client);
      const res = await fetch(`${href}bucket-a`, {
        method: 'POST',
        body: form,
      });
      expect(res.status).to.equal(204);
    });

    test('redirects a custom location with search parameters', async function () {
      const successRedirect = new URL('http://foo.local/path?bar=baz');
      const form = new FormData();
      form.append('key', 'text');
      form.append('success_action_redirect', successRedirect.href);
      form.append('file', 'Hello!');
      const href = await getEndpointHref(s3Client);
      const res = await fetch(`${href}bucket-a`, {
        method: 'POST',
        body: form,
        redirect: 'manual',
      });
      expect(res.status).to.equal(303);
      const location = new URL(res.headers.get('location'));
      expect(location.host).to.equal(successRedirect.host);
      expect(location.pathname).to.equal(successRedirect.pathname);
      expect(new Map(location.searchParams)).to.contain.key('bar');
      expect(location.searchParams.get('bucket')).to.equal('bucket-a');
      expect(location.searchParams.get('key')).to.equal('text');
      expect(location.searchParams.get('etag')).to.equal(
        JSON.stringify(md5('Hello!')),
      );
    });

    test('redirects a custom location using deprecated redirect fieldname', async function () {
      const successRedirect = new URL('http://foo.local/path?bar=baz');
      const form = new FormData();
      form.append('key', 'text');
      form.append('redirect', successRedirect.href);
      form.append('file', 'Hello!');
      const href = await getEndpointHref(s3Client);
      const res = await fetch(`${href}bucket-a`, {
        method: 'POST',
        body: form,
        redirect: 'manual',
      });
      expect(res.status).to.equal(303);
      const location = new URL(res.headers.get('location'));
      expect(location.host).to.equal(successRedirect.host);
      expect(location.pathname).to.equal(successRedirect.pathname);
    });

    test('ignores deprecated redirect field when success_action_redirect is specified', async function () {
      const successRedirect = new URL('http://foo.local/path?bar=baz');
      const form = new FormData();
      form.append('key', 'text');
      form.append('success_action_redirect', successRedirect.href);
      form.append('redirect', 'http://ignore-me.local');
      form.append('file', 'Hello!');
      const href = await getEndpointHref(s3Client);
      const res = await fetch(`${href}bucket-a`, {
        method: 'POST',
        body: form,
        redirect: 'manual',
      });
      expect(res.status).to.equal(303);
      const location = new URL(res.headers.get('location'));
      expect(location.host).to.equal(successRedirect.host);
      expect(location.pathname).to.equal(successRedirect.pathname);
    });

    test('ignores status field when redirect is specified', async function () {
      const successRedirect = new URL('http://foo.local/path?bar=baz');
      const form = new FormData();
      form.append('key', 'text');
      form.append('success_action_redirect', successRedirect.href);
      form.append('success_action_status', '200');
      form.append('file', 'Hello!');
      const href = await getEndpointHref(s3Client);
      const res = await fetch(`${href}bucket-a`, {
        method: 'POST',
        body: form,
        redirect: 'manual',
      });
      expect(res.status).to.equal(303);
    });

    test('ignores fields specified after the file field', async function () {
      const form = new FormData();
      form.append('key', 'text');
      form.append('file', 'Hello!');
      form.append('Content-Type', 'text/plain');
      form.append('success_action_status', '200');
      const href = await getEndpointHref(s3Client);
      const res = await fetch(`${href}bucket-a`, {
        method: 'POST',
        body: form,
      });
      const objectRes = await fetch(res.headers.get('location'));
      expect(res.status).to.equal(204);
      expect(objectRes.headers.get('content-type')).to.not.equal('text/plain');
    });

    test('rejects requests with no key field', async function () {
      const form = new FormData();
      form.append('file', 'Hello!');
      const href = await getEndpointHref(s3Client);
      let res;
      try {
        res = await fetch(`${href}bucket-a`, {
          method: 'POST',
          body: form,
        });
      } catch (err) {
        res = err.response;
      }
      expect(res.status).to.equal(400);
      expect(res.text()).to.eventually.contain(
        '<ArgumentName>key</ArgumentName><ArgumentValue></ArgumentValue>',
      );
    });

    test('rejects requests with zero-length key', async function () {
      const form = new FormData();
      form.append('key', '');
      form.append('file', 'Hello!');
      const href = await getEndpointHref(s3Client);
      let res;
      try {
        res = await fetch(`${href}bucket-a`, {
          method: 'POST',
          body: form,
        });
      } catch (err) {
        res = err.response;
      }
      expect(res.status).to.equal(400);
      expect(res.text()).to.eventually.contain(
        '<Message>User key must have a length greater than 0.</Message>',
      );
    });

    test('rejects requests with no file field', async function () {
      const form = new FormData();
      form.append('key', 'text');
      const href = await getEndpointHref(s3Client);
      const res = await fetch(`${href}bucket-a`, {
        method: 'POST',
        body: form,
      });
      expect(res.status).to.equal(400);
      expect(res.text()).to.eventually.contain(
        '<ArgumentName>file</ArgumentName><ArgumentValue>0</ArgumentValue>',
      );
    });
  });

  describe('PUT Object', () => {
    test('stores a text object in a bucket', async function () {
      const data = await s3Client.send(
        new PutObjectCommand({
          Bucket: 'bucket-a',
          Key: 'text',
          Body: 'Hello!',
        }),
      );
      expect(data.ETag).to.match(/"[a-fA-F0-9]{32}"/);
    });

    test('stores a different image and update the previous image', async function () {
      const files = [
        resolveFixturePath('image0.jpg'),
        resolveFixturePath('image1.jpg'),
      ];

      // Get object from store
      await s3Client.send(
        new PutObjectCommand({
          Bucket: 'bucket-a',
          Key: 'image',
          Body: await fs.promises.readFile(files[0]),
          ContentType: 'image/jpeg',
        }),
      );
      const object = await s3Client.send(
        new GetObjectCommand({ Bucket: 'bucket-a', Key: 'image' }),
      );

      // Store different object
      const storedObject = await s3Client.send(
        new PutObjectCommand({
          Bucket: 'bucket-a',
          Key: 'image',
          Body: await fs.promises.readFile(files[1]),
          ContentType: 'image/jpeg',
        }),
      );
      expect(storedObject.ETag).to.not.equal(object.ETag);

      // Get object again and do some comparisons
      const newObject = await s3Client.send(
        new GetObjectCommand({ Bucket: 'bucket-a', Key: 'image' }),
      );
      expect(newObject.LastModified).to.not.equal(object.LastModified);
      expect(newObject.ContentLength).to.not.equal(object.ContentLength);
    });

    test('distinguishes keys stored with and without a trailing /', async function () {
      await s3Client.send(
        new PutObjectCommand({
          Bucket: 'bucket-a',
          Key: 'text',
          Body: 'Hello!',
        }),
      );
      await s3Client.send(
        new PutObjectCommand({
          Bucket: 'bucket-a',
          Key: 'text/',
          Body: 'Goodbye!',
        }),
      );
      const obj1 = await s3Client.send(
        new GetObjectCommand({ Bucket: 'bucket-a', Key: 'text' }),
      );
      const body1 = await streamToString(obj1.Body);
      const obj2 = await s3Client.send(
        new GetObjectCommand({ Bucket: 'bucket-a', Key: 'text/' }),
      );
      const body2 = await streamToString(obj2.Body);

      expect(body1).to.equal('Hello!');
      expect(body2).to.equal('Goodbye!');
    });

    test('stores a text object with invalid win32 path characters and retrieves it', async function () {
      const reservedChars = '\\/:*?"<>|';
      await s3Client.send(
        new PutObjectCommand({
          Bucket: 'bucket-a',
          Key: `mykey-&-${reservedChars}`,
          Body: 'Hello!',
        }),
      );

      const object = await s3Client.send(
        new GetObjectCommand({
          Bucket: 'bucket-a',
          Key: `mykey-&-${reservedChars}`,
        }),
      );

      const body = await streamToString(object.Body);
      expect(body).to.equal('Hello!');
    });

    test('stores a text object with no content type and retrieves it', async function () {
      const href = await getEndpointHref(s3Client);
      const res = await fetch(`${href}bucket-a/text`, {
        method: 'PUT',
        body: 'Hello!',
        headers: {
          'Content-Type': '',
        },
      });
      expect(res.status).to.equal(200);
      const data = await s3Client.send(
        new GetObjectCommand({ Bucket: 'bucket-a', Key: 'text' }),
      );
      expect(data.ContentType).to.equal('binary/octet-stream');
    });

    test('stores a text object with some custom metadata', async function () {
      const data = await s3Client.send(
        new PutObjectCommand({
          Bucket: 'bucket-a',
          Key: 'textmetadata',
          Body: 'Hello!',
          Metadata: {
            someKey: 'value',
          },
        }),
      );
      expect(data.ETag).to.match(/"[a-fA-F0-9]{32}"/);
      const object = await s3Client.send(
        new GetObjectCommand({ Bucket: 'bucket-a', Key: 'textmetadata' }),
      );
      expect(object.Metadata.somekey).to.equal('value');
    });

    test('stores an image in a bucket', async function () {
      const file = resolveFixturePath('image0.jpg');
      const data = await s3Client.send(
        new PutObjectCommand({
          Bucket: 'bucket-a',
          Key: 'image',
          Body: await fs.promises.readFile(file),
          ContentType: 'image/jpeg',
        }),
      );
      expect(data.ETag).to.match(/"[a-fA-F0-9]{32}"/);
    });

    test('stores a file in bucket with gzip encoding', async function () {
      const file = resolveFixturePath('jquery.js.gz');

      const params = {
        Bucket: 'bucket-a',
        Key: 'jquery',
        Body: await fs.promises.readFile(file),
        ContentType: 'application/javascript',
        ContentEncoding: 'gzip',
      };

      await s3Client.send(new PutObjectCommand(params));
      const object = await s3Client.send(
        new GetObjectCommand({ Bucket: 'bucket-a', Key: 'jquery' }),
      );
      expect(object.ContentEncoding).to.equal('gzip');
      expect(object.ContentType).to.equal('application/javascript');
    });

    test('stores and retrieves an object while mounted on a subpath', async function () {
      const { port, protocol } = await s3Client.config.endpoint();

      const app = express();
      app.use('/basepath', s3rver.getMiddleware());

      const { httpServer } = s3rver;
      httpServer.removeAllListeners('request');
      httpServer.on('request', app);

      const s3ClientReq = new S3Client({
        credentials: {
          accessKeyId: 'S3RVER',
          secretAccessKey: 'S3RVER',
        },
        endpoint: `${protocol}//localhost:${port}/basepath`,
        forcePathStyle: true,
        region: 'localhost',
      });

      await s3ClientReq.send(
        new PutObjectCommand({
          Bucket: 'bucket-a',
          Key: 'text',
          Body: 'Hello!',
        }),
      );
      const object = await s3ClientReq.send(
        new GetObjectCommand({ Bucket: 'bucket-a', Key: 'text' }),
      );
      const body = await streamToString(object.Body);
      expect(body).to.equal('Hello!');
    });

    test('stores an object in a bucket after all objects are deleted', async function () {
      const bucket = 'foobars';
      await s3Client.send(new CreateBucketCommand({ Bucket: bucket }));
      await s3Client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: 'foo.txt',
          Body: 'Hello!',
        }),
      );
      await s3Client.send(
        new DeleteObjectCommand({ Bucket: bucket, Key: 'foo.txt' }),
      );
      await s3Client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: 'foo2.txt',
          Body: 'Hello2!',
        }),
      );
    });

    test('stores an object with a storage class', async function () {
      await s3Client.send(
        new PutObjectCommand({
          Bucket: 'bucket-a',
          Key: 'somekey',
          Body: 'Hello!',
          StorageClass: 'STANDARD_IA',
        }),
      );
      const object = await s3Client.send(
        new GetObjectCommand({
          Bucket: 'bucket-a',
          Key: 'somekey',
        }),
      );
      expect(object.ETag).to.equal(JSON.stringify(md5('Hello!')));
      expect(object.StorageClass).to.equal('STANDARD_IA');
    });

    test('fails to store an object with an invalid storage class', async function () {
      let error;
      try {
        await s3Client.send(
          new PutObjectCommand({
            Bucket: 'bucket-a',
            Key: 'somekey',
            Body: 'Hello!',
            StorageClass: 'BAD_STORAGE',
          }),
        );
      } catch (err) {
        error = err;
      }
      expect(error).to.exist;
      expect(error.Code).to.equal('InvalidStorageClass');
    });

    describe('Chunked Upload', () => {
      const CRLF = '\r\n';
      const createSigner = async (request, chunks) => {
        const { hostname, port, protocol, path } =
          await s3Client.config.endpoint();
        return new StreamingRequestSigner(
          {
            method: 'PUT',
            protocol: protocol,
            hostname: hostname,
            port: port,
            path: path + `${request.Bucket}/${request.Key}`,
            headers: {
              'X-Amz-Decoded-Content-Length': chunks.reduce(
                (length, chunk) => length + chunk.length,
                0,
              ),
            },
          },
          {
            accessKeyId: 'S3RVER',
            secretAccessKey: 'S3RVER',
          },
        );
      };

      test('stores an object using chunked transfer encoding', async function () {
        const chunks = [Buffer.alloc(8192), 'Hello!', ''];
        const signer = await createSigner(
          { Bucket: 'bucket-a', Key: 'text' },
          chunks,
        );
        const opts = signer.sign();
        const req = http.request(opts);
        for (const chunk of chunks) {
          const signed = signer.signChunk(chunk);
          req.write(signed);
          req.write(CRLF);
          req.write(chunk);
          req.write(CRLF);
        }
        const [res] = await once(req.end(), 'response');
        let resBodyString = '';
        for await (const chunk of res) {
          resBodyString += chunk.toString();
        }
        const resBody = parseXml(resBodyString);
        expect(Object.keys(resBody)).to.be.empty;
        expect(res.statusCode).to.equal(200);
        const object = await s3Client.send(
          new GetObjectCommand({ Bucket: 'bucket-a', Key: 'text' }),
        );
        const body = await streamToString(object.Body);
        expect(body.slice(8192).toString()).to.equal('Hello!');
      });

      test('fails to store an object when an initial chunk is smaller than 8KB', async function () {
        const chunks = [Buffer.alloc(8192), 'error', 'Hello!', ''];
        const signer = await createSigner(
          { Bucket: 'bucket-a', Key: 'text' },
          chunks,
        );
        const opts = signer.sign();
        const req = http.request(opts);
        for (const chunk of chunks) {
          const signed = signer.signChunk(chunk);
          req.write(signed);
          req.write('\r\n');
          req.write(chunk);
          req.write('\r\n');
        }
        const [res] = await once(req.end(), 'response');
        let resBodyString = '';
        for await (const chunk of res) {
          resBodyString += chunk.toString();
        }
        const resBody = parseXml(resBodyString);
        expect(res.statusCode).to.equal(403);
        expect(resBody.Error).to.include({
          Code: 'InvalidChunkSizeError',
          Message:
            'Only the last chunk is allowed to have a size less than 8192 bytes',
          Chunk: 3,
          BadChunkSize: chunks[1].length,
        });
      });

      test('fails to store an object when a chunked transfer terminates with a non-empty chunk', async function () {
        const chunks = ['Hello!'];
        const signer = await createSigner(
          { Bucket: 'bucket-a', Key: 'text' },
          chunks,
        );
        const opts = signer.sign();
        const req = http.request(opts);
        for (const chunk of chunks) {
          const signed = signer.signChunk(chunk);
          req.write(signed);
          req.write('\r\n');
          req.write(chunk);
          req.write('\r\n');
        }
        const [res] = await once(req.end(), 'response');
        let resBodyString = '';
        for await (const chunk of res) {
          resBodyString += chunk.toString();
        }
        const resBody = parseXml(resBodyString);
        expect(res.statusCode).to.equal(400);
        expect(resBody.Error).to.include({
          Code: 'IncompleteBody',
          Message: 'The request body terminated unexpectedly',
        });
      });

      test('fails to store an object when no decoded content length is provided', async function () {
        const chunks = ['Hello!', ''];
        const signer = await createSigner(
          { Bucket: 'bucket-a', Key: 'text' },
          chunks,
        );
        delete signer.request.headers['X-Amz-Decoded-Content-Length'];
        const opts = signer.sign();
        const req = http.request(opts);
        for (const chunk of chunks) {
          const signed = signer.signChunk(chunk);
          req.write(signed);
          req.write('\r\n');
          req.write(chunk);
          req.write('\r\n');
        }
        const [res] = await once(req.end(), 'response');
        let resBodyString = '';
        for await (const chunk of res) {
          resBodyString += chunk.toString();
        }
        const resBody = parseXml(resBodyString);
        expect(res.statusCode).to.equal(411);
        expect(resBody.Error).to.include({
          Code: 'MissingContentLength',
          Message: 'You must provide the Content-Length HTTP header.',
        });
      });

      test('fails to store an object when the decoded content length does not match', async function () {
        const chunks = ['Hello!', ''];
        const signer = await createSigner(
          { Bucket: 'bucket-a', Key: 'text' },
          chunks,
        );
        (signer.request.headers['X-Amz-Decoded-Content-Length'] as any) += 1;
        const opts = signer.sign();
        const req = http.request(opts);
        for (const chunk of chunks) {
          const signed = signer.signChunk(chunk);
          req.write(signed);
          req.write('\r\n');
          req.write(chunk);
          req.write('\r\n');
        }
        const [res] = await once(req.end(), 'response');
        let resBodyString = '';
        for await (const chunk of res) {
          resBodyString += chunk.toString();
        }
        const resBody = parseXml(resBodyString);
        expect(res.statusCode).to.equal(400);
        expect(resBody.Error).to.include({
          Code: 'IncompleteBody',
          Message:
            'You did not provide the number of bytes specified by the Content-Length HTTP header',
        });
      });
    });
  });

  describe('PUT Object - Copy', () => {
    test('copies an image object into another bucket', async function () {
      const srcKey = 'image';
      const destKey = 'image/jamie';

      const file = resolveFixturePath('image0.jpg');
      const data = await s3Client.send(
        new PutObjectCommand({
          Bucket: 'bucket-a',
          Key: srcKey,
          Body: await fs.promises.readFile(file),
          ContentType: 'image/jpeg',
        }),
      );
      expect(data.ETag).to.match(/"[a-fA-F0-9]{32}"/);
      const copyResult = (
        await s3Client.send(
          new CopyObjectCommand({
            Bucket: 'bucket-b',
            Key: destKey,
            CopySource: '/bucket-a/' + srcKey,
          }),
        )
      ).CopyObjectResult;

      expect(copyResult.ETag).to.equal(data.ETag);
      expect(moment(copyResult.LastModified).isValid()).to.be.true;
      const object = await s3Client.send(
        new GetObjectCommand({
          Bucket: 'bucket-b',
          Key: destKey,
        }),
      );
      expect(object.ETag).to.equal(data.ETag);
    });

    test('copies an image object into another bucket including its metadata', async function () {
      const srcKey = 'image';
      const destKey = 'image/jamie';

      const file = resolveFixturePath('image0.jpg');
      const data = await s3Client.send(
        new PutObjectCommand({
          Bucket: 'bucket-a',
          Key: srcKey,
          Body: await fs.promises.readFile(file),
          ContentType: 'image/jpeg',
          Metadata: {
            someKey: 'value',
          },
        }),
      );
      expect(data.ETag).to.match(/"[a-fA-F0-9]{32}"/);
      await s3Client.send(
        new CopyObjectCommand({
          Bucket: 'bucket-b',
          Key: destKey,
          // MetadataDirective is implied to be COPY
          CopySource: '/bucket-a/' + srcKey,
        }),
      );
      const object = await s3Client.send(
        new GetObjectCommand({ Bucket: 'bucket-b', Key: destKey }),
      );
      expect(object.Metadata).to.have.property('somekey', 'value');
      expect(object.ContentType).to.equal('image/jpeg');
      expect(object.ETag).to.equal(data.ETag);
    });

    test('copies an object using spaces/unicode chars in keys', async function () {
      const srcKey = 'awesome 驚くばかり.jpg';
      const destKey = 'new 新しい.jpg';

      const file = resolveFixturePath('image0.jpg');
      const data = await s3Client.send(
        new PutObjectCommand({
          Bucket: 'bucket-a',
          Key: srcKey,
          Body: await fs.promises.readFile(file),
          ContentType: 'image/jpeg',
        }),
      );
      expect(data.ETag).to.match(/"[a-fA-F0-9]{32}"/);
      const copyResult = (
        await s3Client.send(
          new CopyObjectCommand({
            Bucket: 'bucket-a',
            Key: destKey,
            CopySource: '/bucket-a/' + encodeURI(srcKey),
          }),
        )
      ).CopyObjectResult;
      expect(copyResult.ETag).to.equal(data.ETag);
      expect(moment(copyResult.LastModified).isValid()).to.be.true;
    });

    test('copies an image object into another bucket and update its metadata', async function () {
      const srcKey = 'image';
      const destKey = 'image/jamie';

      const file = resolveFixturePath('image0.jpg');
      await s3Client.send(
        new PutObjectCommand({
          Bucket: 'bucket-a',
          Key: srcKey,
          Body: await fs.promises.readFile(file),
          ContentType: 'image/jpeg',
        }),
      );
      await s3Client.send(
        new CopyObjectCommand({
          Bucket: 'bucket-b',
          Key: destKey,
          CopySource: '/bucket-a/' + srcKey,
          MetadataDirective: 'REPLACE',
          Metadata: {
            someKey: 'value',
          },
        }),
      );
      const object = await s3Client.send(
        new GetObjectCommand({ Bucket: 'bucket-b', Key: destKey }),
      );
      expect(object.Metadata.somekey).to.equal('value');
      expect(object.ContentType).to.equal('binary/octet-stream');
    });

    test('updates the metadata of an image object', async function () {
      const srcKey = 'image';
      const destKey = 'image/jamie';

      const file = resolveFixturePath('image0.jpg');
      const data = await s3Client.send(
        new PutObjectCommand({
          Bucket: 'bucket-a',
          Key: srcKey,
          Body: await fs.promises.readFile(file),
          ContentType: 'image/jpeg',
        }),
      );
      expect(data.ETag).to.match(/"[a-fA-F0-9]{32}"/);
      await s3Client.send(
        new CopyObjectCommand({
          Bucket: 'bucket-b',
          Key: destKey,
          CopySource: '/bucket-a/' + srcKey,
          MetadataDirective: 'REPLACE',
          Metadata: {
            someKey: 'value',
          },
        }),
      );
      const object = await s3Client.send(
        new GetObjectCommand({ Bucket: 'bucket-b', Key: destKey }),
      );
      expect(object.Metadata).to.have.property('somekey', 'value');
      expect(object.ContentType).to.equal('binary/octet-stream');
    });

    test('fails to update the metadata of an image object when no REPLACE MetadataDirective is specified', async function () {
      const key = 'image';

      const file = resolveFixturePath('image0.jpg');
      const data = await s3Client.send(
        new PutObjectCommand({
          Bucket: 'bucket-a',
          Key: key,
          Body: await fs.promises.readFile(file),
          ContentType: 'image/jpeg',
        }),
      );
      expect(data.ETag).to.match(/"[a-fA-F0-9]{32}"/);
      let error;
      try {
        await s3Client.send(
          new CopyObjectCommand({
            Bucket: 'bucket-a',
            Key: key,
            CopySource: '/bucket-a/' + key,
            Metadata: {
              someKey: 'value',
            },
          }),
        );
      } catch (err) {
        error = err;
      }
      expect(error).to.exist;
      expect(error.$metadata.httpStatusCode).to.equal(400);
    });

    test('fails to copy an image object because the object does not exist', async function () {
      let error;
      try {
        await s3Client.send(
          new CopyObjectCommand({
            Bucket: 'bucket-b',
            Key: 'image/jamie',
            CopySource: '/bucket-a/doesnotexist',
          }),
        );
      } catch (err) {
        error = err;
      }
      expect(error).to.exist;
      expect(error.Code).to.equal('NoSuchKey');
      expect(error.$metadata.httpStatusCode).to.equal(404);
    });

    test('fails to copy an image object because the source bucket does not exist', async function () {
      let error;
      try {
        await s3Client.send(
          new CopyObjectCommand({
            Bucket: 'bucket-b',
            Key: 'image/jamie',
            CopySource: '/falsebucket/doesnotexist',
          }),
        );
      } catch (err) {
        error = err;
      }
      expect(error).to.exist;
      expect(error.Code).to.equal('NoSuchBucket');
      expect(error.$metadata.httpStatusCode).to.equal(404);
    });
  });

  describe('PUT Object tagging', () => {
    test('tags an object in a bucket', async function () {
      await s3Client.send(
        new PutObjectCommand({
          Bucket: 'bucket-a',
          Key: 'text',
          Body: 'Hello!',
        }),
      );

      await s3Client.send(
        new PutObjectTaggingCommand({
          Bucket: 'bucket-a',
          Key: 'text',
          Tagging: { TagSet: [{ Key: 'Test', Value: 'true' }] },
        }),
      );

      const tagging = await s3Client.send(
        new GetObjectTaggingCommand({
          Bucket: 'bucket-a',
          Key: 'text',
        }),
      );

      expect(tagging).to.deep.contains({
        TagSet: [{ Key: 'Test', Value: 'true' }],
      });
    });

    test("errors when tagging an object that doesn't exist", async function () {
      await expect(
        s3Client.send(
          new PutObjectTaggingCommand({
            Bucket: 'bucket-a',
            Key: 'text',
            Tagging: { TagSet: [{ Key: 'Test', Value: 'true' }] },
          }),
        ),
      ).to.eventually.be.rejectedWith('The specified key does not exist.');
    });
  });

  describe('Initiate/Upload/Complete Multipart upload', () => {
    test('uploads a text file to a multi directory path', async function () {
      const data = await s3Client.send(
        new PutObjectCommand({
          Bucket: 'bucket-a',
          Key: 'multi/directory/path/text',
          Body: 'Hello!',
        }),
      );
      expect(data.ETag).to.match(/"[a-fA-F0-9]{32}"/);
    });

    test('completes a managed upload <=5MB', async function () {
      const uploader = new Upload({
        client: s3Client,
        params: {
          Bucket: 'bucket-a',
          Key: 'multi/directory/path/multipart',
          Body: Buffer.alloc(2 * Math.pow(1024, 2)), // 2MB
        },
      });
      const data =
        (await uploader.done()) as CompleteMultipartUploadCommandOutput; // TODO: remove type conversion
      expect(data.ETag).to.match(/"[a-fA-F0-9]{32}"/);
    });

    test('completes a managed upload >5MB (multipart upload)', async function () {
      const uploader = new Upload({
        client: s3Client,
        params: {
          Bucket: 'bucket-a',
          Key: 'multi/directory/path/multipart',
          Body: Buffer.alloc(20 * Math.pow(1024, 2)), // 20MB
        },
      });
      const data =
        (await uploader.done()) as CompleteMultipartUploadCommandOutput; // TODO: remove type conversion
      expect(data.ETag).to.match(/"[a-fA-F0-9]{32}"/);
    });

    test('completes a multipart upload with unquoted ETags', async function () {
      const data = await s3Client.send(
        new CreateMultipartUploadCommand({
          Bucket: 'bucket-a',
          Key: 'multi/directory/path/multipart',
        }),
      );
      const partRes = await s3Client.send(
        new UploadPartCommand({
          Body: 'Hello!',
          PartNumber: 1,
          ...data,
        }),
      );
      await s3Client.send(
        new CompleteMultipartUploadCommand({
          MultipartUpload: {
            Parts: [
              {
                PartNumber: 1,
                ETag: JSON.parse(partRes.ETag),
              },
            ],
          },
          ...data,
        }),
      );
    });

    test('completes a multipart upload with metadata', async function () {
      const uploader = new Upload({
        client: s3Client,
        params: {
          Bucket: 'bucket-a',
          Key: 'multi/directory/path/multipart',
          Body: Buffer.alloc(20 * Math.pow(1024, 2)), // 20MB
          Metadata: {
            someKey: 'value',
          },
        },
      });
      const data =
        (await uploader.done()) as CompleteMultipartUploadCommandOutput; // TODO: remove type conversion
      expect(data.ETag).to.match(/"[a-fA-F0-9]{32}"/);
      const object = await s3Client.send(
        new GetObjectCommand({
          Bucket: 'bucket-a',
          Key: 'multi/directory/path/multipart',
        }),
      );
      expect(object.Metadata.somekey).to.equal('value');
    });

    test('should upload a part by copying it', async function () {
      const upload = await s3Client.send(
        new CreateMultipartUploadCommand({
          Bucket: 'bucket-a',
          Key: 'merged',
        }),
      );
      await s3Client.send(
        new PutObjectCommand({
          Bucket: 'bucket-a',
          Key: 'part',
          Body: Buffer.alloc(20 * Math.pow(1024, 2)), // 20MB
        }),
      );
      const data = await s3Client.send(
        new UploadPartCopyCommand({
          CopySource: 'bucket-a/part',
          Bucket: 'bucket-a',
          Key: 'destination',
          PartNumber: 1,
          UploadId: upload.UploadId,
        }),
      );
      expect(JSON.parse(data.CopyPartResult.ETag)).to.be.ok;
      await s3Client.send(
        new CompleteMultipartUploadCommand({
          Bucket: 'bucket-a',
          Key: 'desintation',
          UploadId: upload.UploadId,
          MultipartUpload: {
            Parts: [
              {
                ETag: data.CopyPartResult.ETag,
                PartNumber: 1,
              },
            ],
          },
        }),
      );
    });

    test('should copy parts from bucket to bucket', async function () {
      const upload = await s3Client.send(
        new CreateMultipartUploadCommand({
          Bucket: 'bucket-a',
          Key: 'merged',
        }),
      );
      await s3Client.send(
        new PutObjectCommand({
          Bucket: 'bucket-b',
          Key: 'part',
          Body: Buffer.alloc(20 * Math.pow(1024, 2)), // 20MB
        }),
      );
      const data = await s3Client.send(
        new UploadPartCopyCommand({
          CopySource: `bucket-b/part`,
          Bucket: 'bucket-a',
          Key: 'destination',
          PartNumber: 1,
          UploadId: upload.UploadId,
        }),
      );
      expect(JSON.parse(data.CopyPartResult.ETag)).to.be.ok;
    });

    test('should copy a part range from bucket to bucket', async function () {
      const upload = await s3Client.send(
        new CreateMultipartUploadCommand({
          Bucket: 'bucket-a',
          Key: 'merged',
        }),
      );
      await s3Client.send(
        new PutObjectCommand({
          Bucket: 'bucket-b',
          Key: 'part',
          Body: Buffer.alloc(20 * Math.pow(1024, 2)), // 20MB
        }),
      );
      const data = await s3Client.send(
        new UploadPartCopyCommand({
          CopySource: `bucket-b/part`,
          CopySourceRange: 'bytes=0-10',
          Bucket: 'bucket-a',
          Key: 'destination',
          PartNumber: 1,
          UploadId: upload.UploadId,
        }),
      );
      expect(JSON.parse(data.CopyPartResult.ETag)).to.be.ok;
    });

    test('fails to copy a part range for an out of bounds requests', async function () {
      const upload = await s3Client.send(
        new CreateMultipartUploadCommand({
          Bucket: 'bucket-a',
          Key: 'merged',
        }),
      );
      const body = Buffer.alloc(20 * Math.pow(1024, 2)); // 20MB
      await s3Client.send(
        new PutObjectCommand({
          Bucket: 'bucket-b',
          Key: 'part',
          Body: body,
        }),
      );

      let error;
      try {
        await s3Client.send(
          new UploadPartCopyCommand({
            CopySource: `bucket-b/part`,
            CopySourceRange: `bytes=${body.length - 10}-${body.length}`,
            Bucket: 'bucket-a',
            Key: 'destination',
            PartNumber: 1,
            UploadId: upload.UploadId,
          }),
        );
      } catch (err) {
        error = err;
      }
      expect(error).to.exist;
      expect(error.Code).to.equal('InvalidArgument');
      expect(error.message).to.equal(
        `Range specified is not valid for source object of size: ${body.length}`,
      );
    });

    test('fails to copy a part from a nonexistent bucket', async function () {
      const upload = await s3Client.send(
        new CreateMultipartUploadCommand({
          Bucket: 'bucket-a',
          Key: 'merged',
        }),
      );

      let error;
      try {
        await s3Client.send(
          new UploadPartCopyCommand({
            CopySource: `not-exist/part`,
            Bucket: 'bucket-a',
            Key: 'destination',
            PartNumber: 1,
            UploadId: upload.UploadId,
          }),
        );
      } catch (err) {
        error = err;
      }
      expect(error).to.exist;
      expect(error.Code).to.equal('NoSuchBucket');
    });

    test('fails to copy a part from a nonexistent key', async function () {
      const upload = await s3Client.send(
        new CreateMultipartUploadCommand({
          Bucket: 'bucket-a',
          Key: 'merged',
        }),
      );

      let error;
      try {
        await s3Client.send(
          new UploadPartCopyCommand({
            CopySource: `bucket-b/not-exist`,
            Bucket: 'bucket-a',
            Key: 'destination',
            PartNumber: 1,
            UploadId: upload.UploadId,
          }),
        );
      } catch (err) {
        error = err;
      }
      expect(error).to.exist;
      expect(error.Code).to.equal('NoSuchKey');
    });
  });
});
