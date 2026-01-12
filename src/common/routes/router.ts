import express from "express";
import adminRouter from "./admin.js";
import miniappRouter from "./miniapp.js";
import sharedRouter from "./shared.js";

const router = express.Router();

router.use(sharedRouter);
router.use(adminRouter);
router.use(miniappRouter);

export default router;
