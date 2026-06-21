// Minimal logging facade standing in for Elixir's `Logger`. Methods are kept on
// an object so tests can `spyOn(logger, "error")`. The OTP disk_log handler has
// no Bun equivalent (see log-file.ts); these write to the console streams.

export const logger = {
  error(message: string): void {
    console.error(message);
  },
  warning(message: string): void {
    console.warn(message);
  },
  info(message: string): void {
    console.info(message);
  },
  debug(message: string): void {
    console.debug(message);
  },
};
