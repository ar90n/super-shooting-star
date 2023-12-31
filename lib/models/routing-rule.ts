'use strict';

class RoutingRule {
  condition: any;
  redirect: any;
  statusCode: number;

  constructor(config: any) {
    this.condition = config.Condition;
    this.redirect = config.Redirect;
    this.statusCode = (this.redirect && this.redirect.HttpRedirectCode) || 301;
  }

  getRedirectLocation(key: string, defaults: any): string {
    let redirectKey = key;

    if (this.redirect.ReplaceKeyPrefixWith) {
      redirectKey = key.replace(
        (this.condition && this.condition.KeyPrefixEquals) || /^/,
        this.redirect.ReplaceKeyPrefixWith,
      );
    } else if (this.redirect.ReplaceKeyWith) {
      redirectKey = this.redirect.ReplaceKeyWith;
    }

    const protocol = this.redirect.Protocol || defaults.protocol;
    const hostName = this.redirect.HostName || defaults.hostname;

    return `${protocol}://${hostName}/${redirectKey}`;
  }

  shouldRedirect(key: string, statusCode: number): boolean {
    if (!this.condition) {
      return true;
    }

    if (
      this.condition.KeyPrefixEquals &&
      this.condition.HttpErrorCodeReturnedEquals
    ) {
      return (
        key.startsWith(this.condition.KeyPrefixEquals) &&
        this.condition.HttpErrorCodeReturnedEquals === statusCode
      );
    }

    if (this.condition.KeyPrefixEquals) {
      return key.startsWith(this.condition.KeyPrefixEquals);
    }

    if (this.condition.HttpErrorCodeReturnedEquals) {
      return this.condition.HttpErrorCodeReturnedEquals === statusCode;
    }

    return false;
  }
}

export default RoutingRule;
