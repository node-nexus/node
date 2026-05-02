export function truncate(value, maxLength = 500) {
  const text = String(value ?? "");
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

export function logEvent({ requestId, event, step, status, details = {} }) {
  console.log(
    JSON.stringify({
      time: new Date().toISOString(),
      requestId,
      event,
      step,
      status,
      ...details
    })
  );
}

export function logStep(requestId, step, status, details = {}) {
  logEvent({
    requestId,
    event: "step",
    step,
    status,
    details
  });
}
