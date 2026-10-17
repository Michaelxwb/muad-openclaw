import { createInsecureFetch } from "./insecure-fetch.js";
import { MSSWSessionAdapter } from "./mssw.js";
import { headerValue, optionalString, stringMap } from "./request-profile.js";

// mssp 的登录逻辑与 mssw 完全一致（Sangfor SigV4 风格 AK/SK 签名），只是平台名与
// X-Branch-Tag 不同。复用 MSSWSessionAdapter 全部实现：基类构造器以默认参数实例化
// 私有 #fetch/#now/#branchTag，继承的 refresh/validate/#fetchCSRFToken/#buildHeaders
// 均按 mssp 身份工作。
export class MSSPSessionAdapter extends MSSWSessionAdapter {
  constructor(
    fetchLike = createInsecureFetch(),
    now = () => Math.floor(Date.now() / 1000),
    log: (message: string) => void = () => {},
  ) {
    super(fetchLike, now, "mssp", "MSSP-ADAPTER", log);
  }

  // mssp keeps the shared CSRF mapping but adds its own fixed headers, whose
  // values come from the platform credential JSON rather than code constants.
  protected override profileStaticHeaders(credentials: Record<string, unknown>): Record<string, string> {
    const staticHeaders = stringMap(credentials.staticHeaders);
    const csrfToken = optionalString(credentials.csrfToken);
    if (csrfToken && !headerValue(staticHeaders, "X-CSRFToken")) {
      staticHeaders["X-CSRFToken"] = csrfToken;
    }
    const timezone = optionalString(credentials.timezone);
    if (timezone && !headerValue(staticHeaders, "timezone")) {
      staticHeaders.timezone = timezone;
    }
    const missing: string[] = [];
    if (!headerValue(staticHeaders, "X-CSRFToken")) missing.push("staticHeaders.X-CSRFToken");
    if (!headerValue(staticHeaders, "timezone")) missing.push("staticHeaders.timezone");
    this.logProfileFallback(missing);
    return staticHeaders;
  }
}
