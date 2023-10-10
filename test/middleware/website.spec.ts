'use strict';

import { describe, test, beforeEach } from '@jest/globals';
import { createRequire } from 'node:module';
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
import { expect } from 'chai';
import fs from 'fs';

import { createServerAndClient2, getEndpointHref } from '../helpers';

const require = createRequire(import.meta.url);
const request = require('request-promise-native').defaults({
  resolveWithFullResponse: true,
});

describe('Static Website Tests', function () {
  let s3Client: S3Client;
  const buckets = [
    // a bucket with no additional config
    {
      name: 'bucket-a',
    },

    // A standard static hosting configuration with no custom error page
    {
      name: 'website0',
      configs: [
        fs.readFileSync(require.resolve('../fixtures/website-test0.xml')),
      ],
    },

    // A static website with a custom error page
    {
      name: 'website1',
      configs: [
        fs.readFileSync(require.resolve('../fixtures/website-test1.xml')),
      ],
    },

    // A static website with a single simple routing rule
    {
      name: 'website2',
      configs: [
        fs.readFileSync(require.resolve('../fixtures/website-test2.xml')),
      ],
    },

    // A static website with multiple routing rules
    {
      name: 'website3',
      configs: [
        fs.readFileSync(require.resolve('../fixtures/website-test3.xml')),
      ],
    },
  ];

  beforeEach(async () => {
    ({ s3Client } = await createServerAndClient2({
      configureBuckets: buckets,
    }));
  });

  test('fails to read an object at the website endpoint from a bucket with no website configuration', async function () {
    await s3Client.send(
      new PutObjectCommand({
        Bucket: 'bucket-a',
        Key: 'page/index.html',
        Body: '<html><body>Hello</body></html>',
      }),
    );
    const href = await getEndpointHref(s3Client);
    let res;
    try {
      res = await request('page/', {
        baseUrl: href,
        headers: { host: `bucket-a.s3-website-us-east-1.amazonaws.com` },
      });
    } catch (err) {
      res = err.response;
    }
    expect(res.statusCode).to.equal(404);
    expect(res.headers).to.have.property(
      'content-type',
      'text/html; charset=utf-8',
    );
    expect(res.body).to.contain('Code: NoSuchWebsiteConfiguration');
  });

  test('returns an index page at / path', async function () {
    const expectedBody = '<html><body>Hello</body></html>';
    await s3Client.send(
      new PutObjectCommand({
        Bucket: 'website0',
        Key: 'index.html',
        Body: expectedBody,
      }),
    );
    const href = await getEndpointHref(s3Client);
    const res = await request('website0/', {
      baseUrl: href,
      headers: { accept: 'text/html' },
    });
    expect(res.body).to.equal(expectedBody);
  });

  test('allows redirects for image requests', async function () {
    const href = await getEndpointHref(s3Client);
    let res;
    try {
      res = await request('website3/complex/image.png', {
        baseUrl: href,
        headers: { accept: 'image/png' },
        followRedirect: false,
      });
    } catch (err) {
      res = err.response;
    }
    expect(res.statusCode).to.equal(307);
    expect(res.headers).to.have.property(
      'location',
      'https://custom/replacement',
    );
  });

  test('returns an index page at /page/ path', async function () {
    const expectedBody = '<html><body>Hello</body></html>';
    await s3Client.send(
      new PutObjectCommand({
        Bucket: 'website0',
        Key: 'page/index.html',
        Body: expectedBody,
      }),
    );
    const href = await getEndpointHref(s3Client);
    const res = await request('website0/page/', {
      baseUrl: href,
      headers: { accept: 'text/html' },
    });
    expect(res.body).to.equal(expectedBody);
  });

  test('does not return an index page at /page/ path if an object is stored with a trailing /', async function () {
    const indexBody = '<html><body>Hello</body></html>';
    const expectedBody = '<html><body>Goodbye</body></html>';
    await s3Client.send(
      new PutObjectCommand({
        Bucket: 'website0',
        Key: 'page/index.html',
        Body: indexBody,
      }),
    );
    await s3Client.send(
      new PutObjectCommand({
        Bucket: 'website0',
        Key: 'page/',
        Body: expectedBody,
      }),
    );

    const href = await getEndpointHref(s3Client);
    const res = await request('website0/page/', {
      baseUrl: href,
      headers: { accept: 'text/html' },
    });
    expect(res.body).to.equal(expectedBody);
  });

  test('redirects with a 302 status at /page path', async function () {
    const body = '<html><body>Hello</body></html>';
    await s3Client.send(
      new PutObjectCommand({
        Bucket: 'website0',
        Key: 'page/index.html',
        Body: body,
      }),
    );
    const href = await getEndpointHref(s3Client);
    let res;
    try {
      res = await request('website0/page', {
        baseUrl: href,
        headers: { accept: 'text/html' },
        followRedirect: false,
      });
    } catch (err) {
      res = err.response;
    }
    expect(res.statusCode).to.equal(302);
    expect(res.headers).to.have.property('location', '/website0/page/');
  });

  test('redirects with 302 status at /page path for subdomain-style bucket', async function () {
    const body = '<html><body>Hello</body></html>';
    await s3Client.send(
      new PutObjectCommand({
        Bucket: 'website0',
        Key: 'page/index.html',
        Body: body,
      }),
    );
    const href = await getEndpointHref(s3Client);
    let res;
    try {
      res = await request('page', {
        baseUrl: href,
        headers: { host: 'website0.s3-website-us-east-1.amazonaws.com' },
        followRedirect: false,
      });
    } catch (err) {
      res = err.response;
    }
    expect(res.statusCode).to.equal(302);
    expect(res.headers).to.have.property('location', '/page/');
  });

  test('returns a HTML 404 error page', async function () {
    const href = await getEndpointHref(s3Client);
    let res;
    try {
      res = await request('website0/page/not-exists', {
        baseUrl: href,
        headers: { accept: 'text/html' },
      });
    } catch (err) {
      res = err.response;
    }
    expect(res.statusCode).to.equal(404);
    expect(res.headers).to.have.property(
      'content-type',
      'text/html; charset=utf-8',
    );
    expect(res.body).to.contain.string('Key: page/not-exists');
  });

  test('returns a HTML 404 error page for a missing index key', async function () {
    const href = await getEndpointHref(s3Client);
    let res;
    try {
      res = await request('website0/page/not-exists/', {
        baseUrl: href,
        headers: { accept: 'text/html' },
      });
    } catch (err) {
      res = err.response;
    }
    expect(res.statusCode).to.equal(404);
    expect(res.headers).to.have.property(
      'content-type',
      'text/html; charset=utf-8',
    );
    expect(res.body).to.contain.string('Key: page/not-exists/index.html');
  });

  test('serves a custom error page if it exists', async function () {
    const body = '<html><body>Oops!</body></html>';
    await s3Client.send(
      new PutObjectCommand({
        Bucket: 'website1',
        Key: 'error.html',
        Body: body,
        ContentType: 'text/html',
      }),
    );
    const href = await getEndpointHref(s3Client);
    let res;
    try {
      res = await request('website1/page/not-exists', {
        baseUrl: href,
        headers: { accept: 'text/html' },
      });
    } catch (err) {
      res = err.response;
    }
    expect(res.headers).to.have.property(
      'content-type',
      'text/html; charset=utf-8',
    );
    expect(res.body).to.equal(body);
  });

  test('returns a XML error document for SDK requests', async function () {
    let error;
    try {
      await s3Client.send(
        new GetObjectCommand({
          Bucket: 'website0',
          Key: 'page/not-exists',
        }),
      );
    } catch (err) {
      error = err;
    }
    expect(error).to.exist;
    expect(error.$metadata.httpStatusCode).to.equal(404);
    expect(error.Code).to.equal('NoSuchKey');
  });

  test('stores an object with website-redirect-location metadata', async function () {
    const redirectLocation = 'https://github.com/jamhall/s3rver';
    await s3Client.send(
      new PutObjectCommand({
        Bucket: 'website0',
        Key: 'index.html',
        Body: '<html><body>Hello</body></html>',
        WebsiteRedirectLocation: redirectLocation,
      }),
    );
    const res = await s3Client.send(
      new GetObjectCommand({
        Bucket: 'website0',
        Key: 'index.html',
      }),
    );
    expect(res).to.have.property('WebsiteRedirectLocation', redirectLocation);
  });

  test('redirects for an object stored with a website-redirect-location', async function () {
    const redirectLocation = 'https://github.com/jamhall/s3rver';
    await s3Client.send(
      new PutObjectCommand({
        Bucket: 'website0',
        Key: 'index.html',
        Body: '<html><body>Hello</body></html>',
        WebsiteRedirectLocation: redirectLocation,
      }),
    );
    const href = await getEndpointHref(s3Client);
    let res;
    try {
      res = await request(`website0/`, {
        baseUrl: href,
        headers: { accept: 'text/html' },
        followRedirect: false,
      });
    } catch (err) {
      res = err.response;
    }
    expect(res.statusCode).to.equal(301);
    expect(res.headers).to.have.property('location', redirectLocation);
  });

  test('redirects for a custom error page stored with a website-redirect-location', async function () {
    const redirectLocation = 'https://github.com/jamhall/s3rver';
    const body = '<html><body>Hello</body></html>';
    await s3Client.send(
      new PutObjectCommand({
        Bucket: 'website1',
        Key: 'error.html',
        Body: body,
        WebsiteRedirectLocation: redirectLocation,
      }),
    );
    const href = await getEndpointHref(s3Client);
    let res;
    try {
      res = await request(`website1/page/`, {
        baseUrl: href,
        headers: { accept: 'text/html' },
        followRedirect: false,
      });
    } catch (err) {
      res = err.response;
    }
    expect(res.statusCode).to.equal(301);
    expect(res.headers).to.have.property('location', redirectLocation);
  });

  describe('Routing rules', () => {
    test('evaluates a single simple routing rule', async function () {
      const href = await getEndpointHref(s3Client);
      let res;
      try {
        res = await request(`website2/test/key/`, {
          baseUrl: href,
          headers: { accept: 'text/html' },
          followRedirect: false,
        });
      } catch (err) {
        res = err.response;
      }
      expect(res.statusCode).to.equal(301);
      expect(res.headers).to.have.property(
        'location',
        href + 'website2/replacement/key/',
      );
    });

    test('does not evaluate routing rules for an index page', async function () {
      const expectedBody = '<html><body>Hello</body></html>';
      await s3Client.send(
        new PutObjectCommand({
          Bucket: 'website2',
          Key: 'recursive/foo/index.html',
          Body: expectedBody,
        }),
      );
      const href = await getEndpointHref(s3Client);
      const res = await request('website2/recursive/foo/', {
        baseUrl: href,
        headers: { accept: 'text/html' },
      });
      expect(res.body).to.equal(expectedBody);
    });

    test('does not evaluate routing rules for an index page redirect', async function () {
      const expectedBody = '<html><body>Hello</body></html>';
      await s3Client.send(
        new PutObjectCommand({
          Bucket: 'website2',
          Key: 'recursive/foo/index.html',
          Body: expectedBody,
        }),
      );
      const href = await getEndpointHref(s3Client);
      let res;
      try {
        res = await request('website2/recursive/foo', {
          baseUrl: href,
          headers: { accept: 'text/html' },
          followRedirect: false,
        });
      } catch (err) {
        res = err.response;
      }
      expect(res.statusCode).to.equal(302);
      expect(res.headers).to.have.property(
        'location',
        '/website2/recursive/foo/',
      );
    });

    test('evaluates a multi-rule config', async function () {
      const href = await getEndpointHref(s3Client);
      let res;
      try {
        res = await request(`website3/simple/key`, {
          baseUrl: href,
          headers: { accept: 'text/html' },
          followRedirect: false,
        });
      } catch (err) {
        res = err.response;
      }
      expect(res.statusCode).to.equal(301);
      expect(res.headers).to.have.property(
        'location',
        href + 'website3/replacement/key',
      );
    });

    test('evaluates a complex rule', async function () {
      const href = await getEndpointHref(s3Client);
      let res;
      try {
        res = await request(`website3/complex/key`, {
          baseUrl: href,
          headers: { accept: 'text/html' },
          followRedirect: false,
        });
      } catch (err) {
        res = err.response;
      }
      expect(res.statusCode).to.equal(307);
      expect(res.headers).to.have.property(
        'location',
        'https://custom/replacement',
      );
    });
  });
});
