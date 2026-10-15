import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

export interface Prompter {
  ask(question: string, defaultValue?: string): Promise<string>;
  confirm(question: string, defaultValue?: boolean): Promise<boolean>;
  choose<T>(question: string, options: Array<{ label: string; value: T; detail?: string }>): Promise<T>;
  close(): void;
}

export function isInteractive(): boolean {
  return Boolean(stdin.isTTY && stdout.isTTY);
}

export function createPrompter(): Prompter {
  const rl = createInterface({ input: stdin, output: stdout });

  return {
    async ask(question, defaultValue) {
      const suffix = defaultValue ? ` [${defaultValue}]` : "";
      const answer = (await rl.question(`${question}${suffix}: `)).trim();
      return answer === "" ? (defaultValue ?? "") : answer;
    },
    async confirm(question, defaultValue = true) {
      const hint = defaultValue ? "Y/n" : "y/N";
      const answer = (await rl.question(`${question} [${hint}]: `)).trim().toLowerCase();
      if (answer === "") return defaultValue;
      return answer === "y" || answer === "yes";
    },
    async choose(question, options) {
      stdout.write(`${question}\n`);
      options.forEach((option, index) => {
        stdout.write(`  ${index + 1}) ${option.label}\n`);
        if (option.detail) stdout.write(`      ${option.detail}\n`);
      });
      for (;;) {
        const answer = (await rl.question(`Select 1-${options.length} [1]: `)).trim();
        if (answer === "") return options[0]!.value;
        const index = Number(answer);
        if (Number.isInteger(index) && index >= 1 && index <= options.length) {
          return options[index - 1]!.value;
        }
        stdout.write(`  Please enter a number between 1 and ${options.length}.\n`);
      }
    },
    close() {
      rl.close();
    },
  };
}
