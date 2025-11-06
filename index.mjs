import handlerModule from './src/handler.js';

const handler = handlerModule.handler;

if (typeof handler !== 'function') {
  throw new Error('Expected src/handler.js to export a handler function');
}

export { handler };
export default handler;
