import { Dixous, defineExtension } from '../../dist/index.js';

export const client = Dixous.create({
  baseUrl: 'https://shared.example/api/',
  headers: { authorization: 'shared' },
  label: 'shared',
  extensions: [defineExtension({
    async request(context, next) {
      context.request.headers.set('x-label', context.options.label);
      return next();
    },
    operation: context => ({ label: () => context.options.label }),
  })],
  fetch: async request => Response.json({ url: request.url, headers: [...request.headers] }),
});
