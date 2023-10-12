class AWSAccount {
  static registry: Map<string, AWSAccount>;

  readonly id: number;
  accessKeys: Map<string, string>;

  constructor(accountId: number, public readonly displayName: string) {
    this.id = accountId;
    this.accessKeys = new Map();
  }

  createKeyPair(accessKeyId: string, secretAccessKey: string) {
    AWSAccount.registry.set(accessKeyId, this);
    this.accessKeys.set(accessKeyId, secretAccessKey);
  }

  revokeAccessKey(accessKeyId: string) {
    AWSAccount.registry.delete(accessKeyId);
    this.accessKeys.delete(accessKeyId);
  }
}
AWSAccount.registry = new Map();

export default AWSAccount;

// Hardcoded dummy user used for authenticated requests
const DUMMY_ACCOUNT = new AWSAccount(123456789000, 'S3rver');
DUMMY_ACCOUNT.createKeyPair('S3RVER', 'S3RVER');

export { DUMMY_ACCOUNT };
