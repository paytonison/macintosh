const MILLISECONDS_PER_MINUTE = 60_000;

export const formatMenuClock = (date: Date): string =>
  date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

export const millisecondsUntilNextMinute = (date: Date): number => {
  const millisecondsIntoMinute = date.getSeconds() * 1_000 + date.getMilliseconds();
  return MILLISECONDS_PER_MINUTE - millisecondsIntoMinute;
};
