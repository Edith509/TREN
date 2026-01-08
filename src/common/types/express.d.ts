declare global {
  namespace Express {
    interface Request {
      userData?: any;
      adminData?: any;
    }
  }
}
export {};
