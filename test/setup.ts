/* eslint-env mocha */
'use strict';

import chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import os from 'os';
import path from 'path';
import S3rver, { defaultOptions } from '../lib/s3rver.js';
import { beforeEach, afterEach } from '@jest/globals';
import { resetTmpDir, instances } from './helpers';

chai.use(chaiAsPromised);

// Change the default options to be more test-friendly
const tmpDir = path.join(os.tmpdir(), 's3rver_test');
defaultOptions.port = 0;
defaultOptions.silent = true;
defaultOptions.directory = tmpDir;

beforeEach(resetTmpDir);

afterEach(async function () {
  await Promise.all(
    [...instances].map(async (instance) => {
      try {
        instance.close();
      } catch (err) {
        console.warn(err);
      }
    }),
  );
  instances.clear();
});
