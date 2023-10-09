'use strict';

class S3Bucket {
  name: string;
  creationDate: any;

  constructor(name, creationDate) {
    this.name = name;
    this.creationDate = creationDate;
  }
}
export default S3Bucket;
