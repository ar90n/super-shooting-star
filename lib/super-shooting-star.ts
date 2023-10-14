'use strict';

import { XMLBuilder } from 'fast-xml-parser';
import Koa, { EventEmitter } from 'koa';
import { isPlainObject } from 'lodash-es';
import he from 'he';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { format, promisify } from 'util';
import loggerMiddleware from './middleware/logger';
import vhostMiddleware from './middleware/vhost';
import { getConfigModel } from './models/config';
import S3Error from './models/error';
import FilesystemStore from './stores/filesystem';
import router from './routes';
import { getXmlRootTag, builderFactory } from './utils';
import { AddressInfo } from 'net';

const buildXmlifyMiddleware = (builder: XMLBuilder) => {
  return async (ctx, next) => {
    await next();
    if (isPlainObject(ctx.body)) {
      ctx.type = 'application/xml';
      ctx.body =
        '<?xml version="1.0" encoding="UTF-8"?>\n' + builder.build(ctx.body);
    }
  };
};

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

const configureBuckets = async (
  store: any,
  buckets: { name: string; configs?: any }[],
) => {
  return Promise.all(
    buckets.map(async (bucket) => {
      const bucketExists = !!(await store.getBucket(bucket.name));
      if (bucketExists) {
        //   this.logger.warn('the bucket "%s" already exists', bucket.name);
      }

      await store.putBucket(bucket.name);
      for (const configXml of bucket.configs || []) {
        const xml = configXml.toString();

        let Model;
        switch (getXmlRootTag(xml)) {
          case 'CORSConfiguration':
            Model = getConfigModel('cors');
            break;
          case 'WebsiteConfiguration':
            Model = getConfigModel('website');
            break;
        }
        if (!Model) {
          throw new Error(
            'error reading bucket config: unsupported configuration type',
          );
        }
        const config = Model.validate(xml);

        const existingConfig = await store.getSubresource(
          bucket.name,
          undefined,
          config.type,
        );
        await store.putSubresource(bucket.name, undefined, config);
        if (existingConfig) {
          //   this.logger.warn(
          //     'replaced %s config for bucket "%s"',
          //     replacedConfigs.join(),
          //     bucket.name,
          //   );
        }
      }
    }),
  );
};

const build = (
  options: Options,
): (() => Promise<{ address: AddressInfo; close: () => void }>) => {
  const app = new Koa();
  app.context.onerror = onerror;

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

  // Log all requests
  app.use(loggerMiddleware(app, verbose));
  if (store === undefined) {
    const rs = Math.random().toString(32).substring(2);
    store = new FilesystemStore(path.join(os.tmpdir(), 'sss', rs));
  }
  app.context.store = store;
  app.context.emitter = emitter;
  app.context.allowMismatchedSignatures = allowMismatchedSignatures;

  // encode object responses as XML
  const builder = new XMLBuilder({
    attributesGroupName: '@',
    tagValueProcessor: (tagName, a) => {
      return he
        .escape(a.toString(), { useNamedReferences: true })
        .replace(/&quot;/g, '"');
    },
  });
  app.use(buildXmlifyMiddleware(builder));

  // Express mount interop
  app.use((ctx, next) => {
    ctx.mountPath = ctx.mountPath || (ctx.req as any).baseUrl;
    return next();
  });

  app.use(vhostMiddleware({ serviceEndpoint, vhostBuckets: useVhostBuckets }));
  app.use(router.routes());

  return async (): Promise<{
    address: AddressInfo;
    close: () => Promise<void>;
  }> => {
    await configureBuckets(store, buckets);

    const server = http.createServer(app.callback());
    server.on('close', () => {
      app.context.logger.exceptions.unhandle();
      app.context.logger.close();
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

/**
 * Koa context.onerror handler modified to write a XML-formatted response body
 * @param {Error} err
 */
function onerror(err) {
  // don't do anything if there is no error.
  // this allows you to pass `this.onerror`
  // to node-style callbacks.
  if (err == null) return;

  if (!(err instanceof Error))
    err = new Error(format('non-error thrown: %j', err));

  let headerSent = false;
  if (this.headerSent || !this.writable) {
    headerSent = err.headerSent = true;
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

  if (!(err instanceof S3Error)) {
    err = S3Error.fromError(err);
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
  const msg = err.toXML();
  this.status = err.status;
  this.length = Buffer.byteLength(msg);
  res.end(msg);
}
