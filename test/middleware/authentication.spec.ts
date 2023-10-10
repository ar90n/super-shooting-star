'use strict';

import { describe, test, beforeEach } from '@jest/globals';
import { createRequire } from 'node:module';
import { expect } from 'chai';
import express from 'express';
import fs from 'fs';
import { URL } from 'url';
import { toISO8601String } from '../../lib/utils';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createServerAndClient2, getEndpointHref } from '../helpers';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';

const require = createRequire(import.meta.url);
const request = require('request-promise-native').defaults({
  resolveWithFullResponse: true,
});

describe('REST Authentication', () => {
  let s3rver;
  let s3Client;
  const buckets = [
    {
      name: 'bucket-a',
    },
  ];

  beforeEach(async function () {
    ({ s3rver, s3Client } = await createServerAndClient2({
      configureBuckets: buckets,
    }));
  });

  test('can GET a signed URL with subdomain bucket', async function () {
    await s3Client.send(
      new PutObjectCommand({ Bucket: 'bucket-a', Key: 'text', Body: 'Hello!' }),
    );
    const endpointHref = await getEndpointHref(s3Client);

    const s3ClientReq = new S3Client({
      credentials: {
        accessKeyId: 'S3RVER',
        secretAccessKey: 'S3RVER',
      },
      endpoint: `https://s3.amazonaws.com`,
      forcePathStyle: false,
      region: 'localhost',
    });

    const url = await getSignedUrl(
      s3ClientReq,
      new GetObjectCommand({
        Bucket: 'bucket-a',
        Key: 'text',
      }),
    );

    const { host, pathname, searchParams } = new URL(url);
    const res = await request(new URL(pathname, endpointHref), {
      qs: searchParams,
      headers: { host },
    });
    expect(res.body).to.equal('Hello!');
  });

  test('can GET a signed URL with vhost bucket', async function () {
    await s3Client.send(
      new PutObjectCommand({ Bucket: 'bucket-a', Key: 'text', Body: 'Hello!' }),
    );
    const endpointHref = await getEndpointHref(s3Client);
    const { port, protocol, path } = await s3Client.config.endpoint();

    const s3ClientReq = new S3Client({
      credentials: {
        accessKeyId: 'S3RVER',
        secretAccessKey: 'S3RVER',
      },
      forcePathStyle: false,
      region: 'localhost',
    });

    const url = await getSignedUrl(
      s3ClientReq,
      new GetObjectCommand({
        Bucket: 'bucket-a',
        Key: 'text',
      }),
    );

    const { host, pathname, searchParams } = new URL(url);
    const res = await request(new URL(pathname, endpointHref), {
      qs: searchParams,
      headers: { host },
    });
    expect(res.body).to.equal('Hello!');
  });

  test('rejects a request specifying multiple auth mechanisms', async function () {
    const endpointHref = await getEndpointHref(s3Client);
    let res;
    try {
      res = await request('bucket-a/mykey', {
        baseUrl: endpointHref,
        qs: {
          'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
          Signature: 'dummysig',
        },
        headers: {
          Authorization: 'AWS S3RVER:dummysig',
        },
      });
    } catch (err) {
      res = err.response;
    }
    expect(res.statusCode).to.equal(400);
    expect(res.body).to.contain('<Code>InvalidArgument</Code>');
  });

  test('rejects a request with signature version 2', async function () {
    const endpointHref = await getEndpointHref(s3Client);
    let res;
    try {
      res = await request('bucket-a/mykey', {
        baseUrl: endpointHref,
        headers: {
          Authorization: 'AWS S3RVER dummysig',
        },
      });
    } catch (err) {
      res = err.response;
    }
    expect(res.statusCode).to.equal(400);
    expect(res.body).to.contain('<Code>InvalidArgument</Code>');
  });

  test('rejects a request with an invalid authorization header [v4]', async function () {
    const endpointHref = await getEndpointHref(s3Client);
    let res;
    try {
      res = await request('bucket-a/mykey', {
        baseUrl: endpointHref,
        headers: {
          // omitting Signature and SignedHeaders components
          Authorization:
            'AWS4-HMAC-SHA256 Credential=S3RVER/20060301/us-east-1/s3/aws4_request',
          'X-Amz-Content-SHA256': 'UNSIGNED-PAYLOAD',
        },
      });
    } catch (err) {
      res = err.response;
    }
    expect(res.statusCode).to.equal(400);
    expect(res.body).to.contain('<Code>AuthorizationHeaderMalformed</Code>');
  });

  test('rejects a request with invalid query params [v4]', async function () {
    const endpointHref = await getEndpointHref(s3Client);
    let res;
    try {
      res = await request('bucket-a/mykey', {
        baseUrl: endpointHref,
        qs: {
          'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
          'X-Amz-Signature': 'dummysig',
          // omitting most other parameters for sig v4
        },
      });
    } catch (err) {
      res = err.response;
    }
    expect(res.statusCode).to.equal(400);
    expect(res.body).to.contain(
      '<Code>AuthorizationQueryParametersError</Code>',
    );
  });

  test('rejects a request with a large time skew', async function () {
    const endpointHref = await getEndpointHref(s3Client);
    let res;
    try {
      res = await request('bucket-a/mykey', {
        baseUrl: endpointHref,
        headers: {
          Authorization:
            'AWS4-HMAC-SHA256 Credential=S3RVER/20060301/us-east-1/s3/aws4_request, SignedHeaders=host, Signature=badsig',
          'X-Amz-Content-SHA256': 'UNSIGNED-PAYLOAD',
          'X-Amz-Date': new Date(Date.now() + 20000 * 60).toUTCString(),
        },
      });
    } catch (err) {
      res = err.response;
    }
    expect(res.statusCode).to.equal(403);
    expect(res.body).to.contain('<Code>RequestTimeTooSkewed</Code>');
  });

  test('rejects an expired presigned request [v4]', async function () {
    const url = await getSignedUrl(
      s3Client,
      new GetObjectCommand({
        Bucket: 'bucket-a',
        Key: 'mykey',
      }),
      {
        expiresIn: -10, // 10 seconds in the past
      },
    );
    let res;
    try {
      res = await request(url);
    } catch (err) {
      res = err.response;
    }
    expect(res.statusCode).to.equal(403);
    expect(res.body).to.contain('<Code>AccessDenied</Code>');
  });

  test('rejects a presigned request with an invalid expiration [v4]', async function () {
    // aws-sdk unfortunately doesn't expose a way to set the timestamp of the request to presign
    // so we have to construct a mostly-valid request ourselves
    const endpointHref = await getEndpointHref(s3Client);
    let res;
    try {
      res = await request('bucket-a/mykey', {
        baseUrl: endpointHref,
        qs: {
          'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
          'X-Amz-Credential': 'S3RVER/20060301/us-east-1/s3/aws4_request',
          'X-Amz-SignedHeaders': 'host',
          'X-Amz-Signature': 'dummysig',
          // 10 minutes in the past
          'X-Amz-Date': toISO8601String(Date.now() - 20000 * 60),
          'X-Amz-Expires': 20,
        },
      });
    } catch (err) {
      res = err.response;
    }
    expect(res.statusCode).to.equal(403);
    expect(res.body).to.contain('<Code>AccessDenied</Code>');
  });

  test('overrides response headers in signed GET requests', async function () {
    await s3Client.send(
      new PutObjectCommand({
        Bucket: 'bucket-a',
        Key: 'image',
        Body: await fs.promises.readFile(
          require.resolve('../fixtures/image0.jpg'),
        ),
      }),
    );
    const url = await getSignedUrl(
      s3Client,
      new GetObjectCommand({
        Bucket: 'bucket-a',
        Key: 'image',
        ResponseContentType: 'image/jpeg',
        ResponseContentDisposition: 'attachment',
      }),
    );
    const res = await request(url);
    expect(res.headers['content-type']).to.equal('image/jpeg');
    expect(res.headers['content-disposition']).to.equal('attachment');
  });

  test('rejects anonymous requests with response header overrides in GET requests', async function () {
    await s3Client.send(
      new PutObjectCommand({
        Bucket: 'bucket-a',
        Key: 'image',
        Body: await fs.promises.readFile(
          require.resolve('../fixtures/image0.jpg'),
        ),
      }),
    );
    const endpointHref = await getEndpointHref(s3Client);
    let res;
    try {
      res = await request('bucket-a/image', {
        baseUrl: endpointHref,
        qs: {
          'response-content-type': 'image/jpeg',
        },
      });
    } catch (err) {
      res = err.response;
    }
    expect(res.statusCode).to.equal(400);
    expect(res.body).to.contain('<Code>InvalidRequest</Code>');
  });

  test('adds x-amz-meta-* metadata specified via query parameters', async function () {
    const url = await getSignedUrl(
      s3Client,
      new PutObjectCommand({
        Bucket: 'bucket-a',
        Key: 'mykey',
        Metadata: {
          somekey: 'value',
        },
      }),
    );
    await request.put(url, { body: 'Hello!' });
    const object = await s3Client.send(
      new HeadObjectCommand({
        Bucket: 'bucket-a',
        Key: 'mykey',
      }),
    );
    expect(object.Metadata).to.have.property('somekey', 'value');
  });

  test('can use signed URLs while mounted on a subpath', async function () {
    const app = express();
    app.use('/basepath', s3rver.getMiddleware());

    const { httpServer } = s3rver;
    httpServer.removeAllListeners('request');
    httpServer.on('request', app);

    const { port, protocol, path } = await s3Client.config.endpoint();

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
      new PutObjectCommand({ Bucket: 'bucket-a', Key: 'text', Body: 'Hello!' }),
    );

    const url = await getSignedUrl(
      s3ClientReq,
      new GetObjectCommand({
        Bucket: 'bucket-a',
        Key: 'text',
      }),
    );

    const res = await request(url);
    expect(res.body).to.equal('Hello!');
  });

  test.skip('can use signed vhost URLs while mounted on a subpath', async function () {
    await s3Client.send(
      new PutObjectCommand({ Bucket: 'bucket-a', Key: 'text', Body: 'Hello!' }),
    );

    const app = express();
    app.use('/basepath', s3rver.getMiddleware());

    const { httpServer } = s3rver;
    httpServer.removeAllListeners('request');
    httpServer.on('request', app);

    const { port, protocol } = await s3Client.config.endpoint();
    const endpointHref = await getEndpointHref(s3Client);

    const s3ClientReq = new S3Client({
      credentials: {
        accessKeyId: 'S3RVER',
        secretAccessKey: 'S3RVER',
      },
      endpoint: `${protocol}//bucket-a:${port}/`,
      forcePathStyle: false,
      region: 'localhost',
    });

    const url = await getSignedUrl(
      s3ClientReq,
      new GetObjectCommand({
        Bucket: 'bucket-a',
        Key: 'text',
      }),
    );
    console.log(url);

    const { host, pathname, searchParams } = new URL(url);
    const res = await request(new URL(pathname, endpointHref), {
      qs: searchParams,
      headers: { host },
    });
    expect(res.body).to.equal('Hello!');
  });

  test('rejects a request with an incorrect signature in header [v4]', async function () {
    const endpointHref = await getEndpointHref(s3Client);
    let res;
    try {
      res = await request('bucket-a/mykey', {
        baseUrl: endpointHref,
        headers: {
          Authorization:
            'AWS4-HMAC-SHA256 Credential=S3RVER/20060301/us-east-1/s3/aws4_request, SignedHeaders=host, Signature=badsig',
          'X-Amz-Content-SHA256': 'UNSIGNED-PAYLOAD',
          'X-Amz-Date': toISO8601String(Date.now()),
        },
      });
    } catch (err) {
      res = err.response;
    }
    expect(res.statusCode).to.equal(403);
    expect(res.body).to.contain('<Code>SignatureDoesNotMatch</Code>');
  });

  test('rejects a request with an incorrect signature in query params [v4]', async function () {
    const endpointHref = await getEndpointHref(s3Client);
    let res;
    try {
      res = await request('bucket-a/mykey', {
        baseUrl: endpointHref,
        qs: {
          'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
          'X-Amz-Credential': 'S3RVER/20200815/eu-west-2/s3/aws4_request',
          'X-Amz-Date': toISO8601String(Date.now()),
          'X-Amz-Expires': 30,
          'X-Amz-SignedHeaders': 'host',
          'X-Amz-Signature': 'badsig',
        },
      });
    } catch (err) {
      res = err.response;
    }
    expect(res.statusCode).to.equal(403);
    expect(res.body).to.contain('<Code>SignatureDoesNotMatch</Code>');
  });
});
