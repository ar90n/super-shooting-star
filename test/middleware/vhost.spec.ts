'use strict';

import { describe, test, beforeEach } from '@jest/globals';
import { createRequire } from 'node:module';
import { expect } from 'chai';
import { zip } from 'lodash-es';
import moment from 'moment';
import os from 'os';

import { createServerAndClient, parseXml, getEndpointHref } from '../helpers';

describe('Virtual Host resolution', () => {
  const buckets = [{ name: 'bucket-a' }, { name: 'bucket-b' }];

  test('lists objects with subdomain-domain style bucket access', async function () {
    const { s3Client } = await createServerAndClient({
      configureBuckets: buckets,
    });
    const href = await getEndpointHref(s3Client);
    const res = await fetch(href, {
      headers: { host: 'bucket-a.s3.amazonaws.com' },
    });
    const text = await res.text();
    expect(text).to.include(`<Name>bucket-a</Name>`);
  });

  test('lists objects with a vhost-style bucket access', async function () {
    const { s3Client } = await createServerAndClient({
      configureBuckets: buckets,
    });
    const href = await getEndpointHref(s3Client);
    const res = await fetch(href, {
      headers: { host: 'bucket-a' },
    });
    const text = await res.text();
    expect(text).to.include(`<Name>bucket-a</Name>`);
  });

  test('lists buckets when vhost-style bucket access is disabled', async function () {
    const { s3Client } = await createServerAndClient({
      vhostBuckets: false,
      configureBuckets: buckets,
    });
    const href = await getEndpointHref(s3Client);
    const res = await fetch(href, {
      headers: { host: 'bucket-a' },
    });
    const text = await res.text();
    const parsedBody = parseXml(text);
    expect(parsedBody).to.haveOwnProperty('ListAllMyBucketsResult');
    const parsedBuckets = parsedBody.ListAllMyBucketsResult.Buckets.Bucket;
    expect(parsedBuckets).to.be.instanceOf(Array);
    expect(parsedBuckets).to.have.lengthOf(buckets.length);
    for (const [bucket, config] of zip(parsedBuckets, buckets)) {
      expect(bucket.Name).to.equal(config.name);
      expect(moment(bucket.CreationDate).isValid()).to.be.true;
    }
  });

  test('lists buckets at a custom service endpoint', async function () {
    const { s3Client } = await createServerAndClient({
      serviceEndpoint: 'example.com',
      configureBuckets: buckets,
    });
    const href = await getEndpointHref(s3Client);
    const res = await fetch(href, {
      headers: { host: 's3.example.com' },
    });
    const text = await res.text();
    const parsedBody = parseXml(text);
    expect(parsedBody).to.haveOwnProperty('ListAllMyBucketsResult');
    const parsedBuckets = parsedBody.ListAllMyBucketsResult.Buckets.Bucket;
    expect(parsedBuckets).to.be.instanceOf(Array);
    expect(parsedBuckets).to.have.lengthOf(buckets.length);
    for (const [bucket, config] of zip(parsedBuckets, buckets)) {
      expect(bucket.Name).to.equal(config.name);
      expect(moment(bucket.CreationDate).isValid()).to.be.true;
    }
  });

  test('lists buckets at the OS hostname', async function () {
    const { s3Client } = await createServerAndClient({
      configureBuckets: buckets,
    });
    const href = await getEndpointHref(s3Client);
    const res = await fetch(href, {
      headers: { host: os.hostname() },
    });
    const text = await res.text();
    const parsedBody = parseXml(text);
    expect(parsedBody).to.haveOwnProperty('ListAllMyBucketsResult');
    const parsedBuckets = parsedBody.ListAllMyBucketsResult.Buckets.Bucket;
    expect(parsedBuckets).to.be.instanceOf(Array);
    expect(parsedBuckets).to.have.lengthOf(buckets.length);
    for (const [bucket, config] of zip(parsedBuckets, buckets)) {
      expect(bucket.Name).to.equal(config.name);
      expect(moment(bucket.CreationDate).isValid()).to.be.true;
    }
  });

  test('lists objects in a bucket at a custom service endpoint', async function () {
    const { s3Client } = await createServerAndClient({
      serviceEndpoint: 'example.com',
      configureBuckets: buckets,
    });
    const href = await getEndpointHref(s3Client);
    const res = await fetch(href, {
      headers: { host: 'bucket-a.s3.example.com' },
    });
    const text = await res.text();
    const parsedBody = parseXml(text);
    expect(parsedBody.ListBucketResult.Name).to.equal('bucket-a');
  });
});
