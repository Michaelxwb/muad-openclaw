// Cumulative trace metrics for one Skill execution.
//
// Every exec is a separate process and writes its own summary line. The guard
// merges those summaries so a later batch (for example a second `python3
// run.py`) cannot overwrite the request/error counts of an earlier batch.

const MAX_TOP_INTERFACES = 50;

export function createTraceMetricsAccumulator() {
  let requestCount = 0;
  let errorCount = 0;
  let maxBurstPer10s = 0;
  let detailTruncated = false;
  let aborted = false;
  let abortReason = "";
  let abortInterface = "";
  let abortCount = null;
  const hosts = new Map();
  const interfaces = new Map();

  function merge(snapshot = {}) {
    if (snapshot.hasSummary !== true &&
        nonNegative(snapshot.requestCount) === 0 &&
        nonNegative(snapshot.errorCount) === 0) {
      return takeSnapshot();
    }
    requestCount += nonNegative(snapshot.requestCount);
    errorCount += nonNegative(snapshot.errorCount);
    maxBurstPer10s = Math.max(maxBurstPer10s, nonNegative(snapshot.maxBurstPer10s));
    detailTruncated = detailTruncated || snapshot.detailTruncated === true;

    const incomingHosts = snapshot.hosts && typeof snapshot.hosts === "object" ? snapshot.hosts : {};
    for (const [host, count] of Object.entries(incomingHosts)) {
      const name = text(host);
      if (!name) continue;
      hosts.set(name, (hosts.get(name) ?? 0) + nonNegative(count));
    }
    if (Object.keys(incomingHosts).length === 0) {
      // Older/failed summaries may only carry topInterfaces; preserve the
      // distinct-host count from the interfaces we did receive.
      for (const item of snapshot.interfaces ?? snapshot.topInterfaces ?? []) {
        const host = text(item?.host);
        if (host) hosts.set(host, hosts.get(host) ?? 1);
      }
    }

    for (const item of snapshot.interfaces ?? snapshot.topInterfaces ?? []) {
      const host = text(item?.host);
      const method = text(item?.method).toUpperCase();
      const itemPath = text(item?.path);
      const count = nonNegative(item?.count);
      if (!host || !method || !itemPath || count === 0) continue;
      const key = JSON.stringify([host, method, itemPath]);
      const current = interfaces.get(key) ?? { host, method, path: itemPath, count: 0 };
      current.count += count;
      interfaces.set(key, current);
    }

    if (snapshot.aborted === true) {
      aborted = true;
      abortReason = text(snapshot.abortReason) || abortReason;
      abortInterface = text(snapshot.abortInterface) || abortInterface;
      const count = integer(snapshot.abortCount);
      if (count !== null) abortCount = count;
    }
    return takeSnapshot();
  }

  function takeSnapshot() {
    const topInterfaces = [...interfaces.values()]
      .sort(compareInterfaces)
      .slice(0, MAX_TOP_INTERFACES);
    return {
      requestCount,
      errorCount,
      distinctHosts: hosts.size,
      maxBurstPer10s,
      topInterfaces,
      detailTruncated,
      aborted,
      abortReason: aborted ? abortReason : "",
      abortInterface: aborted ? abortInterface : "",
      abortCount: aborted ? abortCount : null,
    };
  }

  return { merge, snapshot: takeSnapshot };
}

function compareInterfaces(left, right) {
  if (right.count !== left.count) return right.count - left.count;
  const leftKey = `${left.host}\u0000${left.method}\u0000${left.path}`;
  const rightKey = `${right.host}\u0000${right.method}\u0000${right.path}`;
  return leftKey.localeCompare(rightKey);
}

function nonNegative(value) {
  const parsed = integer(value);
  return parsed !== null && parsed >= 0 ? parsed : 0;
}

function integer(value) {
  return Number.isInteger(value) ? value : null;
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}
