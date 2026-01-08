declare module "ejs-mate" {
  import { RequestHandler } from "express";
  function engine(path: string, options?: object): RequestHandler;
  export = engine;
}
