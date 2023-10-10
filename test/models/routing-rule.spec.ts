'use strict';

import { describe, test } from '@jest/globals';
import { expect } from 'chai';
import RoutingRule from '../../lib/models/routing-rule';

describe('RoutingRule', () => {
  describe('Condition', () => {
    const matchingKey = 'prefix/key';
    const nonMatchKey = 'without-prefix/key';
    const matchingStatusCode = 404;
    const nonMatchStatusCode = 200;

    test('redirects with no condition', () => {
      const rule = new RoutingRule({});

      expect(rule.shouldRedirect('key', 200)).to.exist;
    });

    test('redirects using only KeyPrefixEquals', () => {
      const rule = new RoutingRule({
        Condition: {
          KeyPrefixEquals: 'prefix',
        },
      });

      expect(rule.shouldRedirect(matchingKey, 200)).to.be.true;
      expect(rule.shouldRedirect(nonMatchKey, 200)).to.be.false;
    });

    test('redirects using only HttpErrorCodeReturnedEquals', () => {
      const rule = new RoutingRule({
        Condition: {
          HttpErrorCodeReturnedEquals: 404,
        },
      });

      expect(rule.shouldRedirect('key', matchingStatusCode)).to.be.true;
      expect(rule.shouldRedirect('key', nonMatchStatusCode)).to.be.false;
    });

    test('redirects using both KeyPrefixEquals and HttpErrorCodeReturnedEquals', () => {
      const rule = new RoutingRule({
        Condition: {
          KeyPrefixEquals: 'prefix',
          HttpErrorCodeReturnedEquals: 404,
        },
      });

      expect(rule.shouldRedirect(matchingKey, matchingStatusCode)).to.be.true;
      expect(rule.shouldRedirect(nonMatchKey, matchingStatusCode)).to.be.false;
      expect(rule.shouldRedirect(matchingKey, nonMatchStatusCode)).to.be.false;
      expect(rule.shouldRedirect(nonMatchKey, nonMatchStatusCode)).to.be.false;
    });
  });

  describe('Redirect', () => {
    const defaults = {
      protocol: 'https',
      hostname: 'example.com',
    };

    test('redirects using only HostName', () => {
      const rule = new RoutingRule({
        Redirect: {
          HostName: 'localhost',
        },
      });

      expect(rule.statusCode).to.equal(301);
      expect(rule.getRedirectLocation('key', defaults)).to.equal(
        'https://localhost/key',
      );
    });

    test('redirects using only HttpRedirectCode', () => {
      const rule = new RoutingRule({
        Redirect: {
          HttpRedirectCode: 307,
        },
      });

      expect(rule.statusCode).to.equal(307);
      expect(rule.getRedirectLocation('key', defaults)).to.equal(
        'https://example.com/key',
      );
    });

    test('redirects using only Protocol', () => {
      const rule = new RoutingRule({
        Redirect: {
          Protocol: 'http',
        },
      });

      expect(rule.statusCode).to.equal(301);
      expect(rule.getRedirectLocation('key', defaults)).to.equal(
        'http://example.com/key',
      );
    });

    test('redirects using only ReplaceKeyPrefixWith', () => {
      const rule = new RoutingRule({
        Condition: {
          KeyPrefixEquals: 'prefix',
        },
        Redirect: {
          ReplaceKeyPrefixWith: 'replacement',
        },
      });

      expect(rule.statusCode).to.equal(301);
      expect(rule.getRedirectLocation('prefix/key', defaults)).to.equal(
        'https://example.com/replacement/key',
      );
    });

    test('replaces blank prefix with ReplaceKeyPrefixWith', () => {
      const rule = new RoutingRule({
        Redirect: {
          ReplaceKeyPrefixWith: 'replacement/',
        },
      });

      expect(rule.statusCode).to.equal(301);
      expect(rule.getRedirectLocation('prefix/key', defaults)).to.equal(
        'https://example.com/replacement/prefix/key',
      );
    });

    test('redirects using only ReplaceKeyWith', () => {
      const rule = new RoutingRule({
        Redirect: {
          ReplaceKeyWith: 'replacement',
        },
      });

      expect(rule.statusCode).to.equal(301);
      expect(rule.getRedirectLocation('key', defaults)).to.equal(
        'https://example.com/replacement',
      );
    });

    test('redirects using a combination of options', () => {
      const rule = new RoutingRule({
        Condition: {
          KeyPrefixEquals: 'prefix',
        },
        Redirect: {
          Protocol: 'http',
          HttpRedirectCode: 307,
          HostName: 'localhost',
          ReplaceKeyPrefixWith: 'replacement',
        },
      });

      expect(rule.statusCode).to.equal(307);
      expect(rule.getRedirectLocation('prefix/key', defaults)).to.equal(
        'http://localhost/replacement/key',
      );
    });
  });
});
