'use strict';

import { ParameterizedContext } from 'koa';
import { XMLBuilder } from 'fast-xml-parser';
import { isPlainObject } from 'lodash-es';
import he from 'he';

type Context = ParameterizedContext<{}, {}>;
export default () => {
  const builder = new XMLBuilder({
    attributesGroupName: '@',
    tagValueProcessor: (tagName, a) => {
      return he
        .escape(a.toString(), { useNamedReferences: true })
        .replace(/&quot;/g, '"');
    },
  });

  return async <T extends Context>(ctx: T, next) => {
    await next();
    if (isPlainObject(ctx.body)) {
      ctx.type = 'application/xml';
      ctx.body =
        '<?xml version="1.0" encoding="UTF-8"?>\n' + builder.build(ctx.body);
    }
  };
};
