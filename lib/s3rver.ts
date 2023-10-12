'use strict';

import { XMLBuilder } from 'fast-xml-parser';
import Koa from 'koa';
import { defaults, isPlainObject } from 'lodash-es';
import he from 'he';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { callbackify, format, promisify } from 'util';
import loggerMiddleware from './middleware/logger';
import vhostMiddleware from './middleware/vhost';
import { getConfigModel } from './models/config';
import S3Error from './models/error';
import FilesystemStore from './stores/filesystem';
import router from './routes';
import { getXmlRootTag } from './utils';

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

class S3rver extends Koa {
  static defaultOptions: any = {
    address: 'localhost',
    port: 4568,
    key: undefined,
    cert: undefined,
    silent: false,
    serviceEndpoint: 'amazonaws.com',
    directory: path.join(os.tmpdir(), 's3rver'),
    resetOnClose: false,
    allowMismatchedSignatures: false,
    vhostBuckets: true,
    configureBuckets: [],
  };
  serverOptions: any;
  _configureBuckets: any;
  silent: any;
  resetOnClose: any;
  allowMismatchedSignatures: any;
  store: any;
  logger: any;
  httpServer: http.Server<
    typeof http.IncomingMessage,
    typeof http.ServerResponse
  >;

  constructor(options) {
    super();

    this.context.onerror = onerror;
    const {
      silent,
      serviceEndpoint,
      directory,
      resetOnClose,
      allowMismatchedSignatures,
      vhostBuckets,
      configureBuckets,
      ...serverOptions
    } = defaults({}, options, S3rver.defaultOptions);
    this.serverOptions = serverOptions;
    this._configureBuckets = configureBuckets;
    this.silent = silent;
    this.resetOnClose = resetOnClose;
    this.allowMismatchedSignatures = allowMismatchedSignatures;
    this.store = this.context.store = new FilesystemStore(directory);

    // Log all requests
    this.use(loggerMiddleware(this, silent));

    try {
      // encode object responses as XML
      const builder = new XMLBuilder({
        attributesGroupName: '@',
        tagValueProcessor: (tagName, a) => {
          return he
            .escape(a.toString(), { useNamedReferences: true })
            .replace(/&quot;/g, '"');
        },
      });
      this.use(buildXmlifyMiddleware(builder));

      // Express mount interop
      this.use((ctx, next) => {
        ctx.mountPath = ctx.mountPath || (ctx.req as any).baseUrl;
        return next();
      });

      this.use(vhostMiddleware({ serviceEndpoint, vhostBuckets }));
      this.use(router.routes());
    } catch (err) {
      this.logger.exceptions.unhandle();
      this.logger.close();
      throw err;
    }
  }

  /**
   * Convenience method for configurating a set of buckets without going through
   * S3's API. Useful for quickly provisioning buckets before starting up the
   * server.
   */
  async configureBuckets() {
    return Promise.all(
      this._configureBuckets.map(async (bucket) => {
        const bucketExists = !!(await this.store.getBucket(bucket.name));
        const replacedConfigs = [];
        await this.store.putBucket(bucket.name);
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
          const existingConfig = await this.store.getSubresource(
            bucket.name,
            undefined,
            config.type,
          );
          await this.store.putSubresource(bucket.name, undefined, config);
          if (existingConfig) {
            replacedConfigs.push(config.type);
          }
        }
        // warn if we're updating a bucket that already exists
        if (replacedConfigs.length) {
          this.logger.warn(
            'replaced %s config for bucket "%s"',
            replacedConfigs.join(),
            bucket.name,
          );
        } else if (bucketExists) {
          this.logger.warn('the bucket "%s" already exists', bucket.name);
        }
      }),
    );
  }

  /**
   * Resets all buckets and configurations supported by the configured store.
   */
  reset() {
    this.store.reset();
  }

  /**
   * Starts the HTTP server.
   *
   * @returns {Promise} The promice of address of service.
   */
  async run(): Promise<any> {
    await this.configureBuckets();

    const { address, port, ...listenOptions } = this.serverOptions;
    this.httpServer = await this._listen(port, address, listenOptions);
    return this.httpServer.address();
  }

  async _listen(
    ...args
  ): Promise<
    http.Server<typeof http.IncomingMessage, typeof http.ServerResponse>
  > {
    const { key, cert, pfx } = this.serverOptions;
    const server =
      (key && cert) || pfx
        ? https.createServer(this.serverOptions, this.callback())
        : http.createServer(this.callback()); // Node < 8.12 does not support http.createServer([options])

    server.on('close', () => {
      this.logger.exceptions.unhandle();
      this.logger.close();
      if (this.resetOnClose) {
        this.reset();
      }
    });

    return new Promise((resolve, reject) =>
      server.listen(...args, () => resolve(server)),
    );
  }

  /**
   * Proxies httpServer.close().
   *
   * @returns {this|Promise}
   */
  close() {
    if (!this.httpServer) {
      const err = new Error('Not running');
      return Promise.reject(err);
    }

    this.httpServer.closeAllConnections();
    return promisify(this.httpServer.close.bind(this.httpServer))();
  }

  getMiddleware() {
    return this.callback();
  }
}

export default S3rver;

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
