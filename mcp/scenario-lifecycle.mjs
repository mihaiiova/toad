/** One owned attempt. Adapters use existing sandbox commands/evidence, never host hooks. */
export async function runScenarioLifecycle(plan, adapters) {
  const { signal, before = [], after = [], timeoutSeconds = 120, cleanupTimeoutSeconds = 30 } = plan;
  const main = new AbortController();
  const cancel = () => main.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) main.abort();
  const timer = setTimeout(cancel, timeoutSeconds * 1000);
  let context, product, productStarted = false, executionError = false, preparationError = false, cleanupError = false, evidenceError = false;
  try {
    if (!main.signal.aborted) context = await adapters.prepare(main.signal);
    if (!context) preparationError = true;
    else {
      for (const [index, command] of before.entries()) {
        if (main.signal.aborted || !await adapters.command(context, 'before', command, index, main.signal)) { preparationError = true; break; }
      }
      if (!preparationError && !main.signal.aborted) { productStarted = true; product = await adapters.product(context, main.signal); }
    }
  } catch { if (productStarted) executionError = true; else preparationError = true; }
  finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
    // Required product failure facts/diagnostics must be durable before destructive cleanup.
    if (context) {
      try { await adapters.capture(context, product); } catch { evidenceError = true; }
      const cleanup = new AbortController();
      const deadline = setTimeout(() => cleanup.abort(), cleanupTimeoutSeconds * 1000);
      try {
        for (const [index, command] of after.entries()) {
          if (cleanup.signal.aborted) { cleanupError = true; break; }
          try { if (!await adapters.command(context, 'after', command, index, cleanup.signal)) cleanupError = true; }
          catch { cleanupError = true; }
        }
      } finally {
        clearTimeout(deadline);
        if (cleanup.signal.aborted) cleanupError = true;
        try { await adapters.close(context, { retain: evidenceError }); } catch { cleanupError = true; }
      }
    } else cleanupError = true; // No owned sandbox: never improvise host cleanup.
  }
  return { product, executionError, preparationError, cleanupError, evidenceError, cancelled: main.signal.aborted, cleanupUnavailable: !context };
}
