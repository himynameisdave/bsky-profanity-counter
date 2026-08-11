import { createLogger } from 'loggit';

export const info = createLogger('info', {
  taskColor: 'bgCyanBright',
});

export const success = createLogger('success', {
  taskColor: 'bgGreenBright',
});

export const error = createLogger('error', {
  taskColor: 'bgRedBright',
});

export const warn = createLogger('warn', {
  taskColor: 'bgYellowBright',
});
