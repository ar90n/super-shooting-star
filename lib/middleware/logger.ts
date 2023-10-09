'use strict';

import koaLogger from 'koa-logger';
import pkg from 'winston';
const { createLogger, format, transports } = pkg;

/**
 * Creates and assigns a Winston logger instance to an app and returns
 */
export default function (app, silent) {
  const logger = createLogger({
    transports: [
      new transports.Console({
        level: 'debug',
        format: format.combine(
          format.colorize(),
          format.splat(),
          format.simple(),
        ),
        silent,
      }),
    ],
    exitOnError: false,
  });
  app.logger = app.context.logger = logger;

  return koaLogger((message, args) => {
    if (args.length === 6) {
      // only log responses
      logger.info(message.slice(16));
    }
  });
}
