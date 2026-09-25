import Module from 'module';

/**
 * Node options that install module customization hooks in a child process.
 * `hooksUrl` is a module (file: or data: URL) exporting async resolve()
 * and/or load(). Node 18.19+ and 20.6+ take it through module.register(),
 * from an --import preload; Node that has --import but no module.register()
 * (18.18, 19, 20.0-20.5) takes it only as --experimental-loader. Decided for
 * the Node running this: a child started with process.execPath runs the same.
 */
export function hookArgs(hooksUrl) {
  if (Module.register) {
    const preload = `import { register } from 'node:module'; register(${JSON.stringify(hooksUrl)});`;
    return ['--import', `data:text/javascript,${encodeURIComponent(preload)}`];
  }
  return ['--experimental-loader', hooksUrl];
}
