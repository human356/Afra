import readline from "node:readline/promises";
import type { LoginIO } from "./login";

/** Terminal prompts; `askSecret` does not echo what is typed (login code, 2FA password). */
export function terminalIO(): LoginIO & { close(): void } {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY) });
  return {
    ask: (q) => rl.question(q),
    askSecret: (q) =>
      new Promise<string>((resolve) => {
        if (!process.stdin.isTTY) return void rl.question(q).then(resolve);
        process.stdout.write(q);
        const stdin = process.stdin;
        let buf = "";
        rl.pause();
        stdin.setRawMode(true);
        stdin.resume();
        stdin.setEncoding("utf8");
        const onData = (chunk: string): void => {
          for (const c of chunk) {
            if (c === "\r" || c === "\n") {
              stdin.setRawMode(false);
              stdin.off("data", onData);
              process.stdout.write("\n");
              rl.resume();
              return resolve(buf);
            }
            if (c === "\u0003") process.exit(130);
            if (c === "\u007f" || c === "\b") buf = buf.slice(0, -1);
            else buf += c;
          }
        };
        stdin.on("data", onData);
      }),
    print: (line) => process.stdout.write(`${line}\n`),
    close: () => rl.close(),
  };
}
