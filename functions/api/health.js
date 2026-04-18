import { json } from "../_lib/http.js";

export async function onRequestGet(context) {
  return json({
    ok: true,
    hasOpenDartKey: Boolean(context.env.OPEN_DART_API_KEY),
    hasAlphaVantageKey: Boolean(context.env.ALPHA_VANTAGE_API_KEY),
    hasSecContactEmail: Boolean(context.env.SEC_CONTACT_EMAIL),
  });
}
