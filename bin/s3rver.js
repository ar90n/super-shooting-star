#!/usr/bin/env node'use strict';
import cli from '../lib/cli';

cli.parseAsync(process.argv).catch((err) => {
  console.error(err);
  process.exit(1);
});
