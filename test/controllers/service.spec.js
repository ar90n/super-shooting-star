'use strict';

import { expect } from 'chai';
import { ListBucketsCommand } from '@aws-sdk/client-s3';
import { zip } from 'lodash-es';
import moment from 'moment';
import { createServerAndClient2 } from '../helpers';

describe('Operations on the Service', () => {
  describe('GET Service', () => {
    const buckets = [
      { name: 'bucket1' },
      { name: 'bucket2' },
      { name: 'bucket3' },
      { name: 'bucket4' },
      { name: 'bucket5' },
      { name: 'bucket6' },
    ];

    it('returns a list of buckets', async function () {
      const { s3Client } = await createServerAndClient2({
        configureBuckets: buckets,
      });
      const data = await s3Client.send(new ListBucketsCommand({}));
      data.Buckets.sort((lhs, rhs) => lhs.Name > rhs.Name);
      for (const [bucket, config] of zip(data.Buckets, buckets)) {
        expect(bucket.Name).to.equal(config.name);
        expect(moment(bucket.CreationDate).isValid()).to.be.true;
      }
    });
  });
});
