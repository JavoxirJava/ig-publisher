type Sink = (line: string) => void;

// stderr by default so CLI stdout stays clean for --json output; the MCP server swaps in its own sink.
let sink: Sink = (line) => process.stderr.write(line + '\n');
let quiet = false;

export function setLogSink(next: Sink): void {
  sink = next;
}

export function setQuiet(value: boolean): void {
  quiet = value;
}

export function log(message: string): void {
  if (!quiet) sink(`[ig] ${message}`);
}

/** Hide anything that looks like a token or secret before it reaches logs or error messages. */
export function redact(text: string): string {
  return text
    .replace(/(access_token|client_secret|code)=([^&\s"']+)/gi, '$1=***')
    .replace(/(OAuth|Bearer)\s+[A-Za-z0-9._-]{20,}/g, '$1 ***')
    .replace(/\bIG[A-Za-z0-9_-]{40,}/g, 'IG***');
}
