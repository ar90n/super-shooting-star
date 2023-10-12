'use strict';

class S3Bucket {
  constructor(
    public readonly name: string,
    public readonly creationDate: Date,
  ) {}
}
export default S3Bucket;
