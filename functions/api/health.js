import { json } from "../_lib/http.js";

export async function onRequestGet(context) {
  return json({
    ok: true,
    hasFmpKey: Boolean(context.env.FMP_API_KEY),
    hasSecContactEmail: Boolean(context.env.SEC_CONTACT_EMAIL),
  });
}
