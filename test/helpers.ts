'use strict';

import { resolve } from 'import-meta-resolve';
import {
  S3Client,
  PutObjectCommand,
  PutObjectAclCommandInput,
} from '@aws-sdk/client-s3';
import pkg from 'aws4';
import crypto from 'crypto';
import { XMLParser } from 'fast-xml-parser';
import fs from 'fs';
import { times } from 'lodash-es';
import os from 'os';
import path from 'path';
import pMap from 'p-map';
import S3rver from '../lib/s3rver';
const { RequestSigner } = pkg;

const tmpDir = path.join(os.tmpdir(), 's3rver_test');

export const instances: Set<S3rver> = new Set();

export const resetTmpDir = function resetTmpDir() {
  try {
    fs.rmSync(tmpDir, { recursive: true });
  } catch (err) {
    /* directory didn't exist */
  }
  try {
    fs.mkdirSync(tmpDir, { recursive: true });
  } catch (err) {
    if (err.code !== 'EEXIST') {
      throw err;
    }
  }
};

export const generateTestObjects = function generateTestObjects(
  s3Client,
  bucket,
  amount,
) {
  const padding = amount.toString().length;
  const objects = times(amount, (i) => ({
    Bucket: bucket,
    Key: 'key' + i.toString().padStart(padding, '0'),
    Body: 'Hello!',
  }));

  return pMap(
    objects,
    (object: PutObjectAclCommandInput) =>
      s3Client.send(new PutObjectCommand(object)),
    {
      concurrency: 100,
    },
  );
};

export const md5 = (data) =>
  crypto.createHash('md5').update(data).digest('hex');

export const parseXml = (data) => {
  const xmlParser = new XMLParser();

  return xmlParser.parse(data);
};

export const createClient = (port: number) => {
  const s3Client = new S3Client({
    credentials: {
      accessKeyId: 'S3RVER',
      secretAccessKey: 'S3RVER',
    },
    endpoint: `http://localhost:${port}`,
    forcePathStyle: true,
    region: 'localhost',
  });

  return s3Client;
};

export const createServerAndClient2 = async function createServerAndClient2(
  options,
) {
  const s3rver = new S3rver(options);
  const { port } = await s3rver.run();
  instances.add(s3rver);

  const s3Client = createClient(port);
  return { s3rver, s3Client };
};

export const StreamingRequestSigner = class extends RequestSigner {
  previousSignature: any;
  chunkData: any;
  prepareRequest() {
    this.request.headers['X-Amz-Content-Sha256'] =
      'STREAMING-AWS4-HMAC-SHA256-PAYLOAD';
    return super.prepareRequest();
  }

  signature() {
    this.previousSignature = super.signature();
    this.chunkData = undefined;
    return this.previousSignature;
  }

  signChunk(chunkData) {
    this.chunkData = chunkData;
    const chunkLengthHex = chunkData.length.toString(16);
    return `${chunkLengthHex};chunk-signature=${this.signature()}`;
  }

  stringToSign() {
    const hash = (string, encoding) =>
      crypto.createHash('sha256').update(string, 'utf8').digest(encoding);

    return this.chunkData === undefined
      ? super.stringToSign()
      : [
          'AWS4-HMAC-SHA256-PAYLOAD',
          this.getDateTime(),
          this.credentialString(),
          this.previousSignature,
          hash('', 'hex'),
          hash(this.chunkData, 'hex'),
        ].join('\n');
  }
};

export const getEndpointHref = async (s3Client: S3Client) => {
  const { hostname, port, protocol, path } = await s3Client.config.endpoint();
  return `${protocol}//${hostname}:${port}${path}`;
};

export const resolveFixturePath = (fixtureName: string): string => {
  let resolved = resolve(`./fixtures/${fixtureName}`, import.meta.url);
  resolved = resolved.replace('file://', ''); // remove protocol
  resolved = resolved.replace(/^\/([A-Z]):/, ''); // remove driver letter
  return resolved;
};
