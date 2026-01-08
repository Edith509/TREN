declare module "cookie-parser" {
  import { RequestHandler } from "express";
  function cookieParser(secret?: string, options?: { decode?: (value: string) => string }): RequestHandler;
  export default cookieParser;
}
