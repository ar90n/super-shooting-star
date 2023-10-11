'use strict';

import { describe, test, beforeEach, afterEach } from '@jest/globals';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import { expect } from 'chai';
import fs from 'fs';

import {
  createServerAndClient2,
  getEndpointHref,
  resolveFixturePath,
} from '../helpers';

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
      configs: [fs.readFileSync(resolveFixturePath('website-test0.xml'))],
    },

    // A static website with a custom error page
    {
      name: 'website1',
      configs: [fs.readFileSync(resolveFixturePath('website-test1.xml'))],
    },

    // A static website with a single simple routing rule
    {
      name: 'website2',
      configs: [fs.readFileSync(resolveFixturePath('website-test2.xml'))],
    },

    // A static website with multiple routing rules
    {
      name: 'website3',
      configs: [fs.readFileSync(resolveFixturePath('website-test3.xml'))],
    },
  ];

  beforeEach(async () => {
    ({ s3Client } = await createServerAndClient2({
      configureBuckets: buckets,
    }));
  });

  afterEach(async function () {
    s3Client.destroy();
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
      res = await fetch(`${href}page/`, {
        headers: { host: `bucket-a.s3-website-us-east-1.amazonaws.com` },
      });
    } catch (err) {
      res = err.response;
    }
    expect(res.status).to.equal(404);
    expect(res.headers.get('content-type')).to.equal(
      'text/html; charset=utf-8',
    );
    expect(res.text()).to.eventually.contain(
      'Code: NoSuchWebsiteConfiguration',
    );
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
    const res = await fetch(`${href}website0/`, {
      headers: { accept: 'text/html' },
    });
    expect(res.text()).to.eventually.equal(expectedBody);
  });

  test('allows redirects for image requests', async function () {
    const href = await getEndpointHref(s3Client);
    let res;
    try {
      res = await fetch(`${href}website3/complex/image.png`, {
        headers: { accept: 'image/png' },
        redirect: 'manual',
      });
    } catch (err) {
      res = err.response;
    }
    expect(res.status).to.equal(307);
    expect(res.headers.get('location')).to.equal('https://custom/replacement');
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
    const res = await fetch(`${href}website0/page/`, {
      headers: { accept: 'text/html' },
    });
    expect(res.text()).to.eventually.equal(expectedBody);
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
    const res = await fetch(`${href}website0/page/`, {
      headers: { accept: 'text/html' },
    });
    expect(res.text()).to.eventually.include(expectedBody);
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
      res = await fetch(`${href}website0/page`, {
        headers: { accept: 'text/html' },
        redirect: 'manual',
      });
    } catch (err) {
      res = err.response;
    }
    expect(res.status).to.equal(302);
    expect(res.headers.get('location')).to.equal('/website0/page/');
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
      res = await fetch(`${href}page`, {
        headers: { host: 'website0.s3-website-us-east-1.amazonaws.com' },
        redirect: 'manual',
      });
    } catch (err) {
      res = err.response;
    }
    expect(res.status).to.equal(302);
    expect(res.headers.get('location')).to.equal('/page/');
  });

  test('returns a HTML 404 error page', async function () {
    const href = await getEndpointHref(s3Client);
    let res;
    try {
      res = await fetch(`${href}website0/page/not-exists`, {
        headers: { accept: 'text/html' },
      });
    } catch (err) {
      res = err.response;
    }
    expect(res.status).to.equal(404);
    expect(res.headers.get('content-type')).to.equal(
      'text/html; charset=utf-8',
    );
    expect(res.text()).to.eventually.contain.string('Key: page/not-exists');
  });

  test('returns a HTML 404 error page for a missing index key', async function () {
    const href = await getEndpointHref(s3Client);
    let res;
    try {
      res = await fetch(`${href}website0/page/not-exists/`, {
        headers: { accept: 'text/html' },
      });
    } catch (err) {
      res = err.response;
    }
    expect(res.status).to.equal(404);
    expect(res.headers.get('content-type')).to.equal(
      'text/html; charset=utf-8',
    );
    expect(res.text()).to.eventually.contain.string(
      'Key: page/not-exists/index.html',
    );
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
      res = await fetch(`${href}website1/page/not-exists`, {
        headers: { accept: 'text/html' },
      });
    } catch (err) {
      res = err.response;
    }
    expect(res.headers.get('content-type')).to.equal(
      'text/html; charset=utf-8',
    );
    expect(res.text()).to.eventually.equal(body);
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
      res = await fetch(`${href}website0/`, {
        headers: { accept: 'text/html' },
        redirect: 'manual',
      });
    } catch (err) {
      res = err.response;
    }
    expect(res.status).to.equal(301);
    expect(res.headers.get('location')).to.equal(redirectLocation);
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
      res = await fetch(`${href}website1/page/`, {
        headers: { accept: 'text/html' },
        redirect: 'manual',
      });
    } catch (err) {
      res = err.response;
    }
    expect(res.status).to.equal(301);
    expect(res.headers.get('location')).to.equal(redirectLocation);
  });

  describe('Routing rules', () => {
    test('evaluates a single simple routing rule', async function () {
      const href = await getEndpointHref(s3Client);
      let res;
      try {
        res = await fetch(`${href}website2/test/key/`, {
          headers: { accept: 'text/html' },
          redirect: 'manual',
        });
      } catch (err) {
        res = err.response;
      }
      expect(res.status).to.equal(301);
      expect(res.headers.get('location')).to.equal(
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
      const res = await fetch(`${href}website2/recursive/foo/`, {
        headers: { accept: 'text/html' },
      });
      expect(res.text()).to.eventually.equal(expectedBody);
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
        res = await fetch(`${href}website2/recursive/foo`, {
          headers: { accept: 'text/html' },
          redirect: 'manual',
        });
      } catch (err) {
        res = err.response;
      }
      expect(res.status).to.equal(302);
      expect(res.headers.get('location')).to.equal('/website2/recursive/foo/');
    });

    test('evaluates a multi-rule config', async function () {
      const href = await getEndpointHref(s3Client);
      let res;
      try {
        res = await fetch(`${href}website3/simple/key`, {
          headers: { accept: 'text/html' },
          redirect: 'manual',
        });
      } catch (err) {
        res = err.response;
      }
      expect(res.status).to.equal(301);
      expect(res.headers.get('location')).to.equal(
        href + 'website3/replacement/key',
      );
    });

    test('evaluates a complex rule', async function () {
      const href = await getEndpointHref(s3Client);
      let res;
      try {
        res = await fetch(`${href}website3/complex/key`, {
          headers: { accept: 'text/html' },
          redirect: 'manual',
        });
      } catch (err) {
        res = err.response;
      }
      expect(res.status).to.equal(307);
      expect(res.headers.get('location')).to.equal(
        'https://custom/replacement',
      );
    });
  });
});
