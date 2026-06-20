import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
import { requireAuth } from "../middleware/auth.js";

const router: IRouter = Router();

router.get("/healthz", (_req, res) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
});

function cleanSecret(value: string | undefined): string {
  return (value ?? "")
    .trim()
    .replace(/^["']|["']$/g, "")
    .replace(/^Bearer\s+/i, "")
    .trim();
}

router.get("/integrations/status", requireAuth, async (_req, res) => {
  const quoKey = cleanSecret(process.env["QUO_API_KEY"]);
  const vosEmail = cleanSecret(process.env["VOSLOGIC_EMAIL"]);
  const vosPassword = cleanSecret(process.env["VOSLOGIC_PASSWORD"]);

  const status = {
    openPhone: {
      configured: Boolean(quoKey),
      ok: false,
      httpStatus: null as number | null,
      message: "",
    },
    vosLogic: {
      configured: Boolean(vosEmail && vosPassword),
      ok: false,
      httpStatus: null as number | null,
      message: "",
    },
  };

  if (quoKey) {
    try {
      const response = await fetch("https://api.openphone.com/v1/phone-numbers?maxResults=1", {
        headers: { Authorization: quoKey, Accept: "application/json" },
      });
      status.openPhone.httpStatus = response.status;
      status.openPhone.ok = response.ok;
      status.openPhone.message = response.ok
        ? "OpenPhone API key is valid."
        : (await response.text()).slice(0, 240);
    } catch (err) {
      status.openPhone.message = String(err);
    }
  } else {
    status.openPhone.message = "QUO_API_KEY is not set.";
  }

  if (vosEmail && vosPassword) {
    try {
      const response = await fetch("https://phonesystem.voslogic.com/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ email: vosEmail, password: vosPassword }),
      });
      status.vosLogic.httpStatus = response.status;
      status.vosLogic.ok = response.ok;
      status.vosLogic.message = response.ok
        ? "VoSLogic credentials are valid."
        : (await response.text()).slice(0, 240);
    } catch (err) {
      status.vosLogic.message = String(err);
    }
  } else {
    status.vosLogic.message = "VOSLOGIC_EMAIL / VOSLOGIC_PASSWORD are not both set.";
  }

  res.json(status);
});

export default router;
