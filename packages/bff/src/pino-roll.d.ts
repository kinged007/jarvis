declare module "pino-roll" {
  import type { SonicBoom } from "sonic-boom";

  interface PinoRollLimitOptions {
    count?: number;
    removeOtherLogFiles?: boolean;
  }

  interface PinoRollOptions {
    file: string;
    size?: string | number;
    frequency?: string | number;
    extension?: string;
    symlink?: boolean;
    limit?: PinoRollLimitOptions;
    dateFormat?: string;
    mkdir?: boolean;
    [key: string]: unknown;
  }

  /**
   * Creates a SonicBoom stream that writes to `file` and rolls it
   * automatically when `size` / `frequency` is hit. Used as a pino
   * transport target in `app.ts:buildLogger`.
   */
  function pinoRoll(options: PinoRollOptions): Promise<SonicBoom>;

  export default pinoRoll;
}
