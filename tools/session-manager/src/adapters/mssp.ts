import { createInsecureFetch } from "./insecure-fetch.js";
import { MSSWSessionAdapter } from "./mssw.js";

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
}
