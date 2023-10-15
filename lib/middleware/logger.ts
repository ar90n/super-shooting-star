'use strict';

import Koa from 'koa';
import koaLogger from 'koa-logger';
import { Logger } from 'winston';

/**
 * Creates and assigns a Winston logger instance to an app and returns
 */
export default function (logger: Logger) {
  return koaLogger((message, args) => {
    if (args.length === 6) {
      // only log responses
      logger.info(message.slice(16));
    }
  });
}
