/**
 * The WHATWG URL class, as far as packages/core uses it (tenantHost.ts). URL is a global in every runtime core runs in
 * (Node, the Electron main process, browsers) but it is not in lib ES2020, and core deliberately compiles without the
 * DOM and Node type libraries so a rule cannot reach for `document`, `window`, `process` or `Buffer`. Only core's own
 * build sees this file (tsconfig "include"); the apps type-check core's sources with their own DOM / Node types.
 */
declare class URL {
  constructor(url: string, base?: string | URL);
  readonly href: string;
  readonly origin: string;
  readonly protocol: string;
  readonly username: string;
  readonly password: string;
  readonly host: string;
  readonly hostname: string;
  readonly port: string;
  readonly pathname: string;
  readonly search: string;
  readonly hash: string;
}
