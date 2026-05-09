import { Router, type IRouter } from "express";
import healthRouter from "./health";
import quoRouter from "./quo";
import attendanceRouter from "./attendance";
import authRouter from "./auth";
import usersRouter from "./users";
import vosRouter from "./vos";
import samiaRouter from "./samia";
import blockedNumbersRouter from "./blockedNumbers";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(usersRouter);
router.use(quoRouter);
router.use(attendanceRouter);
router.use(vosRouter);
router.use(samiaRouter);
router.use(blockedNumbersRouter);

export default router;
