import { Router, type IRouter } from "express";
import healthRouter from "./health";
import quoRouter from "./quo";

const router: IRouter = Router();

router.use(healthRouter);
router.use(quoRouter);

export default router;
