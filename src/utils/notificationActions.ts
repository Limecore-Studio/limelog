// v1.21 (LimeLog#116): the reminder's "Start" action id, on its own so the
// launch-time tap listener (App.tsx) can compare against it without pulling
// the whole notifications module into the startup bundle.
export const WORKOUT_ACTION_START = 'start';
