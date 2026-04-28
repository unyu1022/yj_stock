import { badRequest, json, serverError } from "../_lib/http.js";
import { getUsdKrwRate } from "../_lib/fx.js";
import { fillMarketFallbacks } from "../_lib/market-fallback.js";
import {
  buildUSStockFallbackPayload,
  fetchUSStockMetricFallback,
  mergeUSStockMetricFallback,
} from "../_lib/us-stock-fallback.js";
import { getUSEtfData } from "../_lib/us-etf.js";
import { getUSStockData } from "../_lib/us.js";

export async function onRequestGet(context) {
  try {
    const url = new URL(context.request.url);
    const market = (url.searchParams.get("market") || "").toUpperCase();
    const code = (url.searchParams.get("code") || "").trim().toUpperCase();
    const name = (url.searchParams.get("name") || "").trim();
    const assetType = (url.searchParams.get("assetType") || "").trim().toUpperCase();

    if (market && market !== "US") {
      return badRequest("현재는 미국 주식과 ETF만 조회할 수 있습니다.");
    }

    if (!code) {
      return badRequest("code 파라미터가 필요합니다.");
    }

    let payload;
    if (assetType === "ETF") {
      payload = await getUSEtfData(code, context.env, name);
    } else {
      try {
        payload = await getUSStockData(code, context.env, name);
      } catch (error) {
        try {
          const fallback = await fetchUSStockMetricFallback(code, context.env);
          payload = buildUSStockFallbackPayload(code, name, fallback);
        } catch {
          throw error;
        }
      }
    }

    if (payload?.stock?.assetType !== "ETF") {
      const metrics = payload?.stock?.metrics ?? {};
      const needsFallback =
        [metrics.roe, metrics.roic, metrics.operatingMargin, metrics.dividendYield].some((value) => value == null) ||
        !Array.isArray(payload?.history) ||
        payload.history.length === 0;

      if (needsFallback) {
        try {
          const fallback = await fetchUSStockMetricFallback(code, context.env);
          payload = mergeUSStockMetricFallback(payload, fallback);
        } catch {
          // Keep the primary payload when the auxiliary source is unavailable.
        }
      }
    }

    payload = await fillMarketFallbacks(payload, code, context.env);

    const fx = await getUsdKrwRate().catch(() => null);
    return json({ ok: true, ...payload, fx });
  } catch (error) {
    return serverError(error.message);
  }
}
