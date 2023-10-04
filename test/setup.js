/* eslint-env mocha */
'use strict';

import chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import os from 'os';
import path from 'path';
import S3rver from '..';
import { resetTmpDir, instances } from './helpers';

chai.use(chaiAsPromised);

// Change the default options to be more test-friendly
const tmpDir = path.join(os.tmpdir(), 's3rver_test');
S3rver.defaultOptions.port = 0;
S3rver.defaultOptions.silent = true;
S3rver.defaultOptions.directory = tmpDir;

beforeEach(resetTmpDir);

afterEach(async function () {
  await Promise.all(
    [...instances].map(async (instance) => {
      try {
        await instance.close();
      } catch (err) {
        console.warn(err);
      }
    }),
  );
  instances.clear();
});
