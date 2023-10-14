'use strict';

import Koa from 'koa';
import koaLogger from 'koa-logger';
import pkg from 'winston';
const { createLogger, format, transports } = pkg;

/**
 * Creates and assigns a Winston logger instance to an app and returns
 */
export default function (app: Koa, verbose: boolean) {
  const logger = createLogger({
    level: 'debug',
    format: format.combine(format.colorize(), format.splat(), format.simple()),
    silent: !verbose,
    transports: [new transports.Console()],
    exitOnError: false,
  });
  app.context.logger = logger;

  return koaLogger((message, args) => {
    if (args.length === 6) {
      // only log responses
      logger.info(message.slice(16));
    }
  });
}
