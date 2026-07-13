// Decode JSON string escapes (\n \t \" \\ …) into real chars in ONE pass so
// each \X is consumed exactly once — chaining .replace() per escape type
// re-scans its own output and double-processes backslashes. Shared by the
// ambient TurnTracePanel and the eval FormattedModal: both render an assembled
// prompt that arrives with its escapes still literal.
export function decodeEscapes(text: string): string {
  return text.replace(/\\(["\\/bfnrt])/g, (_, c) => {
    const map: Record<string, string> = {
      '"': '"',
      "\\": "\\",
      "/": "/",
      b: "\b",
      f: "\f",
      n: "\n",
      r: "\r",
      t: "\t",
    };
    return map[c];
  });
}
