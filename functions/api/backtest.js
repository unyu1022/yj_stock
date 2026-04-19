import { badRequest, json, serverError } from "../_lib/http.js";
import { getUSBacktestData } from "../_lib/us.js";

export async function onRequestGet(context) {
  try {
    const url = new URL(context.request.url);
    const code = (url.searchParams.get("code") || "").trim().toUpperCase();
    const years = Number(url.searchParams.get("years") || "0");
    const months = Number(url.searchParams.get("months") || "0");
    const strategy = (url.searchParams.get("strategy") || "trend").trim().toLowerCase();

    if (!code) {
      return badRequest("code 파라미터가 필요합니다.");
    }

    if (!Number.isFinite(years) || years < 0 || !Number.isFinite(months) || months < 0) {
      return badRequest("years, months 파라미터는 0 이상의 숫자여야 합니다.");
    }

    const payload = await getUSBacktestData(code, context.env, years, months, strategy);
    return json({ ok: true, ...payload });
  } catch (error) {
    return serverError(error.message);
  }
}
