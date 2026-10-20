export function startScheduler(desk, { intervalMs = 30_000 } = {}) {
  const timer = setInterval(() => {
    desk.tick().catch((error) => console.error(error));
  }, intervalMs);

  desk.tick().catch((error) => console.error(error));

  return () => clearInterval(timer);
}
