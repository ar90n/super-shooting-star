'use strict';

import { createHmac } from 'crypto';
import { mapKeys, pickBy } from 'lodash-es';
import AWSAccount from '../models/account';
import S3Error from '../models/error';
import { RESPONSE_HEADERS } from './response-header-override';
import * as v4 from '../signature/v4';
import { encodeURIComponentRFC3986, parseDate } from '../utils';

const SUBRESOURCES = {
  acl: 1,
  accelerate: 1,
  analytics: 1,
  cors: 1,
  lifecycle: 1,
  delete: 1,
  inventory: 1,
  location: 1,
  logging: 1,
  metrics: 1,
  notification: 1,
  partNumber: 1,
  policy: 1,
  requestPayment: 1,
  replication: 1,
  restore: 1,
  tagging: 1,
  torrent: 1,
  uploadId: 1,
  uploads: 1,
  versionId: 1,
  versioning: 1,
  versions: 1,
  website: 1,
};

/**
 * Middleware that verifies signed HTTP requests
 *
 * This also processes request and response headers specified via query params.
 *
 * {@link https://docs.aws.amazon.com/AmazonS3/latest/dev/RESTAuthentication.html}
 */
export default () =>
  async function authentication(ctx, next) {
    if (ctx.state.website) {
      // skip for static website requests
      return next();
    }

    if (ctx.method === 'OPTIONS') {
      // skip for CORS OPTION requests
      return next();
    }

    const amzQueryHeaders = pickBy(
      mapKeys(ctx.query, (value, key) => key.toLowerCase()),
      (value, key) => key.startsWith('x-amz-'),
    );
    // x-amz-* values specified in query params take precedence over those in the headers
    Object.assign(ctx.headers, amzQueryHeaders);

    const mechanisms = {
      header: 'authorization' in ctx.headers,
      queryV4: 'X-Amz-Algorithm' in ctx.query,
    };

    const mechanismCount = Object.values(mechanisms).filter(Boolean).length;
    if (mechanismCount === 0) {
      return next();
    }
    if (mechanismCount !== 1) {
      throw new S3Error(
        'InvalidArgument',
        'Only one auth mechanism allowed; only the X-Amz-Algorithm query ' +
          'parameter, Signature query string parameter or the Authorization ' +
          'header should be specified',
        {
          ArgumentName: 'Authorization',
          ArgumentValue: ctx.get('Authorization'),
        },
      );
    }

    let canonicalizedResource = ctx.mountPath || '';
    if (ctx.params.bucket) {
      // the following behavior is derived from the behavior of the JS aws-sdk
      if (ctx.state.vhost) {
        canonicalizedResource = '/' + ctx.params.bucket + canonicalizedResource;
      } else {
        canonicalizedResource += '/' + ctx.params.bucket;
      }
      if (ctx.params.key) {
        canonicalizedResource += '/' + ctx.params.key;
      }
    } else {
      canonicalizedResource += '/';
    }
    canonicalizedResource = canonicalizedResource
      .split('/')
      .map(encodeURIComponentRFC3986)
      .join('/');

    // begin parsing for each part of the signature algorithm and the rest of the canonical request
    const request: any = mechanisms.header
      ? parseHeader(ctx.headers)
      : mechanisms.queryV4
      ? v4.parseQuery(ctx.query)
      : undefined;

    const canonicalizedQueryString = Object.entries(ctx.query)
      .filter(([param]) => {
        if (mechanisms.queryV4 && param === 'X-Amz-Signature') {
          return false;
        }
        return (
          request.signature.version !== 2 ||
          SUBRESOURCES[param] ||
          RESPONSE_HEADERS[param]
        );
      })
      .map(
        ([param, value]) => [param, value].map(encodeURIComponent).join('='), // v4 signing requires the = be present even when there's no value
      )
      .sort()
      .join('&');

    const canonicalizedAmzHeaders = Object.keys(ctx.headers)
      .filter((headerName) => headerName.startsWith('x-amz-'))
      .sort()
      .map(
        (headerName) =>
          `${headerName}:${ctx.get(headerName).replace(/ +/g, ' ')}`,
      );

    const canonicalRequest = {
      method:
        ctx.method === 'OPTIONS'
          ? ctx.get('Access-Control-Request-Method')
          : ctx.method,
      contentMD5: ctx.get('Content-MD5'),
      contentType: ctx.get('Content-Type'),
      headers: ctx.headers,
      timestamp: undefined,
      uri: canonicalizedResource,
      querystring: canonicalizedQueryString,
      amzHeaders: canonicalizedAmzHeaders,
    };

    switch (request.signature.version) {
      case 4:
        canonicalRequest.timestamp = request.time;
        break;
    }

    const account = AWSAccount.registry.get(request.accessKeyId);
    if (!account) {
      throw new S3Error(
        'InvalidAccessKeyId',
        'The AWS Access Key Id you provided does not exist in our records.',
        { AWSAccessKeyId: request.accessKeyId },
      );
    }

    if (request.signature.version === 4) {
      request.stringToSign = v4.getStringToSign(canonicalRequest, request);
      request.signingKey = v4.getSigningKey(
        account.accessKeys.get(request.accessKeyId),
        request.credential.date,
        request.credential.region,
        request.credential.service,
      );
    }
    const calculatedSignature = createHmac(
      request.signature.algorithm,
      request.signingKey,
    )
      .update(request.stringToSign, 'utf8')
      .digest(request.signature.encoding);

    if (request.signatureProvided === calculatedSignature) {
      ctx.state.account = account;
    }

    if (!ctx.state.account) {
      if (ctx.allowMismatchedSignatures) {
        ctx.state.account = account;
      } else {
        throw new S3Error(
          'SignatureDoesNotMatch',
          'The request signature we calculated does not match the signature ' +
            'you provided. Check your key and signing method.',
          {
            AWSAccessKeyId: request.accessKeyId,
            StringToSign: request.stringToSign,
            StringToSignBytes: Buffer.from(request.stringToSign)
              .toString('hex')
              .match(/../g)
              .join(' '),
          },
        );
      }
    }

    return next();
  };

function parseHeader(headers) {
  const request = {
    signature: undefined,
    accessKeyId: undefined,
    time: headers['x-amz-date'] || headers.date,
  };

  const [algorithm] = headers.authorization.split(' ');
  switch (algorithm.toUpperCase()) {
    case 'AWS4-HMAC-SHA256':
      request.signature = {
        version: 4,
        algorithm: 'sha256',
        encoding: 'hex',
      };
      break;
    default:
      throw new S3Error('InvalidArgument', 'Unsupported Authorization Type', {
        ArgumentName: 'Authorization',
        ArgumentValue: headers.authorization,
      });
  }

  switch (request.signature.version) {
    case 4:
      Object.assign(request, v4.parseHeader(headers));
      break;
  }

  const serverTime = new Date();
  const requestTime = parseDate(request.time);
  if (isNaN(requestTime.getTime())) {
    throw new S3Error(
      'AccessDenied',
      'AWS authentication requires a valid Date or x-amz-date header',
    );
  }

  if (Math.abs(serverTime.getTime() - requestTime.getTime()) > 900000) {
    // 15 minutes
    throw new S3Error(
      'RequestTimeTooSkewed',
      'The difference between the request time and the current time is too large.',
      {
        RequestTime: request.time,
        ServerTime: serverTime.toISOString().replace(/\.\d+/, ''),
      },
    );
  }
  return request;
}
