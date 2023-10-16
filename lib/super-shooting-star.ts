'use strict';

import Koa, { DefaultState } from 'koa';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { format, promisify } from 'util';
import loggerMiddleware from './middleware/logger';
import vhostMiddleware from './middleware/vhost';
import xmlifyMiddleware from './middleware/xmlify';
import { loadConfigModel } from './models/config';
import S3Error from './models/error';
import FilesystemStore from './stores/filesystem';
import router from './routes';
import { builderFactory } from './utils';
import { AddressInfo } from 'net';
import { EventEmitter } from 'node:events';
import {
  createLogger,
  format as loggerFormat,
  Logger,
  transports,
} from 'winston';

export type Options = {
  address: string;
  port: number;
  verbose: boolean;
  serviceEndpoint: string;
  useResetOnClose: boolean;
  allowMismatchedSignatures: boolean;
  useVhostBuckets: boolean;
  buckets: { name: string; configs?: any }[];
  store?: FilesystemStore;
  emitter?: EventEmitter;
};

export const defaultOptions: Options = {
  address: '0.0.0.0',
  port: 0,
  verbose: false,
  buckets: [],
  serviceEndpoint: 'amazonaws.com',
  useResetOnClose: false,
  allowMismatchedSignatures: false,
  useVhostBuckets: true,
};

/**
 * Koa context.onerror handler modified to write a XML-formatted response body
 * @param {Error} err
 */
function onerror(err: Error) {
  // don't do anything if there is no error.
  // this allows you to pass `this.onerror`
  // to node-style callbacks.
  if (err == null) return;

  if (!(err instanceof Error))
    err = new Error(format('non-error thrown: %j', err));

  let headerSent = false;
  if (this.headerSent || !this.writable) {
    headerSent = (err as any).headerSent = true;
  }

  // delegate
  this.app.emit('error', err, this);

  // nothing we can do here other
  // than delegate to the app-level
  // handler and log.
  if (headerSent) {
    return;
  }

  const { res } = this;

  let s3Error: S3Error;
  if (!(err instanceof S3Error)) {
    s3Error = S3Error.fromError(err);
  } else {
    s3Error = err;
  }

  // first unset all headers
  res
    .getHeaderNames()
    .filter((name) => !name.match(/^access-control-|vary|x-amz-/i))
    .forEach((name) => res.removeHeader(name));

  // (the presence of x-amz-error-* headers needs additional research)
  // this.set(err.headers);

  // force application/xml
  this.type = 'application/xml';

  // respond
  const msg = s3Error.toXML();
  this.status = s3Error.status;
  this.length = Buffer.byteLength(msg);
  res.end(msg);
}

const configureBuckets = async (
  store: any,
  buckets: { name: string; configs?: any }[],
  logger: Logger,
) => {
  return Promise.all(
    buckets.map(async (bucket) => {
      const bucketExists = !!(await store.getBucket(bucket.name));
      if (bucketExists) {
        logger.warn('the bucket "%s" already exists', bucket.name);
      }

      await store.putBucket(bucket.name);
      for (const configXml of bucket.configs || []) {
        const config = loadConfigModel(configXml.toString());
        const existingConfig = await store.getSubresource(
          bucket.name,
          undefined,
          config.type,
        );
        await store.putSubresource(bucket.name, undefined, config);
        if (existingConfig) {
          logger.warn(
            'replaced %s config for bucket "%s"',
            config.type,
            bucket.name,
          );
        }
      }
    }),
  );
};

const build = (
  options: Options,
): (() => Promise<{ address: AddressInfo; close: () => void }>) => {
  let {
    verbose,
    serviceEndpoint,
    useResetOnClose,
    allowMismatchedSignatures,
    useVhostBuckets,
    buckets,
    store,
    emitter,
    port,
  } = options;

  if (store === undefined) {
    const rs = Math.random().toString(32).substring(2);
    store = new FilesystemStore(path.join(os.tmpdir(), 'sss', rs));
  }

  const logger = createLogger({
    level: 'debug',
    format: loggerFormat.combine(
      loggerFormat.colorize(),
      loggerFormat.splat(),
      loggerFormat.simple(),
    ),
    silent: !verbose,
    transports: [new transports.Console()],
    exitOnError: false,
  });

  // Log all requests
  const app = new Koa<DefaultState, { logger: Logger }>()
    .use<
      {},
      {
        store: FilesystemStore;
        mountPath: string;
        emitter?: EventEmitter;
        allowMismatchedSignatures: boolean;
      }
    >(async (ctx, next) => {
      ctx.store = store;
      ctx.mountPath = ctx.mountPath || (ctx.req as any).baseUrl;
      ctx.emitter = emitter;
      ctx.allowMismatchedSignatures = allowMismatchedSignatures;
      return next();
    })
    .use(xmlifyMiddleware())
    .use(vhostMiddleware({ serviceEndpoint, vhostBuckets: useVhostBuckets }))
    .use(loggerMiddleware(logger))
    .use(router.routes());

  app.context.logger = logger;
  app.context.onerror = onerror;

  return async (): Promise<{
    address: AddressInfo;
    close: () => Promise<void>;
  }> => {
    await configureBuckets(store, buckets, logger);

    const server = http.createServer(app.callback());
    server.on('close', () => {
      logger.exceptions.unhandle();
      logger.close();
      if (useResetOnClose) {
        store.reset();
      }
    });

    await new Promise((resolve, reject) =>
      server.listen(port, () => resolve({})),
    );
    const address = server.address() as AddressInfo;

    const close = async () => {
      server.closeAllConnections();
      return promisify(server.close.bind(server))();
    };
    return { address, close };
  };
};

export const Builder = builderFactory<
  Options,
  () => Promise<{ address: AddressInfo; close: () => void }>
>(build);
export const DefaultBuilder = new Builder().with(defaultOptions);
