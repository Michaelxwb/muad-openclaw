export function targetFor(senderId, tenantId, conversationId) {
  return (
    "mssw:v1:" +
    Buffer.from(
      JSON.stringify({ senderId, tenantId, conversationId }),
    ).toString("hex")
  );
}

export function decodeTarget(value) {
  const target = String(value).replace(/^mssw:mssw:/, "mssw:");
  if (!/^mssw:v1:[0-9a-f]+$/.test(target)) throw new Error("invalid target");
  const data = JSON.parse(Buffer.from(target.slice(8), "hex").toString());
  if (
    !data.senderId ||
    !data.tenantId ||
    !/^[0-9a-f-]{36}$/.test(data.conversationId)
  )
    throw new Error("invalid target");
  return data;
}

export function validateMessage(body) {
  if (!body || typeof body !== "object" || body.agentId || body.sessionKey)
    throw new Error("invalid message");
  for (const field of ["runId", "conversationId"]) {
    if (typeof body[field] !== "string" || !/^[0-9a-f-]{36}$/.test(body[field]))
      throw new Error("invalid message");
  }
  for (const field of ["senderId", "tenantId", "text"]) {
    if (
      typeof body[field] !== "string" ||
      !body[field].trim() ||
      body[field].length > 12000
    )
      throw new Error("invalid message");
  }
  return body;
}
