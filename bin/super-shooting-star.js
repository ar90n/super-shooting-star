#!/usr/bin/env node
'use strict';
import fs from 'fs';
import { Command } from 'commander';
import pkg from '../package.json';
import { DefaultBuilder, defaultOptions } from '../dist/super-shooting-star';

function ensureDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

// manually parse [config...] arguments for --create-bucket
function parseConfigureBucket(bucketName, memo = []) {
  let idx = 0;
  do {
    idx = program.rawArgs.indexOf('--configure-bucket', idx) + 1;
  } while (program.rawArgs[idx] !== bucketName);
  idx++;

  const bucketConfigs = [];
  while (
    idx < program.rawArgs.length &&
    !program.rawArgs[idx].startsWith('-')
  ) {
    bucketConfigs.push(program.rawArgs[idx++]);
  }
  memo.push({
    name: bucketName,
    configs: bucketConfigs.map((config) => fs.readFileSync(config)),
  });
  return memo;
}

const program = new Command();
program
  .usage('-d <path> [options]')
  .requiredOption('-d, --directory <path>', 'Data directory', ensureDirectory)
  .option(
    '-a, --address <value>',
    'Hostname or IP to bind to',
    defaultOptions.address,
  )
  .option(
    '-p, --port <n>',
    'Port of the http server',
    defaultOptions.port.toString(),
  )
  .option('-s, --silent', 'Suppress log messages', defaultOptions.silent)
  .option(
    '--key <path>',
    'Path to private key file for running with TLS',
    fs.readFileSync,
  )
  .option(
    '--cert <path>',
    'Path to certificate file for running with TLS',
    fs.readFileSync,
  )
  .option(
    '--service-endpoint <address>',
    'Overrides the AWS service root for subdomain-style access',
    defaultOptions.serviceEndpoint,
  )
  .option(
    '--allow-mismatched-signatures',
    'Prevent SignatureDoesNotMatch errors for all well-formed signatures',
  )
  .option('--no-vhost-buckets', 'Disables vhost-style access for all buckets')
  .option(
    '--configure-bucket <name> [configs...]',
    'Bucket name and configuration files for creating and configuring a bucket at startup',
    parseConfigureBucket,
  )
  .version(pkg.version, '-v, --version');

// NOTE: commander doesn't support repeated variadic options,
// we must manually parse this option
program.options.find((option) =>
  option.is('--configure-bucket'),
).variadic = false;

program.on('--help', () => {
  console.log('');
  console.log('Examples:');
  console.log(
    '  $ super-shooting-star -d /tmp/super-shooting-star -a 0.0.0.0 -p 0',
  );
  console.log(
    '  $ super-shooting-star -d /tmp/super-shooting-star --configure-bucket test-bucket ./cors.xml ./website.xml',
  );
});

program.action(async ({ configureBucket, ...opts }) => {
  opts.configureBuckets = configureBucket;
  const run = DefaultBuilder.with(opts).build();
  const { address } = await run();
  console.log();
  console.log('S3rver listening on %s:%d', address.address, address.port);
});

program.parseAsync(process.argv).catch((err) => {
  console.error(err);
  process.exit(1);
});
