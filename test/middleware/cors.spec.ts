'use strict';

import { describe, test, beforeEach } from '@jest/globals';
import {
  PutObjectCommand,
  GetObjectCommand,
  DeleteBucketCorsCommand,
  GetBucketCorsCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { expect } from 'chai';
import fs from 'fs';

import S3rver from '../../lib/s3rver.js';
import { createClient, resolveFixturePath } from '../helpers.ts';

describe('CORS Policy Tests', function () {
  const buckets = [
    // provides rules for origins http://a-test.example.com and http://*.bar.com
    {
      name: 'bucket0',
      configs: [fs.readFileSync(resolveFixturePath('cors-test0.xml'))],
    },
  ];

  test('fails to initialize a configuration with multiple wildcard characters', async function () {
    let error;
    try {
      const server = new S3rver({
        configureBuckets: [
          {
            name: 'bucket0',
            configs: [fs.readFileSync(resolveFixturePath('cors-invalid0.xml'))],
          },
        ],
      });
      await server.run();
      await server.close();
    } catch (err) {
      error = err;
    }
    expect(error).to.exist;
    expect(error.message).to.include(' can not have more than one wildcard.');
  });

  test('fails to initialize a configuration with an illegal AllowedMethod', async function () {
    const server = new S3rver({
      configureBuckets: [
        {
          name: 'bucket1',
          configs: [fs.readFileSync(resolveFixturePath('cors-invalid1.xml'))],
        },
      ],
    });
    let error;
    try {
      await server.run();
      await server.close();
    } catch (err) {
      error = err;
    }
    expect(error).to.exist;
    expect(error.message).to.include(
      'Found unsupported HTTP method in CORS config.',
    );
  });

  test('fails to initialize a configuration with missing required fields', async function () {
    const server = new S3rver({
      configureBuckets: [
        {
          name: 'bucket2',
          configs: [fs.readFileSync(resolveFixturePath('cors-invalid2.xml'))],
        },
      ],
    });
    let error;
    try {
      await server.run();
      await server.close();
    } catch (err) {
      error = err;
    }
    expect(error).to.exist;
    expect(error.code).to.equal('MalformedXML');
  });

  test('deletes a CORS configuration in an configured bucket', async function () {
    const server = new S3rver({
      configureBuckets: [buckets[0]],
      allowMismatchedSignatures: true, // TODO: Remove this line by fixing signature mismatch
    });
    const { port } = await server.run();
    const s3Client = createClient(port);
    let error;
    try {
      await s3Client.send(
        new DeleteBucketCorsCommand({ Bucket: buckets[0].name }),
      );
      await s3Client.send(
        new GetBucketCorsCommand({ Bucket: buckets[0].name }),
      );
    } catch (err) {
      error = err;
    } finally {
      s3Client.destroy();
      await server.close();
    }
    expect(error).to.exist;
    expect(error.Code).to.equal('NoSuchCORSConfiguration');
  });

  test('adds the Access-Control-Allow-Origin header for a wildcard origin', async function () {
    const origin = 'http://a-test.example.com';
    const bucket = {
      name: 'foobars',
      configs: [fs.readFileSync('./example/cors.xml')],
    };

    const server = new S3rver({
      configureBuckets: [bucket],
    });
    const { port } = await server.run();
    const s3Client = createClient(port);
    try {
      await s3Client.send(
        new PutObjectCommand({
          Bucket: bucket.name,
          Key: 'image',
          Body: await fs.promises.readFile(resolveFixturePath('image0.jpg')),
          ContentType: 'image/jpeg',
        }),
      );
      const url = await getSignedUrl(
        s3Client,
        new GetObjectCommand({
          Bucket: bucket.name,
          Key: 'image',
        }),
      );
      const res = await fetch(url, {
        headers: { origin },
      });
      expect(res.status).to.equal(200);
      expect(res.headers.get('access-control-allow-origin')).to.equal('*');
    } finally {
      s3Client.destroy();
      await server.close();
    }
  });

  test('adds the Access-Control-Allow-Origin header for a matching origin', async function () {
    const origin = 'http://a-test.example.com';
    const server = new S3rver({
      configureBuckets: [buckets[0]],
    });
    const { port } = await server.run();
    const s3Client = createClient(port);
    try {
      await s3Client.send(
        new PutObjectCommand({
          Bucket: buckets[0].name,
          Key: 'image',
          Body: await fs.promises.readFile(resolveFixturePath('image0.jpg')),
          ContentType: 'image/jpeg',
        }),
      );
      const url = await getSignedUrl(
        s3Client,
        new GetObjectCommand({
          Bucket: buckets[0].name,
          Key: 'image',
        }),
      );
      const res = await fetch(url, {
        headers: { origin },
      });
      expect(res.status).to.equal(200);
      expect(res.headers.get('access-control-allow-origin')).to.equal(origin);
    } finally {
      s3Client.destroy();
      await server.close();
    }
  });

  test('matches an origin to a CORSRule with a wildcard character', async function () {
    const origin = 'http://foo.bar.com';
    const server = new S3rver({
      configureBuckets: [buckets[0]],
    });
    const { port } = await server.run();
    const s3Client = createClient(port);
    try {
      await s3Client.send(
        new PutObjectCommand({
          Bucket: buckets[0].name,
          Key: 'image',
          Body: await fs.promises.readFile(resolveFixturePath('image0.jpg')),
          ContentType: 'image/jpeg',
        }),
      );
      const url = await getSignedUrl(
        s3Client,
        new GetObjectCommand({
          Bucket: buckets[0].name,
          Key: 'image',
        }),
      );
      const res = await fetch(url, {
        headers: { origin },
      });
      expect(res.status).to.equal(200);
      expect(res.headers.get('access-control-allow-origin')).to.equal(origin);
    } finally {
      s3Client.destroy();
      await server.close();
    }
  });

  test('omits the Access-Control-Allow-Origin header for a non-matching origin', async function () {
    const origin = 'http://b-test.example.com';
    const server = new S3rver({
      configureBuckets: [buckets[0]],
    });
    const { port } = await server.run();
    const s3Client = createClient(port);
    try {
      await s3Client.send(
        new PutObjectCommand({
          Bucket: buckets[0].name,
          Key: 'image',
          Body: await fs.promises.readFile(resolveFixturePath('image0.jpg')),
          ContentType: 'image/jpeg',
        }),
      );
      const url = await getSignedUrl(
        s3Client,
        new GetObjectCommand({
          Bucket: buckets[0].name,
          Key: 'image',
        }),
      );
      const res = await fetch(url, {
        headers: { origin },
      });
      expect(res.status).to.equal(200);
      expect(res.headers).to.not.have.property('access-control-allow-origin');
    } finally {
      s3Client.destroy();
      await server.close();
    }
  });

  test('exposes appropriate headers for a range request', async function () {
    const origin = 'http://a-test.example.com';
    const server = new S3rver({
      configureBuckets: [buckets[0]],
    });
    const { port } = await server.run();
    const s3Client = createClient(port);
    try {
      await s3Client.send(
        new PutObjectCommand({
          Bucket: buckets[0].name,
          Key: 'image',
          Body: await fs.promises.readFile(resolveFixturePath('image0.jpg')),
          ContentType: 'image/jpeg',
        }),
      );
      const url = await getSignedUrl(
        s3Client,
        new GetObjectCommand({
          Bucket: buckets[0].name,
          Key: 'image',
        }),
      );
      const res = await fetch(url, {
        headers: { origin, range: 'bytes=0-99' },
      });
      expect(res.status).to.equal(206);
      expect(res.headers.get('access-control-expose-headers')).to.equal(
        'Accept-Ranges, Content-Range',
      );
    } finally {
      s3Client.destroy();
      await server.close();
    }
  });

  test('responds to OPTIONS requests with allowed headers', async function () {
    const origin = 'http://foo.bar.com';
    const server = new S3rver({
      configureBuckets: [buckets[0]],
    });
    const { port } = await server.run();
    const s3Client = createClient(port);
    const url = await getSignedUrl(
      s3Client,
      new GetObjectCommand({
        Bucket: buckets[0].name,
        Key: 'image',
      }),
    );
    try {
      const res = await fetch(url, {
        method: 'OPTIONS',
        headers: {
          origin,
          'Access-Control-Request-Method': 'GET',
          'Access-Control-Request-Headers': 'Range, Authorization',
        },
      });
      expect(res.status).to.equal(200);
      expect(res.headers.get('access-control-allow-origin')).to.equal('*');
      expect(res.headers.get('access-control-allow-headers')).to.equal(
        'range, authorization',
      );
    } finally {
      s3Client.destroy();
      await server.close();
    }
  });

  test('responds to OPTIONS requests with a Forbidden response', async function () {
    const origin = 'http://a-test.example.com';
    const server = new S3rver({
      configureBuckets: [buckets[0]],
    });
    const { port } = await server.run();
    const s3Client = createClient(port);
    const url = await getSignedUrl(
      s3Client,
      new GetObjectCommand({
        Bucket: buckets[0].name,
        Key: 'image',
      }),
    );
    let res;
    try {
      res = await fetch(url, {
        method: 'OPTIONS',
        headers: {
          origin,
          'Access-Control-Request-Method': 'GET',
          'Access-Control-Request-Headers': 'Range, Authorization',
        },
      });
    } finally {
      s3Client.destroy();
      await server.close();
    }
    expect(res.status).to.equal(403);
  });

  test('responds to OPTIONS requests with a Forbidden response when CORS is disabled', async function () {
    const origin = 'http://foo.bar.com';
    const bucket = { name: 'foobar' };
    const server = new S3rver({
      configureBuckets: [bucket],
    });
    const { port } = await server.run();
    const s3Client = createClient(port);
    const url = await getSignedUrl(
      s3Client,
      new GetObjectCommand({
        Bucket: bucket.name,
        Key: 'image',
      }),
    );
    let res;
    try {
      res = await fetch(url, {
        method: 'OPTIONS',
        headers: {
          origin,
          'Access-Control-Request-Method': 'GET',
        },
      });
    } finally {
      s3Client.destroy();
      await server.close();
    }
    expect(res.status).to.equal(403);
  });

  test('responds correctly to OPTIONS requests that dont specify access-control-request-headers', async function () {
    const origin = 'http://a-test.example.com';
    const server = new S3rver({
      configureBuckets: [buckets[0]],
    });
    const { port } = await server.run();
    const s3Client = createClient(port);
    const url = await getSignedUrl(
      s3Client,
      new GetObjectCommand({
        Bucket: buckets[0].name,
        Key: 'image',
      }),
    );
    try {
      await fetch(url, {
        method: 'OPTIONS',
        headers: {
          origin,
          'Access-Control-Request-Method': 'GET',
          // No Access-Control-Request-Headers specified...
        },
      });
    } finally {
      s3Client.destroy();
      await server.close();
    }
  });
});
